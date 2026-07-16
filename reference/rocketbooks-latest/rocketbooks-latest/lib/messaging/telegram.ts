import 'server-only';
import { timingSafeEqual } from 'crypto';
import { logger } from '@/lib/logger';

/**
 * Telegram Bot API client for the SHARED Rocketbooks bot. Env-guarded like
 * lib/sms/twilio.ts — when TELEGRAM_BOT_TOKEN is missing every call is a quiet
 * no-op so the feature degrades cleanly (and can ship before the bot exists).
 *
 * One bot serves all orgs; messages are attributed to an org via the invite
 * token in the /start deep link (see telegram_connections). Inbound webhooks are
 * authenticated with the secret token Telegram echoes in a header — no crypto.
 *
 * Bot API surface we need is small and stable (sendMessage, getMe, setWebhook),
 * so a raw fetch beats a full SDK dep.
 */

const API = 'https://api.telegram.org';

export function isTelegramConfigured(): boolean {
	return !!process.env.TELEGRAM_BOT_TOKEN;
}

function token(): string {
	return process.env.TELEGRAM_BOT_TOKEN ?? '';
}

export interface TgSendResult {
	sent: boolean;
	id?: string;
	error?: string;
}

/** Send a text message to a Telegram chat_id (private or group). */
export async function sendTelegramMessage(chatId: string, text: string): Promise<TgSendResult> {
	if (!isTelegramConfigured()) return { sent: false, error: 'Telegram bot not configured' };
	try {
		const res = await fetch(`${API}/bot${token()}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
		});
		const data = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
		if (!data.ok) return { sent: false, error: data.description ?? `telegram ${res.status}` };
		return { sent: true, id: String(data.result?.message_id ?? '') };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn({ err: msg }, 'telegram sendMessage failed');
		return { sent: false, error: msg };
	}
}

/** Constant-time check of the X-Telegram-Bot-Api-Secret-Token header Telegram
 *  echoes back (set at setWebhook time). Rejects inbound requests that don't
 *  carry our secret. When no secret is configured, allow (dev). */
export function verifyTelegramSecret(req: Request): boolean {
	const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
	if (!expected) return true;
	const got = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
	const a = Buffer.from(got);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

let cachedBotUsername: string | null = null;

/** The bot's @username (for building t.me/<bot>?start= links). Cached per process. */
export async function getBotUsername(): Promise<string | null> {
	if (!isTelegramConfigured()) return null;
	if (cachedBotUsername) return cachedBotUsername;
	try {
		const res = await fetch(`${API}/bot${token()}/getMe`);
		const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
		cachedBotUsername = data.ok ? data.result?.username ?? null : null;
		return cachedBotUsername;
	} catch {
		return null;
	}
}

/** One-time setup helper: point the bot's webhook at our inbound route with the
 *  shared secret. Called from a script/route during provisioning, not per-request. */
export async function setTelegramWebhook(url: string, secret: string): Promise<boolean> {
	if (!isTelegramConfigured()) return false;
	const res = await fetch(`${API}/bot${token()}/setWebhook`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message'] }),
	});
	const data = (await res.json()) as { ok: boolean };
	return data.ok;
}
