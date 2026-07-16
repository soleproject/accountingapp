import 'server-only';
import { Resend } from 'resend';
import { logger } from '@/lib/logger';
import { recordServiceUsage, type UsageCtx } from '@/lib/ai/usage';

/**
 * Transactional email via Resend. Env-guarded — when RESEND_API_KEY
 * isn't set, every send is a quiet no-op so the feature degrades
 * cleanly. This means new orgs / dev environments without the key
 * still work end-to-end; the email steps just don't happen and
 * everything else (rendering, signing, GL posting) is unaffected.
 *
 * RESEND_FROM is the verified sender (default 'no-reply@rocketsuite.ai'
 * if unset). Set it to a domain you control + have verified in the
 * Resend dashboard before flipping the key on in prod.
 */

const FROM_DEFAULT = 'no-reply@rocketsuite.ai';

/** Extract the bare email from a "Name <email>" or plain-address From string. */
function bareAddress(from: string): string {
	const m = from.match(/<([^>]+)>/);
	return m ? m[1].trim() : from.trim();
}

/** Quote a display name for a From header, stripping characters that would break it. */
function quoteName(name: string): string {
	return `"${name.replace(/[\r\n"<>]/g, ' ').trim()}"`;
}

let client: Resend | null = null;
function getClient(): Resend | null {
	if (client) return client;
	const key = process.env.RESEND_API_KEY;
	if (!key) return null;
	client = new Resend(key);
	return client;
}

export function isResendConfigured(): boolean {
	return !!process.env.RESEND_API_KEY;
}

export interface SendEmailArgs {
	to: string | string[];
	subject: string;
	/** Plain-text body. */
	text?: string;
	/** HTML body. Either text or html is required. */
	html?: string;
	/** Optional reply-to override. Defaults to the from address. */
	replyTo?: string;
	/** Optional display name for the From header (e.g. the firm's name). The
	 *  underlying address stays the verified RESEND_FROM sender — this only
	 *  changes what recipients see as the sender label. */
	fromName?: string;
	/** Auto-brand the sender label for the firm that owns this org (if any).
	 *  Resolves the firm's name when the org is a private-label firm's client;
	 *  a no-op otherwise. Ignored when fromName is set explicitly. */
	brandForOrgId?: string;
	/** File attachments. Resend expects { filename, content } where content is base64. */
	attachments?: Array<{ filename: string; content: string }>;
	/** Optional cost-tracking context. When supplied, a successful send logs
	 *  one usage event (priced per email) to the unified ledger. A send to
	 *  multiple recipients is one Resend API call, hence one billed email. */
	usage?: UsageCtx;
}

export interface SendEmailResult {
	sent: boolean;
	id?: string;
	error?: string;
	/** True when no send was attempted because RESEND_API_KEY is
	 *  missing — distinct from a real failure. */
	skipped?: boolean;
}

/**
 * Fire-and-forget transactional send. Wrapped in try/catch so a
 * Resend outage / quota error never propagates into a caller's flow.
 * Callers that care about the outcome can branch on `.sent`.
 */
export async function sendTransactionalEmail(args: SendEmailArgs): Promise<SendEmailResult> {
	const c = getClient();
	if (!c) {
		logger.debug({ to: args.to, subject: args.subject }, 'resend skipped — no API key');
		return { sent: false, skipped: true };
	}
	const from = process.env.RESEND_FROM ?? FROM_DEFAULT;
	// Resolve firm branding for this org. Fetch whenever brandForOrgId is set
	// (even if fromName was passed) so we can pick up the per-firm white-label
	// from-address, not just the display name.
	let fromName = args.fromName;
	let brandedAddress: string | null = null;
	if (args.brandForOrgId) {
		try {
			const { getFirmSenderForOrg } = await import('@/lib/enterprise/sender');
			const id = await getFirmSenderForOrg(args.brandForOrgId);
			if (!fromName) fromName = id.fromName ?? undefined;
			brandedAddress = id.fromAddress ?? null;
		} catch {
			/* branding is best-effort — never block a send */
		}
	}
	// From-address precedence so private-label clients never see the RocketBooks
	// domain: per-firm white-label address (e.g. scarlett@accountingapp.ai, when
	// RESEND_WHITELABEL_DOMAIN is verified+set) → shared white-label domain
	// (RESEND_FROM_WHITELABEL) → default verified address. The display name is
	// the firm name. Recipients see "ScarlettBooks <scarlett@accountingapp.ai>".
	const baseFrom =
		brandedAddress ?? (fromName && process.env.RESEND_FROM_WHITELABEL ? process.env.RESEND_FROM_WHITELABEL : from);
	const fromHeader = fromName ? `${quoteName(fromName)} <${bareAddress(baseFrom)}>` : from;
	// Resend's TS types narrow on body shape — provide html OR text
	// explicitly (not both with one undefined), and only include
	// replyTo when set. Without this dance the union narrowing fails.
	if (!args.html && !args.text) {
		return { sent: false, error: 'No body provided (html or text required)' };
	}
	const attach = args.attachments?.length ? { attachments: args.attachments } : {};
	const payload = args.html
		? { from: fromHeader, to: args.to, subject: args.subject, html: args.html, ...(args.text ? { text: args.text } : {}), ...attach }
		: { from: fromHeader, to: args.to, subject: args.subject, text: args.text!, ...attach };
	try {
		const { data, error } = await c.emails.send(
			args.replyTo
				? { ...payload, replyTo: args.replyTo }
				: payload,
		);
		if (error) {
			logger.warn({ to: args.to, err: error.message }, 'resend send failed');
			return { sent: false, error: error.message };
		}
		if (args.usage) {
			recordServiceUsage(args.usage, {
				provider: 'resend',
				category: 'email',
				unit: 'emails',
				quantity: 1,
				rateKey: 'resend:email',
				model: 'email',
			});
		}
		return { sent: true, id: data?.id };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn({ to: args.to, err: msg }, 'resend send threw');
		return { sent: false, error: msg };
	}
}
