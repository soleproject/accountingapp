'use server';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { trustReviewFindings } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { voidLinkedDocsForSource } from '@/lib/resolutions/void-on-source-change';
import { logger } from '@/lib/logger';

const CORPUS_DOC_TRIGGER_CODES = new Set<string>([
	'TRUST_DEPOSIT_CLASSIFIED_AS_CORPUS',
	'TRUST_DEPOSIT_SPLIT_CORPUS_AND_INCOME',
	'TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_CORPUS',
]);

export interface BulkDismissResult {
	ok: boolean;
	dismissed?: number;
	error?: string;
}

/**
 * Mark every supplied finding as dismissed in one UPDATE. Org-scoped:
 * findings outside the current org are silently skipped. Idempotent on
 * already-dismissed rows (the WHERE filters them out so the returned
 * count reflects only fresh dismissals).
 */
export async function bulkDismissFindings(args: {
	findingIds: string[];
	note?: string;
}): Promise<BulkDismissResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();

	const ids = Array.from(new Set(args.findingIds.filter((id) => typeof id === 'string' && id.length > 0)));
	if (ids.length === 0) return { ok: true, dismissed: 0 };

	// Snapshot the codes of the rows we're about to dismiss so we
	// know which ones cascade-void linked Bills of Sale below.
	const preDismiss = await db
		.select({ id: trustReviewFindings.id, code: trustReviewFindings.code })
		.from(trustReviewFindings)
		.where(
			and(
				eq(trustReviewFindings.organizationId, orgId),
				inArray(trustReviewFindings.id, ids),
				isNull(trustReviewFindings.dismissedAt),
			),
		);
	const corpusTriggerIds = preDismiss
		.filter((r) => CORPUS_DOC_TRIGGER_CODES.has(r.code))
		.map((r) => r.id);

	const now = new Date().toISOString();
	const result = await db
		.update(trustReviewFindings)
		.set({
			dismissedAt: now,
			dismissedByUserId: userId,
			dismissedNote: args.note?.trim() || null,
			updatedAt: now,
		})
		.where(
			and(
				eq(trustReviewFindings.organizationId, orgId),
				inArray(trustReviewFindings.id, ids),
				isNull(trustReviewFindings.dismissedAt),
			),
		)
		.returning({ id: trustReviewFindings.id });

	// Cascade: void each linked Bill of Sale. Non-fatal — a void
	// hiccup shouldn't undo the dismiss the user just confirmed.
	for (const id of corpusTriggerIds) {
		try {
			await voidLinkedDocsForSource({
				organizationId: orgId,
				sourceKind: 'deposit_finding',
				sourceId: id,
				reason: 'Source finding bulk-dismissed',
			});
		} catch (err) {
			logger.warn(
				{ findingId: id, err: err instanceof Error ? err.message : err },
				'cascade void failed after bulk dismiss (non-fatal)',
			);
		}
	}

	revalidatePath('/trust-review');
	if (corpusTriggerIds.length > 0) revalidatePath('/trust-documents');
	return { ok: true, dismissed: result.length };
}
