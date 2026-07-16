/**
 * Pure-heuristic classifier: is this inbound email worth drafting a
 * reply for, or is it noise (newsletter, receipt, automated, marketing)?
 *
 * Deliberately no AI calls here. Heuristics are cheap, deterministic,
 * and predictable — we'd rather skip a borderline message and let the
 * user click "Draft a reply anyway" than burn tokens on every receipt.
 *
 * The poller has already stored the original headers / body on the
 * inbox_messages row, so we only see what's in the DB shape. Pass in
 * the relevant fields explicitly so this stays dependency-free and
 * easy to unit-test.
 */

export interface ClassifierInput {
	fromAddress: string;
	subject: string | null;
	body: string | null;
	bodyHtml: string | null;
}

export interface ClassifierResult {
	skip: boolean;
	/** Short identifier for which rule fired; saved as ai_skip_reason. */
	reason?:
		| 'list-unsubscribe'
		| 'no-reply-sender'
		| 'marketing-domain'
		| 'transactional-subject'
		| 'auto-reply';
}

const NO_REPLY_LOCAL_PARTS = new Set([
	'no-reply',
	'noreply',
	'donotreply',
	'do-not-reply',
	'mailer-daemon',
	'postmaster',
	'bounce',
	'bounces',
	'notification',
	'notifications',
	'auto-reply',
	'autoreply',
]);

// Domains whose mail is almost always marketing / receipts / lifecycle.
// Conservative list — adding a sender here means we'll never draft for
// them, so prefer letting noisy domains slip through over false-positives
// that suppress real correspondence.
const MARKETING_DOMAINS = new Set([
	'mailchimp.com',
	'mc.us19.mcsv.net',
	'sendgrid.net',
	'em.email',
	'hubspot.com',
	'hubspotemail.net',
	'intercom-mail.com',
	'shopifyemail.com',
	'klaviyomail.com',
	'mandrillapp.com',
	'amazonses.com',
	'mailgun.org',
	'mailgun.info',
	'sparkpostmail.com',
]);

const TRANSACTIONAL_SUBJECT_RE =
	/^(your\s+)?(receipt|order|invoice\b|payment|confirmation|shipping|tracking|statement|reset|verification|confirm your)/i;

const AUTO_REPLY_SUBJECT_RE = /^(out of office|automatic reply|auto[- ]?reply)/i;

function localPart(email: string): string {
	const at = email.lastIndexOf('@');
	return at >= 0 ? email.slice(0, at).toLowerCase().trim() : email.toLowerCase().trim();
}

function domainOf(email: string): string {
	const at = email.lastIndexOf('@');
	return at >= 0 ? email.slice(at + 1).toLowerCase().trim() : '';
}

/**
 * Cheap header peek for List-Unsubscribe. The poller doesn't currently
 * store raw headers, so we infer from body markup: a `<a href="...">unsubscribe</a>`
 * within ~last 1KB of HTML is a strong signal even when we lack headers.
 * False positives here are rare (legitimate replies don't include
 * unsubscribe links).
 */
function looksUnsubscribable(html: string | null): boolean {
	if (!html) return false;
	const tail = html.length > 4000 ? html.slice(-4000) : html;
	return /unsubscribe|email preferences|manage (your )?subscription/i.test(tail);
}

export function classifyForDraft(input: ClassifierInput): ClassifierResult {
	const lp = localPart(input.fromAddress);
	if (NO_REPLY_LOCAL_PARTS.has(lp)) return { skip: true, reason: 'no-reply-sender' };

	// Loose match for things like "no-reply+order123@..."
	for (const stem of NO_REPLY_LOCAL_PARTS) {
		if (lp.startsWith(`${stem}+`) || lp.startsWith(`${stem}-`)) {
			return { skip: true, reason: 'no-reply-sender' };
		}
	}

	const domain = domainOf(input.fromAddress);
	if (domain && MARKETING_DOMAINS.has(domain)) {
		return { skip: true, reason: 'marketing-domain' };
	}

	const subj = input.subject ?? '';
	if (AUTO_REPLY_SUBJECT_RE.test(subj)) return { skip: true, reason: 'auto-reply' };
	if (TRANSACTIONAL_SUBJECT_RE.test(subj)) return { skip: true, reason: 'transactional-subject' };

	if (looksUnsubscribable(input.bodyHtml)) return { skip: true, reason: 'list-unsubscribe' };

	return { skip: false };
}
