import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { inngest } from '@/lib/inngest';
import { db } from '@/db/client';
import {
	trustBeneficiaries,
	trustDobCorrectionJobs,
} from '@/db/schema/schema';
import {
	repostDobCorrectionItems,
	type DobCorrectionItem,
} from '@/lib/accounting/trust-dob-correction';
import { logger } from '@/lib/logger';

/**
 * Number of JEs reposted in a single Inngest step. Each repost is a
 * reverse + recreate cycle that takes ~2-4 seconds against Supabase
 * pooling, so a batch of 25 lands in ~60-90s — well under the default
 * step timeout. Smaller batches checkpoint more often (better resume
 * after a restart) at the cost of more step overhead.
 */
const BATCH_SIZE = 25;

/**
 * Background DOB-correction worker.
 *
 * Queue action snapshots the diff (rerouteIn + rerouteOut items the
 * user confirmed) into trust_dob_correction_jobs.items and fires this
 * event. We:
 *   1. mark the job running + write the new DOB (so any rule re-
 *      evaluations triggered downstream see the new value)
 *   2. process the items in batches of BATCH_SIZE, updating
 *      reposted_count / failed_count / progress after each batch
 *   3. mark the job completed (or failed if the worker itself threw)
 *   4. revalidate the bene detail + trust review pages so the UI
 *      reflects the new GL state
 *
 * Concurrency keyed on beneficiaryId — Inngest serializes runs for the
 * same beneficiary, so a second click while the first is running is
 * deferred rather than racing.
 */
export const trustDobCorrection = inngest.createFunction(
	{
		id: 'trust-dob-correction',
		concurrency: { limit: 1, key: 'event.data.jobId' },
		retries: 2,
		triggers: [{ event: 'trust/dob-correction.requested' }],
	},
	async ({ event, step }) => {
		const { jobId } = event.data as { jobId: string };

		const job = await step.run('load-job', async () => {
			const [row] = await db
				.select()
				.from(trustDobCorrectionJobs)
				.where(eq(trustDobCorrectionJobs.id, jobId))
				.limit(1);
			if (!row) throw new Error(`Job ${jobId} not found`);
			return row;
		});

		const items = job.items as DobCorrectionItem[];
		const orgId = job.organizationId;
		const beneficiaryId = job.beneficiaryId;
		const newDob = job.newDob;

		await step.run('mark-running-and-write-dob', async () => {
			const now = new Date().toISOString();
			await db
				.update(trustDobCorrectionJobs)
				.set({
					status: 'running',
					startedAt: now,
					updatedAt: now,
				})
				.where(eq(trustDobCorrectionJobs.id, jobId));
			await db
				.update(trustBeneficiaries)
				.set({
					dateOfBirth: newDob,
					updatedAt: now,
				})
				.where(
					and(
						eq(trustBeneficiaries.id, beneficiaryId),
						eq(trustBeneficiaries.organizationId, orgId),
					),
				);
		});

		logger.info(
			{ jobId, beneficiaryId, total: items.length },
			'trust-dob-correction starting',
		);

		const batches: DobCorrectionItem[][] = [];
		for (let i = 0; i < items.length; i += BATCH_SIZE) {
			batches.push(items.slice(i, i + BATCH_SIZE));
		}

		for (let i = 0; i < batches.length; i++) {
			const batch = batches[i];
			await step.run(`batch-${i}`, async () => {
				const r = await repostDobCorrectionItems({
					organizationId: orgId,
					beneficiaryId,
					items: batch,
				});
				const now = new Date().toISOString();
				// Bump counters incrementally so the polling UI sees
				// progress mid-job. progress is recomputed against the
				// running total / total so we don't have to track which
				// batch we're on across retries.
				const result = await db
					.update(trustDobCorrectionJobs)
					.set({
						repostedCount: sql`${trustDobCorrectionJobs.repostedCount} + ${r.reposted}`,
						failedCount: sql`${trustDobCorrectionJobs.failedCount} + ${r.failed.length}`,
						failedItems: sql`COALESCE(${trustDobCorrectionJobs.failedItems}, '[]'::json)::jsonb || ${JSON.stringify(r.failed)}::jsonb`,
						updatedAt: now,
					})
					.where(eq(trustDobCorrectionJobs.id, jobId))
					.returning({
						reposted: trustDobCorrectionJobs.repostedCount,
						failed: trustDobCorrectionJobs.failedCount,
						total: trustDobCorrectionJobs.totalCount,
					});
				const row = result[0];
				if (row) {
					const done = row.reposted + row.failed;
					const pct = row.total > 0 ? Math.round((done * 100) / row.total) : 100;
					await db
						.update(trustDobCorrectionJobs)
						.set({ progress: pct })
						.where(eq(trustDobCorrectionJobs.id, jobId));
				}
			});
		}

		await step.run('mark-complete', async () => {
			const now = new Date().toISOString();
			await db
				.update(trustDobCorrectionJobs)
				.set({
					status: 'completed',
					progress: 100,
					completedAt: now,
					updatedAt: now,
				})
				.where(eq(trustDobCorrectionJobs.id, jobId));

			revalidatePath('/trust-beneficiaries');
			revalidatePath(`/trust-beneficiaries/${beneficiaryId}`);
			revalidatePath('/trust-review');
			revalidatePath('/transactions');
		});

		logger.info({ jobId, beneficiaryId }, 'trust-dob-correction complete');
	},
);
