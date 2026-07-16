'use server';

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	journalEntries,
	journalEntryLines,
	trustBeneficiaries,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';

export interface QueueK1DraftResult {
	ok: boolean;
	error?: string;
}

/**
 * Resolve a TRUST_310_FLAG_K1_ISSUANCE finding by queueing a K-1 draft
 * for the CPA. Minimal MVP: emits a TRUST_310_K1_QUEUED audit on the
 * same JE with full bene + amount metadata, dismisses the original
 * finding. CPA can query open TRUST_310_K1_QUEUED rows at year-end to
 * assemble the K-1 batch.
 *
 * Dedicated K-1 wizard page + k1_drafts table are deferred — this
 * action gets the finding moving Open → Decisioned without blocking
 * on that infrastructure.
 */
export async function queueK1Draft(args: {
	findingId: string;
}): Promise<QueueK1DraftResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();

	const [finding] = await db
		.select({
			id: trustReviewFindings.id,
			code: trustReviewFindings.code,
			organizationId: trustReviewFindings.organizationId,
			journalEntryId: trustReviewFindings.journalEntryId,
			metadata: trustReviewFindings.metadata,
		})
		.from(trustReviewFindings)
		.where(eq(trustReviewFindings.id, args.findingId))
		.limit(1);
	if (!finding) return { ok: false, error: 'Finding not found' };
	if (finding.organizationId !== orgId) return { ok: false, error: 'Not authorized' };
	if (finding.code !== 'TRUST_310_FLAG_K1_ISSUANCE') {
		return { ok: false, error: 'queueK1Draft only applies to TRUST_310_FLAG_K1_ISSUANCE' };
	}

	const meta = (finding.metadata ?? {}) as { beneficiaryId?: string; accountId?: string };
	if (!meta.beneficiaryId) {
		return { ok: false, error: 'Finding has no beneficiaryId — tag the beneficiary on the 310 line first.' };
	}

	const [bene] = await db
		.select({ id: trustBeneficiaries.id, fullName: trustBeneficiaries.fullName })
		.from(trustBeneficiaries)
		.where(eq(trustBeneficiaries.id, meta.beneficiaryId))
		.limit(1);
	if (!bene) return { ok: false, error: 'Beneficiary not found' };

	// Pull the 310 amount off the JE so the audit row has it inline.
	const [je] = await db
		.select({ date: journalEntries.date })
		.from(journalEntries)
		.where(eq(journalEntries.id, finding.journalEntryId))
		.limit(1);
	const taxYear = je?.date ? Number(je.date.slice(0, 4)) : new Date().getUTCFullYear();

	let distAmount = 0;
	if (meta.accountId) {
		const lines = await db
			.select({ debit: journalEntryLines.debit })
			.from(journalEntryLines)
			.where(eq(journalEntryLines.journalEntryId, finding.journalEntryId));
		distAmount = lines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
	}

	try {
		await db.transaction(async (tx) => {
			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				organizationId: orgId,
				journalEntryId: finding.journalEntryId,
				code: 'TRUST_310_K1_QUEUED',
				severity: 'warn',
				message: `K-1 queued for ${bene.fullName} — tax year ${taxYear}${distAmount > 0 ? `, distribution $${distAmount.toFixed(2)}` : ''}. CPA: assemble at year-end from all open TRUST_310_K1_QUEUED rows for this org.`,
				metadata: {
					beneficiaryId: bene.id,
					beneficiaryName: bene.fullName,
					taxYear,
					distributionAmount: distAmount,
					sourceJournalEntryId: finding.journalEntryId,
				},
			});

			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: K-1 queued for ${bene.fullName} (tax year ${taxYear}).`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to queue K-1' };
	}

	revalidatePath('/trust-review');
	return { ok: true };
}
