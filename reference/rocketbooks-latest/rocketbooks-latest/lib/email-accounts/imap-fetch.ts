import 'server-only';
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import { logger } from '@/lib/logger';
import { decryptSecret } from './crypto';
import { postToIngest } from './ingest-client';

/**
 * Per-account IMAP fetch. Connects, decides which UIDs to fetch
 * (backfill window on first poll, incremental otherwise), pulls each
 * message, parses with mailparser, posts to /api/inbox/ingest, and
 * returns a state delta the caller writes back to email_accounts.
 *
 * Backfill window (first poll only): last 7 days, capped at 200
 * messages, oldest-first so the ingester sees them in chronological
 * order. Subsequent polls fetch UID > last_uid_seen up to PER_CYCLE_CAP.
 *
 * The external_id we hand the ingester is `acct:<id>:<uidvalidity>:<uid>`
 * so it's globally unique per user even if the user connects two
 * mailboxes whose UIDs overlap. Idempotency on the ingester side keeps
 * retries safe.
 */

const BACKFILL_DAYS = 7;
const BACKFILL_CAP = 200;
const PER_CYCLE_CAP = 50;

export interface AccountForPoll {
	id: string;
	userId: string;
	emailAddress: string;
	encryptedPassword: string;
	encryptionIv: string;
	encryptionAuthTag: string;
	imapHost: string;
	imapPort: number;
	imapSecure: boolean;
	lastUidSeen: number | null;
	lastUidvalidity: number | null;
}

export interface PollOutcome {
	/** What the caller should write back into email_accounts. */
	update: {
		lastUidSeen: number | null;
		lastUidvalidity: number | null;
		lastPolledAt: string;
		connectionStatus: 'ok' | 'auth_failed' | 'connect_failed';
		lastError: string | null;
	};
	stats: {
		fetched: number;
		ingested: number;
		duplicates: number;
		ingestFailed: number;
	};
}

function isAuthError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /auth|invalid credentials|535|login/i.test(msg);
}

/** Pull a clean address line from a mailparser AddressObject. */
function firstAddress(addr: AddressObject | AddressObject[] | undefined): { address: string; name: string | undefined } {
	const list = Array.isArray(addr) ? addr : addr ? [addr] : [];
	for (const ao of list) {
		const v = ao.value?.[0];
		if (v?.address) return { address: v.address, name: v.name || undefined };
	}
	return { address: '', name: undefined };
}

/** Body text fallback chain so the ingester's NOT NULL body constraint never fires. */
function deriveBody(text: string | undefined, html: string | false | undefined, subject: string | undefined): string {
	const t = (text ?? '').trim();
	if (t) return t;
	if (typeof html === 'string' && html.trim()) {
		// Crude tag-strip — good enough for a fallback body; the full HTML
		// is also stored in body_html for proper rendering later.
		const stripped = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
		if (stripped) return stripped;
	}
	if (subject?.trim()) return `(no body — see subject: ${subject.trim()})`;
	return '(no body)';
}

/**
 * Best-effort thread id: prefer the References header (the original
 * thread root + ancestors, space-separated), fall back to In-Reply-To,
 * fall back to Message-ID (so single-message threads still get an id).
 * We store the first reference's Message-ID — that's the thread root —
 * so future replies hash to the same value.
 */
function deriveThreadId(headers: Map<string, unknown>): string | undefined {
	const refsRaw = headers.get('references');
	if (typeof refsRaw === 'string') {
		const first = refsRaw.trim().split(/\s+/)[0]?.replace(/[<>]/g, '');
		if (first) return first;
	}
	const irtRaw = headers.get('in-reply-to');
	if (typeof irtRaw === 'string') {
		const v = irtRaw.trim().replace(/[<>]/g, '');
		if (v) return v;
	}
	const midRaw = headers.get('message-id');
	if (typeof midRaw === 'string') {
		const v = midRaw.trim().replace(/[<>]/g, '');
		if (v) return v;
	}
	return undefined;
}

export async function fetchOneAccount(account: AccountForPoll): Promise<PollOutcome> {
	const pollStartedIso = new Date().toISOString();
	const stats = { fetched: 0, ingested: 0, duplicates: 0, ingestFailed: 0 };

	const password = decryptSecret({
		ciphertext: account.encryptedPassword,
		iv: account.encryptionIv,
		authTag: account.encryptionAuthTag,
	});

	const client = new ImapFlow({
		host: account.imapHost,
		port: account.imapPort,
		secure: account.imapSecure,
		auth: { user: account.emailAddress, pass: password },
		logger: false,
		emitLogs: false,
	});

	try {
		await client.connect();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await client.logout().catch(() => undefined);
		return {
			update: {
				lastUidSeen: account.lastUidSeen,
				lastUidvalidity: account.lastUidvalidity,
				lastPolledAt: pollStartedIso,
				connectionStatus: isAuthError(err) ? 'auth_failed' : 'connect_failed',
				lastError: msg,
			},
			stats,
		};
	}

	let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | null = null;
	let nextLastUidSeen = account.lastUidSeen;
	let nextLastUidvalidity = account.lastUidvalidity;
	let lastError: string | null = null;

	try {
		lock = await client.getMailboxLock('INBOX', { readOnly: true });
		const mb = client.mailbox;
		if (!mb || typeof mb === 'boolean') throw new Error('mailbox open failed');
		const uidvalidity = Number(mb.uidValidity ?? 0) || null;

		// UIDVALIDITY changed → throw away the watermark, treat as fresh.
		const isFirstPoll =
			account.lastUidSeen == null ||
			(uidvalidity != null && account.lastUidvalidity != null && uidvalidity !== account.lastUidvalidity);

		let uids: number[] = [];
		let backfillSearchReturnedZero = false;
		if (isFirstPoll) {
			const since = new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000);
			const found = (await client.search({ since }, { uid: true })) || [];
			backfillSearchReturnedZero = (found as number[]).length === 0;
			// Keep the most recent BACKFILL_CAP, then sort asc so ingester
			// sees oldest first → makes thread-id linking land in the right
			// order for downstream consumers.
			uids = (found as number[]).sort((a, b) => a - b);
			if (uids.length > BACKFILL_CAP) uids = uids.slice(-BACKFILL_CAP);
		} else {
			const since = account.lastUidSeen! + 1;
			const range = `${since}:*`;
			const found = (await client.search({ uid: range }, { uid: true })) || [];
			uids = (found as number[]).filter((u) => u >= since).sort((a, b) => a - b);
			if (uids.length > PER_CYCLE_CAP) uids = uids.slice(0, PER_CYCLE_CAP);
		}

		for (const uid of uids) {
			let msg: Awaited<ReturnType<typeof client.fetchOne>>;
			try {
				msg = await client.fetchOne(String(uid), { source: true, envelope: true, uid: true }, { uid: true });
			} catch (err) {
				logger.warn({ uid, err: err instanceof Error ? err.message : err }, 'imap fetchOne failed; skipping uid');
				continue;
			}
			if (!msg || !msg.source) continue;
			stats.fetched++;

			let parsed: Awaited<ReturnType<typeof simpleParser>>;
			try {
				parsed = await simpleParser(msg.source);
			} catch (err) {
				logger.warn({ uid, err: err instanceof Error ? err.message : err }, 'mailparser failed; skipping uid');
				continue;
			}

			const from = firstAddress(parsed.from);
			const subject = parsed.subject ?? undefined;
			const body = deriveBody(parsed.text, parsed.html, subject);
			const bodyHtml = typeof parsed.html === 'string' ? parsed.html : undefined;
			const receivedAt = parsed.date ? parsed.date.toISOString() : new Date().toISOString();
			const threadId = deriveThreadId(parsed.headers);
			const externalId = `acct:${account.id}:${uidvalidity ?? 0}:${uid}`;

			const r = await postToIngest({
				userId: account.userId,
				source: 'email',
				fromAddress: from.address || '(unknown)',
				fromName: from.name,
				subject,
				body,
				bodyHtml,
				receivedAt,
				externalId,
				threadId,
			});
			if (r.ok && r.duplicate) stats.duplicates++;
			else if (r.ok) stats.ingested++;
			else stats.ingestFailed++;

			// Watermark only advances on successful ingest (or duplicate —
			// which means we already processed it). A 5xx on the ingester
			// halts the watermark so we retry the same UID next cycle.
			if (r.ok) {
				nextLastUidSeen = Math.max(nextLastUidSeen ?? 0, uid);
			} else {
				lastError = lastError ?? `ingest failed for uid ${uid}: ${r.error ?? 'unknown'}`;
				// Don't keep hammering the ingester this cycle if it's broken.
				break;
			}
		}

		// On first poll, if the SEARCH SINCE returned zero results (mailbox
		// has nothing in the backfill window), anchor the watermark to the
		// inbox tip so the next cycle's incremental search has a starting
		// point. Critical: we only do this when SEARCH returned zero —
		// NOT just when no messages were ingested. If search found
		// messages but ingest failed for all of them, leaving the
		// watermark at NULL means the next cycle re-attempts the same
		// backfill after the ingest is fixed.
		if (
			isFirstPoll &&
			backfillSearchReturnedZero &&
			nextLastUidSeen == null &&
			typeof mb.exists === 'number' &&
			mb.exists > 0
		) {
			// fetchOne with seq=mb.exists gives the most-recent message;
			// pull just its UID without source to keep this cheap.
			try {
				const tip = await client.fetchOne(String(mb.exists), { uid: true });
				if (tip && typeof tip.uid === 'number') nextLastUidSeen = tip.uid;
			} catch {
				// Best effort — if it fails, next cycle will try again.
			}
		}

		nextLastUidvalidity = uidvalidity ?? nextLastUidvalidity;
	} catch (err) {
		lastError = err instanceof Error ? err.message : String(err);
	} finally {
		if (lock) lock.release();
		await client.logout().catch(() => undefined);
	}

	return {
		update: {
			lastUidSeen: nextLastUidSeen,
			lastUidvalidity: nextLastUidvalidity,
			lastPolledAt: pollStartedIso,
			connectionStatus: lastError ? 'connect_failed' : 'ok',
			lastError,
		},
		stats,
	};
}
