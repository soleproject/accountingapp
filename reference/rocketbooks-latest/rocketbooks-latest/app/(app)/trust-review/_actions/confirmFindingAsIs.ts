'use server';

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { trustReviewFindings } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import type { TrustFindingCode } from '@/lib/accounting/rules/beneficial-trust/types';

export interface ConfirmFindingAsIsResult {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/**
 * Generic "this is fine as-is" / "the warning is resolved externally"
 * action used by the icon framework's confirm-as-is paths:
 *
 *   ASSET_REPOST_REVIEW       → TRUST_ASSET_PURCHASE_CONFIRMED
 *   NON_TRUST_CATEGORY_USED   → TRUST_NON_TRUST_KEPT
 *   DEMAND_NOTE_MISSING_NOTE  → TRUST_DEMAND_NOTE_CONFIRMED
 *   DEFERRED_PERSONAL_USE_LEASE → TRUST_PERSONAL_USE_LEASE_CONFIGURED
 *   455_FLAG_K1_ISSUANCE      → TRUST_455_K1_ACKNOWLEDGED (parallel)
 *   DISPOSAL_WITH_OUTSTANDING_LOAN → one of three TRUST_DISPOSAL_LOAN_*
 *
 * Validates each finding has the expected applicable code, drops the
 * specified audit-trail code on the same JE, dismisses the originating
 * finding. No GL movement.
 */
export async function confirmFindingAsIs(args: {
	findingIds: string[];
	applicableCodes: readonly string[];
	auditCode: TrustFindingCode;
	auditMessage: string;
}): Promise<ConfirmFindingAsIsResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();

	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	const codeSet = new Set(args.applicableCodes);
	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;

	for (const findingId of args.findingIds) {
		try {
			const [finding] = await db
				.select({
					id: trustReviewFindings.id,
					code: trustReviewFindings.code,
					organizationId: trustReviewFindings.organizationId,
					journalEntryId: trustReviewFindings.journalEntryId,
				})
				.from(trustReviewFindings)
				.where(eq(trustReviewFindings.id, findingId))
				.limit(1);
			if (!finding) { failed.push({ findingId, error: 'Finding not found' }); continue; }
			if (finding.organizationId !== orgId) { failed.push({ findingId, error: 'Not authorized' }); continue; }
			if (!codeSet.has(finding.code)) {
				failed.push({ findingId, error: `Doesn't apply to ${finding.code}` });
				continue;
			}

			await db.transaction(async (tx) => {
				await tx.insert(trustReviewFindings).values({
					id: randomUUID(),
					organizationId: orgId,
					journalEntryId: finding.journalEntryId,
					code: args.auditCode,
					severity: 'warn',
					message: args.auditMessage,
					metadata: {},
				});
				await tx
					.update(trustReviewFindings)
					.set({
						dismissedAt: new Date().toISOString(),
						dismissedByUserId: userId,
						dismissedNote: `Auto-dismissed: ${args.auditMessage}`,
						updatedAt: new Date().toISOString(),
					})
					.where(eq(trustReviewFindings.id, finding.id));
			});
			processed += 1;
		} catch (err) {
			failed.push({ findingId, error: err instanceof Error ? err.message : String(err) });
		}
	}

	revalidatePath('/trust-review');
	return { ok: failed.length === 0, processed, failed };
}
