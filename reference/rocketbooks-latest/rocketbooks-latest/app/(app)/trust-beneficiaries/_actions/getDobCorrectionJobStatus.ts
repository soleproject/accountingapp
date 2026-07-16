'use server';

import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { trustDobCorrectionJobs } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';

export interface DobCorrectionJobStatus {
	id: string;
	beneficiaryId: string;
	status: 'queued' | 'running' | 'completed' | 'failed';
	progress: number;
	totalCount: number;
	repostedCount: number;
	failedCount: number;
	errorMessage: string | null;
	newDob: string;
	createdAt: string;
	completedAt: string | null;
}

/**
 * Poll target for the floating progress pill. Returns the most recent
 * job for a beneficiary regardless of status — the UI uses the status
 * field to decide whether to render the pill (queued|running) or a
 * just-finished toast (completed within the last minute) or nothing.
 */
export async function getDobCorrectionJobStatus(args: {
	beneficiaryId: string;
}): Promise<{ ok: true; job: DobCorrectionJobStatus | null } | { ok: false; error: string }> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const [row] = await db
		.select({
			id: trustDobCorrectionJobs.id,
			beneficiaryId: trustDobCorrectionJobs.beneficiaryId,
			status: trustDobCorrectionJobs.status,
			progress: trustDobCorrectionJobs.progress,
			totalCount: trustDobCorrectionJobs.totalCount,
			repostedCount: trustDobCorrectionJobs.repostedCount,
			failedCount: trustDobCorrectionJobs.failedCount,
			errorMessage: trustDobCorrectionJobs.errorMessage,
			newDob: trustDobCorrectionJobs.newDob,
			createdAt: trustDobCorrectionJobs.createdAt,
			completedAt: trustDobCorrectionJobs.completedAt,
		})
		.from(trustDobCorrectionJobs)
		.where(
			and(
				eq(trustDobCorrectionJobs.beneficiaryId, args.beneficiaryId),
				eq(trustDobCorrectionJobs.organizationId, orgId),
			),
		)
		.orderBy(desc(trustDobCorrectionJobs.createdAt))
		.limit(1);

	if (!row) return { ok: true, job: null };

	// Narrow the status string — schema is plain varchar so we coerce.
	const status = (['queued', 'running', 'completed', 'failed'] as const).includes(
		row.status as 'queued',
	)
		? (row.status as DobCorrectionJobStatus['status'])
		: 'failed';

	return {
		ok: true,
		job: {
			id: row.id,
			beneficiaryId: row.beneficiaryId,
			status,
			progress: row.progress,
			totalCount: row.totalCount,
			repostedCount: row.repostedCount,
			failedCount: row.failedCount,
			errorMessage: row.errorMessage,
			newDob: row.newDob,
			createdAt: row.createdAt,
			completedAt: row.completedAt,
		},
	};
	void inArray;
}
