'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { trustReviewFindings } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { voidLinkedDocsForSource } from '@/lib/resolutions/void-on-source-change';
import { logger } from '@/lib/logger';

/**
 * Finding codes that, when dismissed, must cascade-void any document
 * auto-drafted from them. Keeps the documentation pipeline truthful
 * — if the underlying decision is reversed, the doc that formalized
 * it shouldn't stick around as if still authoritative.
 *
 *   TRUST_DEPOSIT_CLASSIFIED_AS_CORPUS  → linked Bill of Sale
 *   TRUST_DEPOSIT_SPLIT_CORPUS_AND_INCOME → linked Bill of Sale
 *   TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_CORPUS → linked CG memo
 */
const CORPUS_DOC_TRIGGER_CODES = new Set<string>([
	'TRUST_DEPOSIT_CLASSIFIED_AS_CORPUS',
	'TRUST_DEPOSIT_SPLIT_CORPUS_AND_INCOME',
	'TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_CORPUS',
]);

export interface DismissResult {
	ok: boolean;
	error?: string;
}

/**
 * Mark a trust-review finding as dismissed. Org-scoped: the finding must
 * belong to the current org. Idempotent — re-dismissing a dismissed
 * finding is a no-op.
 */
export async function dismissTrustReviewFinding(args: {
	findingId: string;
	note?: string;
}): Promise<DismissResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();

	// Read the code before dismissing so we know whether to cascade.
	const [pre] = await db
		.select({ code: trustReviewFindings.code })
		.from(trustReviewFindings)
		.where(
			and(
				eq(trustReviewFindings.id, args.findingId),
				eq(trustReviewFindings.organizationId, orgId),
			),
		)
		.limit(1);

	const result = await db
		.update(trustReviewFindings)
		.set({
			dismissedAt: new Date().toISOString(),
			dismissedByUserId: userId,
			dismissedNote: args.note?.trim() || null,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(trustReviewFindings.id, args.findingId),
				eq(trustReviewFindings.organizationId, orgId),
			),
		)
		.returning({ id: trustReviewFindings.id });

	if (result.length === 0) {
		return { ok: false, error: 'Finding not found in this organization' };
	}

	// Cascade: dismissing a corpus-classification audit means the
	// decision is being reversed; the auto-drafted Bill of Sale that
	// formalized that decision should be voided so it doesn't stick
	// around as if still authoritative. Non-fatal — a void failure
	// shouldn't roll back the dismiss.
	if (pre?.code && CORPUS_DOC_TRIGGER_CODES.has(pre.code)) {
		try {
			await voidLinkedDocsForSource({
				organizationId: orgId,
				sourceKind: 'deposit_finding',
				sourceId: args.findingId,
				reason: `Source finding (${pre.code}) dismissed`,
			});
		} catch (err) {
			logger.warn(
				{ findingId: args.findingId, err: err instanceof Error ? err.message : err },
				'cascade void failed after finding dismiss (non-fatal)',
			);
		}
	}

	revalidatePath('/trust-review');
	revalidatePath('/trust-documents');
	return { ok: true };
}

/**
 * Re-open a previously dismissed finding (clears dismissed_at). Useful for
 * "undo dismiss" UX.
 */
export async function undismissTrustReviewFinding(findingId: string): Promise<DismissResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const result = await db
		.update(trustReviewFindings)
		.set({
			dismissedAt: null,
			dismissedByUserId: null,
			dismissedNote: null,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(trustReviewFindings.id, findingId),
				eq(trustReviewFindings.organizationId, orgId),
			),
		)
		.returning({ id: trustReviewFindings.id });

	if (result.length === 0) {
		return { ok: false, error: 'Finding not found in this organization' };
	}

	revalidatePath('/trust-review');
	return { ok: true };
}
