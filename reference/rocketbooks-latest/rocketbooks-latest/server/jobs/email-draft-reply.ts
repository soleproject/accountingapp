import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { inngest } from '@/lib/inngest';
import { db } from '@/db/client';
import { inboxMessages } from '@/db/schema/schema';
import { classifyForDraft } from '@/lib/email-accounts/noise-classifier';
import { generateDraft } from '@/lib/email-accounts/ai-draft';
import { logger } from '@/lib/logger';

/**
 * Cron-driven AI drafting for inbound email.
 *
 * Schedule: once a minute. Each tick pulls up to BATCH messages with
 * ai_status='pending' AND source='email' (oldest first so a backfill
 * burst gets cleared in order). For each:
 *   1. Run noise classifier — if skip, set ai_status='skipped_noise'.
 *   2. Otherwise call AI → store draft + flip ai_status='drafted'.
 *   3. On error → ai_status='failed' with the error in ai_skip_reason.
 *
 * BATCH caps OpenAI spend per cycle. Behind by 100 catches up in 5
 * cycles (~5 min); behind by 1000 in 50 min. If real volume warrants,
 * raise BATCH or convert to fan-out events.
 *
 * Per-message work is wrapped in step.run so one failure doesn't
 * poison the rest. retries=0 because the per-message catch already
 * records the failure to the DB; Inngest retrying the whole sweep
 * would just rediscover the same broken row.
 */
const BATCH = 20;

export const emailDraftReply = inngest.createFunction(
	{
		id: 'email-draft-reply',
		retries: 0,
		triggers: [{ cron: '* * * * *' }],
	},
	async ({ step }) => {
		const pending = await step.run('load-pending-drafts', async () =>
			db
				.select({
					id: inboxMessages.id,
					userId: inboxMessages.userId,
					fromAddress: inboxMessages.fromAddress,
					fromName: inboxMessages.fromName,
					subject: inboxMessages.subject,
					body: inboxMessages.body,
					bodyHtml: inboxMessages.bodyHtml,
					threadId: inboxMessages.threadId,
					receivedAt: inboxMessages.receivedAt,
				})
				.from(inboxMessages)
				.where(and(eq(inboxMessages.aiStatus, 'pending'), eq(inboxMessages.source, 'email')))
				.orderBy(asc(inboxMessages.receivedAt))
				.limit(BATCH),
		);

		if (pending.length === 0) return { processed: 0 };

		let drafted = 0;
		let skipped = 0;
		let failed = 0;

		for (const m of pending) {
			try {
				await step.run(`draft-${m.id}`, async () => {
					const verdict = classifyForDraft({
						fromAddress: m.fromAddress,
						subject: m.subject,
						body: m.body,
						bodyHtml: m.bodyHtml,
					});
					if (verdict.skip) {
						await db
							.update(inboxMessages)
							.set({ aiStatus: 'skipped_noise', aiSkipReason: verdict.reason ?? 'unknown' })
							.where(eq(inboxMessages.id, m.id));
						skipped++;
						return;
					}

					const draft = await generateDraft({
						id: m.id,
						userId: m.userId,
						fromAddress: m.fromAddress,
						fromName: m.fromName,
						subject: m.subject,
						body: m.body,
						threadId: m.threadId,
						receivedAt: m.receivedAt,
					});
					await db
						.update(inboxMessages)
						.set({
							aiStatus: 'drafted',
							aiDraftSubject: draft.subject,
							aiDraftHtml: draft.html,
							aiDraftText: draft.text,
							aiModel: draft.model,
							aiDraftedAt: new Date().toISOString(),
							aiSkipReason: null,
						})
						.where(eq(inboxMessages.id, m.id));
					drafted++;
				});
			} catch (err) {
				failed++;
				const msg = err instanceof Error ? err.message : String(err);
				logger.warn({ messageId: m.id, err: msg }, 'email-draft-reply: per-message failure');
				// Record on the row so the UI can surface it; doesn't re-throw
				// (step.run catch already isolated this).
				try {
					await db
						.update(inboxMessages)
						.set({ aiStatus: 'failed', aiSkipReason: msg.slice(0, 1000) })
						.where(eq(inboxMessages.id, m.id));
				} catch {
					// If even the failure-write fails, leave the row as 'pending'
					// and the next cycle will re-try.
				}
			}
		}

		logger.info({ processed: pending.length, drafted, skipped, failed }, 'email-draft-reply: cycle complete');
		return { processed: pending.length, drafted, skipped, failed };
	},
);
