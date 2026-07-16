import 'server-only';
import { logger } from '@/lib/logger';

/**
 * Thin client for POST /api/inbox/ingest. The endpoint authenticates
 * via Bearer INBOX_INGEST_SECRET; this helper supplies that header so
 * jobs don't each have to remember to.
 *
 * Why HTTP and not a direct DB insert: the endpoint already encodes
 * org-resolution, contact-matching, idempotency, and validation rules.
 * Calling it (even in-process) keeps a single chokepoint for the
 * lifecycle / triage logic of inbox_messages. If we ever move the
 * ingester to a separate service this code doesn't change.
 */

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

export interface IngestPayload {
	userId: string;
	organizationId?: string;
	source: 'email' | 'sms' | 'other';
	fromAddress: string;
	fromName?: string;
	subject?: string;
	body: string;
	bodyHtml?: string;
	receivedAt?: string;
	externalId?: string;
	threadId?: string;
	contactId?: string;
}

export interface IngestResult {
	ok: boolean;
	id?: string;
	duplicate?: boolean;
	error?: string;
	status: number;
}

export async function postToIngest(payload: IngestPayload): Promise<IngestResult> {
	const secret = process.env.INBOX_INGEST_SECRET;
	if (!secret) {
		// Fail loud — every caller should treat "no secret" as a config
		// error, not "silently drop messages on the floor".
		throw new Error('INBOX_INGEST_SECRET is not configured');
	}
	const url = `${BASE.replace(/\/$/, '')}/api/inbox/ingest`;

	let res: Response;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${secret}`,
			},
			body: JSON.stringify(payload),
			// Don't let a stuck connection hold the whole poll cycle hostage.
			signal: AbortSignal.timeout(15_000),
		});
	} catch (err) {
		// Network-level failure (timeout, ECONNREFUSED, DNS, etc.). Return
		// a usable error string instead of letting the throw propagate;
		// the caller treats this as ingest_failed and halts the cycle.
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn({ url, err: msg, externalId: payload.externalId }, 'ingest fetch threw');
		return { ok: false, error: `fetch failed: ${msg}`, status: 0 };
	}

	// Read the body as text first so we can include it in error reports
	// when JSON parse fails (HTML error page, empty body, etc.). Cheap —
	// only useful when something is wrong.
	const rawText = await res.text().catch(() => '');
	let parsed: unknown = null;
	if (rawText) {
		try {
			parsed = JSON.parse(rawText);
		} catch {
			// Will surface as a detail below.
		}
	}

	if (!res.ok) {
		const detail =
			parsed && typeof parsed === 'object' && 'error' in parsed
				? String((parsed as { error: unknown }).error)
				: `HTTP ${res.status}: ${truncate(rawText, 200) || '(empty body)'}`;
		logger.warn({ url, status: res.status, detail, externalId: payload.externalId }, 'ingest post failed');
		return { ok: false, error: detail, status: res.status };
	}

	// 2xx but the body isn't a recognized JSON envelope. Most common
	// cause: a Next.js error page, an unrelated route matching, or a
	// middleware redirect returning HTML. Surface the body snippet so
	// the operator can tell what they actually got back.
	if (!parsed || typeof parsed !== 'object' || (parsed as { ok?: unknown }).ok !== true) {
		const snippet = truncate(rawText, 200) || '(empty body)';
		logger.warn(
			{ url, status: res.status, snippet, externalId: payload.externalId },
			'ingest returned 2xx with unrecognized body',
		);
		return {
			ok: false,
			error: `HTTP ${res.status} but response wasn't { ok: true }. Body: ${snippet}`,
			status: res.status,
		};
	}

	const duplicate = (parsed as { duplicate?: boolean }).duplicate === true;
	const id = (parsed as { id?: string }).id;
	return { ok: true, id, duplicate, status: res.status };
}

function truncate(s: string, n: number): string {
	if (!s) return '';
	const oneLine = s.replace(/\s+/g, ' ').trim();
	return oneLine.length <= n ? oneLine : oneLine.slice(0, n - 1) + '…';
}
