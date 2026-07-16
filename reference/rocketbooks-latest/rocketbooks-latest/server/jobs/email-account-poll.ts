import 'server-only';
import { eq } from 'drizzle-orm';
import { inngest } from '@/lib/inngest';
import { db } from '@/db/client';
import { emailAccounts } from '@/db/schema/schema';
import { fetchOneAccount, type AccountForPoll } from '@/lib/email-accounts/imap-fetch';
import { logger } from '@/lib/logger';

/**
 * Cron-driven IMAP poller for connected email accounts.
 *
 * Schedule: once a minute (Inngest's cron min granularity). Each tick
 * walks every is_active=true account in admin_communications' sibling
 * table email_accounts, pulls new mail via IMAP, parses, and POSTs to
 * /api/inbox/ingest.
 *
 * Per-account work is wrapped in `step.run` so a single account's
 * failure surfaces as a Step error in the Inngest UI without poisoning
 * the rest of the cycle. We catch around each step.run call so the loop
 * always completes even when one mailbox is down — the failed account
 * is marked auth_failed/connect_failed in the DB and rejoins the next
 * cycle.
 *
 * Volume note: we run sequentially. For low account counts (< a few
 * hundred) this comfortably fits inside one cron minute. If account
 * counts grow we'll fan out via `inngest.send` events to a per-account
 * function — the imap-fetch module already takes a single account so
 * the refactor is cheap.
 */
export const emailAccountPoll = inngest.createFunction(
	{
		id: 'email-account-poll',
		retries: 0,
		triggers: [{ cron: '* * * * *' }],
	},
	async ({ step }) => {
		const accounts = await step.run('load-active-accounts', async () =>
			db
				.select({
					id: emailAccounts.id,
					userId: emailAccounts.userId,
					emailAddress: emailAccounts.emailAddress,
					encryptedPassword: emailAccounts.encryptedPassword,
					encryptionIv: emailAccounts.encryptionIv,
					encryptionAuthTag: emailAccounts.encryptionAuthTag,
					imapHost: emailAccounts.imapHost,
					imapPort: emailAccounts.imapPort,
					imapSecure: emailAccounts.imapSecure,
					lastUidSeen: emailAccounts.lastUidSeen,
					lastUidvalidity: emailAccounts.lastUidvalidity,
				})
				.from(emailAccounts)
				.where(eq(emailAccounts.isActive, true)),
		);

		if (accounts.length === 0) {
			return { polled: 0 };
		}

		let polled = 0;
		let totalIngested = 0;
		let totalDuplicates = 0;
		let totalFailed = 0;
		let connError = 0;
		let authError = 0;

		for (const a of accounts as AccountForPoll[]) {
			try {
				const outcome = await step.run(`poll-${a.id}`, async () => {
					const r = await fetchOneAccount(a);
					await db
						.update(emailAccounts)
						.set({
							lastUidSeen: r.update.lastUidSeen,
							lastUidvalidity: r.update.lastUidvalidity,
							lastPolledAt: r.update.lastPolledAt,
							connectionStatus: r.update.connectionStatus,
							lastError: r.update.lastError,
							updatedAt: new Date().toISOString(),
						})
						.where(eq(emailAccounts.id, a.id));
					return r;
				});
				polled++;
				totalIngested += outcome.stats.ingested;
				totalDuplicates += outcome.stats.duplicates;
				totalFailed += outcome.stats.ingestFailed;
				if (outcome.update.connectionStatus === 'auth_failed') authError++;
				else if (outcome.update.connectionStatus === 'connect_failed') connError++;
			} catch (err) {
				// step.run failure: log + continue. The account row stays
				// at its previous status so the next cycle re-tries cleanly.
				logger.error(
					{ accountId: a.id, err: err instanceof Error ? err.message : String(err) },
					'email-account-poll: account step failed',
				);
			}
		}

		logger.info(
			{ polled, totalIngested, totalDuplicates, totalFailed, connError, authError },
			'email-account-poll: cycle complete',
		);
		return {
			polled,
			ingested: totalIngested,
			duplicates: totalDuplicates,
			ingestFailed: totalFailed,
			connError,
			authError,
		};
	},
);
