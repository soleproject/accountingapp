import 'server-only';
import { createHmac, timingSafeEqual } from 'crypto';
import { logger } from '@/lib/logger';
import { recordServiceUsage, type UsageCtx } from '@/lib/ai/usage';

/**
 * Transactional SMS via Twilio. Env-guarded — when any of
 * TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER is
 * missing, every send is a quiet no-op so the feature degrades
 * cleanly. Mirrors lib/email/resend.ts so new envs / dev without
 * the keys still work end-to-end; SMS steps just don't happen.
 *
 * Uses fetch against Twilio's REST API directly — the surface we
 * need (POST /Messages.json + StatusCallback signature) is small
 * and stable, so a full SDK dep buys nothing here.
 */

export function isTwilioConfigured(): boolean {
	return !!(
		process.env.TWILIO_ACCOUNT_SID &&
		process.env.TWILIO_AUTH_TOKEN &&
		process.env.TWILIO_FROM_NUMBER
	);
}

export interface SendSmsArgs {
	to: string;
	body: string;
	/** Public HTTPS URL Twilio will POST delivery-status updates to.
	 *  Omit for local dev where Twilio can't reach the host — the
	 *  send still works, status just won't advance past 'sent'. */
	statusCallback?: string;
	/** Optional cost-tracking context. When supplied, a successful send logs
	 *  one usage event (priced per segment) to the unified ledger. */
	usage?: UsageCtx;
}

export interface SendSmsResult {
	sent: boolean;
	id?: string;
	/** Twilio bills per segment (1 segment = 160 GSM-7 chars or 70 UCS-2);
	 *  long messages are split. Surfaced for cost auditing. */
	segments?: number;
	/** Phone number Twilio used as the sender (echoed back). */
	from?: string;
	error?: string;
	/** True when no send was attempted because Twilio env isn't
	 *  configured — distinct from a real failure. */
	skipped?: boolean;
}

interface TwilioMessageResponse {
	sid?: string;
	num_segments?: string;
	from?: string;
	status?: string;
	code?: number;
	message?: string;
}

/**
 * Fire-and-forget SMS send. Wrapped in try/catch so a Twilio outage
 * or quota error never propagates into a caller's flow. Callers that
 * care about outcome can branch on `.sent`.
 */
export async function sendTransactionalSms(args: SendSmsArgs): Promise<SendSmsResult> {
	const sid = process.env.TWILIO_ACCOUNT_SID;
	const token = process.env.TWILIO_AUTH_TOKEN;
	const from = process.env.TWILIO_FROM_NUMBER;

	if (!sid || !token || !from) {
		logger.debug({ to: args.to }, 'twilio skipped — env not configured');
		return { sent: false, skipped: true };
	}

	const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
	const auth = Buffer.from(`${sid}:${token}`).toString('base64');
	const params: Record<string, string> = { From: from, To: args.to, Body: args.body };
	if (args.statusCallback) params.StatusCallback = args.statusCallback;
	const form = new URLSearchParams(params);

	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Basic ${auth}`,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: form.toString(),
		});
		const data = (await res.json().catch(() => ({}))) as TwilioMessageResponse;
		if (!res.ok || !data.sid) {
			const msg = data.message ?? `twilio http ${res.status}`;
			logger.warn({ to: args.to, err: msg, code: data.code }, 'twilio send failed');
			return { sent: false, error: msg };
		}
		const segments = data.num_segments ? Number(data.num_segments) : undefined;
		if (args.usage) {
			recordServiceUsage(args.usage, {
				provider: 'twilio',
				category: 'sms',
				unit: 'segments',
				quantity: segments ?? 1,
				rateKey: 'twilio:segment',
				model: 'sms',
			});
		}
		return { sent: true, id: data.sid, segments, from: data.from };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn({ to: args.to, err: msg }, 'twilio send threw');
		return { sent: false, error: msg };
	}
}

/**
 * Verify an X-Twilio-Signature header on an inbound webhook.
 *
 * Twilio signs: HMAC-SHA1(AUTH_TOKEN, url + concat(sorted_params))
 * where sorted_params is the form body's keys sorted alphabetically
 * and concatenated as key+value (no separators), base64-encoded.
 *
 * `url` must exactly match what Twilio called — including query
 * string and any trailing slash. We let the caller pass it in
 * rather than deriving from headers (X-Forwarded-* is unreliable
 * behind some proxies) since we set the StatusCallback ourselves
 * and know what URL we asked Twilio to hit.
 *
 * Returns false (not throws) on missing token / header so the
 * caller can return 401 without leaking which check failed.
 *
 * Docs: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function verifyTwilioSignature(
	url: string,
	params: Record<string, string>,
	signature: string | null,
): boolean {
	const token = process.env.TWILIO_AUTH_TOKEN;
	if (!token || !signature) return false;

	const sortedKeys = Object.keys(params).sort();
	let data = url;
	for (const k of sortedKeys) data += k + params[k];

	const expected = createHmac('sha1', token).update(data, 'utf8').digest('base64');
	// Constant-time compare to defeat timing attacks. Buffers must be
	// equal length or timingSafeEqual throws — handle that explicitly
	// since a length mismatch is already a "no" answer.
	const a = Buffer.from(expected);
	const b = Buffer.from(signature);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
