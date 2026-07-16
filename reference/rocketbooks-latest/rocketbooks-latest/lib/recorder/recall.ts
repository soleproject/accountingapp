import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Thin Recall.ai wrapper for the Organizer meeting-bot capture source
 * (Recorder Phase 2a). Recall runs a bot that joins a Zoom / Teams / Meet
 * call, records it, and notifies us via webhook when it's done. We then
 * pull the recording media URL and feed it through the existing Deepgram
 * pipeline — we do NOT use Recall's own transcription (keeps us on one
 * STT vendor and off their $0.15/h add-on).
 *
 * Cost note: bot recording is ~$0.50/recording-hour as of 2026-05
 * (+ ~$0.05/h storage after 7 free days). This is the paid path — it's
 * gated behind the recorder feature flag and is opt-in per dispatch.
 *
 * Env:
 *   RECALL_API_KEY        — required. Region-scoped API token.
 *   RECALL_API_BASE       — optional. Defaults to https://us-east-1.recall.ai
 *                           (Recall is region-pinned; set this to match the
 *                           region your API key belongs to).
 *   RECALL_BOT_NAME       — optional. In-meeting display name; defaults to
 *                           "Rocketbooks Notetaker". This IS the in-meeting
 *                           recording disclosure, so keep it self-describing.
 *   RECALL_WEBHOOK_SECRET — required for webhook verification (Svix secret,
 *                           "whsec_..."). Without it the webhook rejects.
 */

const DEFAULT_BASE = 'https://us-east-1.recall.ai';
const DEFAULT_BOT_NAME = 'Rocketbooks Notetaker';

export type MeetingPlatform = 'zoom' | 'teams' | 'meet';

function base(): string {
	return (process.env.RECALL_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
}

function apiKey(): string {
	const k = process.env.RECALL_API_KEY;
	if (!k) throw new Error('RECALL_API_KEY is required');
	return k;
}

/**
 * Map a meeting join URL to a platform. Returns null for URLs we don't
 * recognise so the caller can reject before spending a bot-hour.
 */
export function detectPlatform(meetingUrl: string): MeetingPlatform | null {
	let host: string;
	try {
		host = new URL(meetingUrl).hostname.toLowerCase();
	} catch {
		return null;
	}
	if (host.endsWith('zoom.us') || host.endsWith('zoom.com')) return 'zoom';
	if (host.endsWith('teams.microsoft.com') || host.endsWith('teams.live.com')) return 'teams';
	if (host === 'meet.google.com') return 'meet';
	return null;
}

export interface CreateBotResult {
	botId: string;
}

/**
 * Ask Recall to send a bot into a meeting. We disable Recall-side
 * transcription and request a mixed audio recording we can hand to
 * Deepgram. Returns the bot id we store for webhook correlation.
 */
export async function createBot(meetingUrl: string, opts: { botName?: string } = {}): Promise<CreateBotResult> {
	const res = await fetch(`${base()}/api/v1/bot`, {
		method: 'POST',
		headers: {
			Authorization: `Token ${apiKey()}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			meeting_url: meetingUrl,
			bot_name: opts.botName || process.env.RECALL_BOT_NAME || DEFAULT_BOT_NAME,
			recording_config: {
				// Mixed audio MP3 only — no video. That's all Deepgram needs,
				// and it avoids recording/storing/transferring video. The
				// download URL lands at media_shortcuts.audio_mixed.data.download_url
				// (see pluckMediaUrl). NOTE: passing recording_config WITHOUT a
				// video key is what disables Recall's default mixed-video capture.
				audio_mixed_mp3: {},
				// Don't let Recall keep recordings forever (the default for
				// accounts created after 2025-06-12). We pull the media in the
				// webhook and transcribe immediately; 24h is a buffer for webhook
				// retries. Tunable — a later phase can surface this in /settings.
				retention: { type: 'timed', hours: 24 },
			},
			// Auto-leave so a forgotten bot never bills $0.50/hr recording an
			// empty room. Values are seconds. These are sensible defaults; a
			// later phase can surface them as /settings controls per the
			// "expose AI config in UI" rule. (Field shapes can vary by Recall
			// API version — adjust here if the API rejects them.)
			automatic_leave: {
				noone_joined_timeout: 300, // bot joined but no one else showed → leave after 5 min
				everyone_left_timeout: 60, // everyone else left → leave after 1 min
				waiting_room_timeout: 600, // stuck in waiting room → give up after 10 min
				in_call_not_recording_timeout: 300, // in call but not recording → leave after 5 min
			},
		}),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '<unreadable>');
		throw new Error(`Recall createBot ${res.status}: ${body.slice(0, 500)}`);
	}
	const json = (await res.json()) as { id?: string };
	if (!json.id) throw new Error('Recall createBot returned no bot id');
	return { botId: json.id };
}

export interface RecallBot {
	id: string;
	statusCode: string | null;
	mediaUrl: string | null;
	raw: unknown;
}

/**
 * Fetch a bot's current state and best-effort extract a downloadable media
 * URL. Recall's response shape varies by API version / dashboard config, so
 * the extraction is tolerant: adjust `pluckMediaUrl` against your account's
 * actual payload if the URL doesn't surface.
 */
export async function getBot(botId: string): Promise<RecallBot> {
	const res = await fetch(`${base()}/api/v1/bot/${botId}`, {
		headers: { Authorization: `Token ${apiKey()}` },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '<unreadable>');
		throw new Error(`Recall getBot ${res.status}: ${body.slice(0, 500)}`);
	}
	const raw = (await res.json()) as Record<string, unknown>;
	return {
		id: botId,
		statusCode: pluckStatusCode(raw),
		mediaUrl: pluckMediaUrl(raw),
		raw,
	};
}

function pluckStatusCode(raw: Record<string, unknown>): string | null {
	const status = raw.status_changes;
	if (Array.isArray(status) && status.length > 0) {
		const last = status[status.length - 1] as { code?: string };
		if (last?.code) return last.code;
	}
	const flat = raw.status as { code?: string } | undefined;
	return flat?.code ?? null;
}

/**
 * Tolerant media-URL extraction. Tries the common Recall shapes:
 *  - recordings[].media_shortcuts.audio_mixed.data.download_url
 *  - recordings[].media_shortcuts.video_mixed.data.download_url
 *  - top-level video_url (legacy)
 */
function pluckMediaUrl(raw: Record<string, unknown>): string | null {
	const recordings = raw.recordings;
	if (Array.isArray(recordings)) {
		for (const rec of recordings) {
			const shortcuts = (rec as { media_shortcuts?: Record<string, unknown> })?.media_shortcuts;
			for (const key of ['audio_mixed', 'video_mixed']) {
				const node = shortcuts?.[key] as { data?: { download_url?: string } } | undefined;
				if (node?.data?.download_url) return node.data.download_url;
			}
		}
	}
	const legacy = raw.video_url;
	return typeof legacy === 'string' ? legacy : null;
}

/** Webhook status codes that mean "recording finished, media available". */
export function isTerminalDone(code: string | null | undefined): boolean {
	return code === 'done' || code === 'call_ended' || code === 'recording_done';
}

/** Webhook status codes that mean the bot failed and won't produce media. */
export function isTerminalFatal(code: string | null | undefined): boolean {
	return code === 'fatal' || code === 'error' || code === 'failed';
}

export interface RecallWebhookEvent {
	botId: string | null;
	statusCode: string | null;
	raw: Record<string, unknown>;
}

/**
 * Pull bot id + a normalized status code out of a webhook body across the
 * two shapes Recall emits:
 *   1. `bot.status_change` — code lives in `data.status.code`
 *      ('joining_call' | 'in_call_recording' | 'call_ended' | 'done' | 'fatal').
 *   2. Granular events — the code IS the event-name tail, e.g.
 *      'bot.done' → 'done', 'bot.call_ended' → 'call_ended',
 *      'bot.fatal'/'bot.failed' → 'fatal'/'failed'.
 * We read both so subscription style doesn't matter.
 */
export function parseWebhookEvent(raw: Record<string, unknown>): RecallWebhookEvent {
	const data = (raw.data ?? {}) as Record<string, unknown>;
	const botFromData = (data.bot as { id?: string } | undefined)?.id;
	const botId = (data.bot_id as string) ?? botFromData ?? (raw.bot_id as string) ?? null;

	const statusNode = (data.status as { code?: string } | undefined) ?? (raw.status as { code?: string } | undefined);
	let statusCode = statusNode?.code ?? null;

	if (!statusCode) {
		const evt = typeof raw.event === 'string' ? raw.event : '';
		// 'bot.done' → 'done'; ignore the 'status_change' container event.
		const tail = evt.includes('.') ? evt.slice(evt.indexOf('.') + 1) : evt;
		if (tail && tail !== 'status_change') statusCode = tail;
	}

	return { botId, statusCode, raw };
}

/**
 * Verify a Recall (Svix) webhook signature. Dependency-free implementation
 * of the Svix scheme: HMAC-SHA256 over `${id}.${timestamp}.${body}` keyed by
 * the base64 secret (after the "whsec_" prefix), compared base64.
 *
 * `signatureHeader` is the raw `svix-signature` value, a space-delimited
 * list of `v1,<sig>` entries — any match passes.
 */
export function verifyWebhook(args: {
	id: string | null;
	timestamp: string | null;
	signatureHeader: string | null;
	body: string;
}): boolean {
	const secret = process.env.RECALL_WEBHOOK_SECRET;
	if (!secret) throw new Error('RECALL_WEBHOOK_SECRET is required to verify webhooks');
	const { id, timestamp, signatureHeader, body } = args;
	if (!id || !timestamp || !signatureHeader) return false;

	const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
	const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
	const expectedBuf = Buffer.from(expected);

	for (const part of signatureHeader.split(' ')) {
		const sig = part.includes(',') ? part.split(',')[1] : part;
		const sigBuf = Buffer.from(sig);
		if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) return true;
	}
	return false;
}
