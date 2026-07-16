'use server';

import { randomUUID } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { trustDobCorrectionJobs, trustBeneficiaries } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { safeSend } from '@/lib/inngest';
import {
	previewDobCorrection,
	type DobCorrectionItem,
} from '@/lib/accounting/trust-dob-correction';

const Schema = z.object({
	beneficiaryId: z.string().min(1),
	newDob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	jeIdsToRepost: z.array(z.string().min(1)),
});

export interface QueueDobChangeResult {
	ok: boolean;
	jobId?: string;
	totalCount?: number;
	error?: string;
}

/**
 * Snapshot the DOB-correction diff into a job row and hand the work off
 * to the Inngest worker (server/jobs/trust-dob-correction.ts). The
 * caller polls trust_dob_correction_jobs.{status, progress,
 * reposted_count, failed_count} via getDobCorrectionJobStatus and can
 * close the tab without aborting the work.
 *
 * Re-runs the preview server-side to defend against stale UI input —
 * the snapshot we persist is computed from the current GL state at
 * queue time, not whatever the client passed.
 *
 * Refuses to enqueue a second job for the same beneficiary while one
 * is still running. The UI surfaces the in-flight job instead.
 */
export async function queueBeneficiaryDobChange(
	args: { beneficiaryId: string; newDob: string; jeIdsToRepost: string[] },
): Promise<QueueDobChangeResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();
	if (!userId) return { ok: false, error: 'No session user' };

	const parsed = Schema.safeParse(args);
	if (!parsed.success) {
		return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
	}

	const [bene] = await db
		.select({
			id: trustBeneficiaries.id,
			dateOfBirth: trustBeneficiaries.dateOfBirth,
		})
		.from(trustBeneficiaries)
		.where(
			and(
				eq(trustBeneficiaries.id, parsed.data.beneficiaryId),
				eq(trustBeneficiaries.organizationId, orgId),
			),
		)
		.limit(1);
	if (!bene) return { ok: false, error: 'Beneficiary not found' };

	// Bail out if there's already a queued/running job for this bene —
	// avoids two workers racing on the same JEs.
	const [existing] = await db
		.select({ id: trustDobCorrectionJobs.id })
		.from(trustDobCorrectionJobs)
		.where(
			and(
				eq(trustDobCorrectionJobs.beneficiaryId, parsed.data.beneficiaryId),
				inArray(trustDobCorrectionJobs.status, ['queued', 'running']),
			),
		)
		.limit(1);
	if (existing) {
		return { ok: false, error: 'A DOB correction is already running for this beneficiary.' };
	}

	const diff = await previewDobCorrection({
		organizationId: orgId,
		beneficiaryId: parsed.data.beneficiaryId,
		newDob: parsed.data.newDob,
	});
	const wantSet = new Set(parsed.data.jeIdsToRepost);
	const items: DobCorrectionItem[] = [
		...diff.rerouteOut.filter((i) => wantSet.has(i.jeId) && i.canAutoRepost),
		...diff.rerouteIn.filter((i) => wantSet.has(i.jeId) && i.canAutoRepost),
	];

	if (items.length === 0) {
		// No JEs to repost (preview drifted out from under the user OR
		// only manual JEs remained). Update the DOB directly and skip
		// the job machinery.
		await db
			.update(trustBeneficiaries)
			.set({
				dateOfBirth: parsed.data.newDob,
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(trustBeneficiaries.id, parsed.data.beneficiaryId),
					eq(trustBeneficiaries.organizationId, orgId),
				),
			);
		return { ok: true, totalCount: 0 };
	}

	const jobId = randomUUID();
	const now = new Date().toISOString();
	await db.insert(trustDobCorrectionJobs).values({
		id: jobId,
		organizationId: orgId,
		userId,
		beneficiaryId: parsed.data.beneficiaryId,
		oldDob: bene.dateOfBirth,
		newDob: parsed.data.newDob,
		items: items as unknown as object,
		totalCount: items.length,
		status: 'queued',
		progress: 0,
		repostedCount: 0,
		failedCount: 0,
		createdAt: now,
		updatedAt: now,
	});

	const sent = await safeSend({
		name: 'trust/dob-correction.requested',
		data: { jobId },
	});
	if (!sent) {
		// Inngest unreachable — mark the job failed so the UI doesn't
		// poll forever, and surface the failure to the caller.
		await db
			.update(trustDobCorrectionJobs)
			.set({
				status: 'failed',
				errorMessage: 'Job queue unreachable — try again in a minute.',
				updatedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			})
			.where(eq(trustDobCorrectionJobs.id, jobId));
		return { ok: false, error: 'Job queue unreachable — try again in a minute.' };
	}

	void sql;
	return { ok: true, jobId, totalCount: items.length };
}
