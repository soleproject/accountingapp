'use server';

import { randomUUID } from 'crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	trustReviewFindings,
	trustBeneficiaries,
	journalEntries,
	journalEntryLines,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { evaluateBeneficialTrustJournalEntry } from '@/lib/accounting/rules/beneficial-trust';
import type { TrustFindingCode } from '@/lib/accounting/rules/beneficial-trust/types';

/** Maps the originating open code to the audit code that should land in
 *  Decisioned once the tag clears it. Tag-only resolutions otherwise
 *  vanish silently — this keeps every "decision" visible. */
const TAG_AUDIT_CODE_BY_ORIGIN: Partial<Record<TrustFindingCode, TrustFindingCode>> = {
	TRUST_BENEFICIARY_LINKAGE_REQUIRED: 'TRUST_BENEFICIARY_TAGGED',
	TRUST_815_NO_QUALIFYING_BENEFICIARY: 'TRUST_815_BENE_CONFIRMED_QUALIFYING',
	TRUST_820_NO_QUALIFYING_BENEFICIARY: 'TRUST_820_BENE_CONFIRMED_QUALIFYING',
	TRUST_635_RECIPIENT_REQUIRED: 'TRUST_635_RECIPIENT_TAGGED',
};

export interface TagResult {
	ok: boolean;
	error?: string;
}

/**
 * Tag the per-beneficiary line of a JE with a specific beneficiary, then
 * re-evaluate the JE's trust rules and refresh its findings.
 *
 * Used by the Trust Review queue's inline beneficiary picker — surfaces on
 * rows flagged TRUST_BENEFICIARY_LINKAGE_REQUIRED. The user picks the
 * beneficiary, the action:
 *
 *   1. Updates journal_entry_lines.beneficiary_id on the line that matches
 *      the finding's metadata.accountId (the line that triggered the rule).
 *   2. Re-runs evaluateBeneficialTrustJournalEntry against the now-tagged JE.
 *   3. Snapshots prior dismissed state per (je_id, code) — so existing
 *      dismissals on unrelated codes survive the refresh.
 *   4. Deletes ALL findings for this JE and re-inserts whatever the
 *      evaluator now returns, re-applying dismissed marks by code.
 *
 * Idempotent — re-running with the same beneficiary is a no-op for the
 * line update, and just re-derives findings from current state.
 */
export async function tagFindingBeneficiary(args: {
	findingId: string;
	beneficiaryId: string;
}): Promise<TagResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	// 1. Load finding (verify scope + extract context)
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
	const originCode = finding.code as TrustFindingCode;
	const auditCode = TAG_AUDIT_CODE_BY_ORIGIN[originCode];

	// 2. Verify beneficiary belongs to this org
	const [bene] = await db
		.select({ id: trustBeneficiaries.id, fullName: trustBeneficiaries.fullName })
		.from(trustBeneficiaries)
		.where(
			and(
				eq(trustBeneficiaries.id, args.beneficiaryId),
				eq(trustBeneficiaries.organizationId, orgId),
			),
		)
		.limit(1);
	if (!bene) return { ok: false, error: 'Beneficiary not found in this org' };

	const meta = (finding.metadata ?? {}) as { accountId?: string; accountNumber?: string };
	if (!meta.accountId) {
		return { ok: false, error: 'Finding has no accountId metadata — cannot locate the line' };
	}

	// 3. Tag the line(s) that hit this account on the JE
	await db
		.update(journalEntryLines)
		.set({ beneficiaryId: args.beneficiaryId })
		.where(
			and(
				eq(journalEntryLines.journalEntryId, finding.journalEntryId),
				eq(journalEntryLines.accountId, meta.accountId),
			),
		);

	// 4. Re-run evaluator against current state (now with the tag)
	const [je] = await db
		.select({
			id: journalEntries.id,
			date: journalEntries.date,
			memo: journalEntries.memo,
			sourceType: journalEntries.sourceType,
			sourceId: journalEntries.sourceId,
		})
		.from(journalEntries)
		.where(eq(journalEntries.id, finding.journalEntryId))
		.limit(1);
	if (!je) return { ok: false, error: 'JE not found' };

	const lines = await db
		.select({
			accountId: journalEntryLines.accountId,
			debit: journalEntryLines.debit,
			credit: journalEntryLines.credit,
			contactId: journalEntryLines.contactId,
			memo: journalEntryLines.memo,
			beneficiaryId: journalEntryLines.beneficiaryId,
		})
		.from(journalEntryLines)
		.where(eq(journalEntryLines.journalEntryId, je.id));

	const result = await evaluateBeneficialTrustJournalEntry({
		organizationId: orgId,
		date: je.date,
		memo: je.memo,
		sourceType: je.sourceType,
		sourceId: je.sourceId,
		lines: lines.map((l) => ({
			accountId: l.accountId,
			debit: Number(l.debit),
			credit: Number(l.credit),
			contactId: l.contactId,
			memo: l.memo,
			beneficiaryId: l.beneficiaryId ?? null,
		})),
	});

	// 5. Refresh findings rows: snapshot dismissed state by code, delete all
	//    for the JE, insert new from evaluator, re-apply dismissed marks
	//    when a finding of the same code returns.
	await db.transaction(async (tx) => {
		const priorDismissed = await tx
			.select({
				code: trustReviewFindings.code,
				dismissedAt: trustReviewFindings.dismissedAt,
				dismissedByUserId: trustReviewFindings.dismissedByUserId,
				dismissedNote: trustReviewFindings.dismissedNote,
			})
			.from(trustReviewFindings)
			.where(
				and(
					eq(trustReviewFindings.journalEntryId, je.id),
					isNotNull(trustReviewFindings.dismissedAt),
				),
			);
		const dismissedByCode = new Map(priorDismissed.map((d) => [d.code, d]));

		await tx
			.delete(trustReviewFindings)
			.where(eq(trustReviewFindings.journalEntryId, je.id));

		const newFindingRows = result.findings.map((f) => {
			const dismiss = dismissedByCode.get(f.code);
			return {
				id: randomUUID(),
				organizationId: orgId,
				journalEntryId: je.id,
				code: f.code,
				severity: f.severity,
				message: f.message,
				metadata: f.metadata ?? null,
				dismissedAt: dismiss?.dismissedAt ?? null,
				dismissedByUserId: dismiss?.dismissedByUserId ?? null,
				dismissedNote: dismiss?.dismissedNote ?? null,
			};
		});

		// If the originating code cleared (no longer present in the new
		// findings), drop a Decisioned audit so the action leaves a visible
		// trail instead of silently vanishing.
		const stillFiring = result.findings.some((f) => f.code === originCode);
		if (auditCode && !stillFiring) {
			newFindingRows.push({
				id: randomUUID(),
				organizationId: orgId,
				journalEntryId: je.id,
				code: auditCode,
				severity: 'warn',
				message: `Tagged ${bene.fullName} on the line — cleared ${originCode}.`,
				metadata: { beneficiaryId: bene.id, originCode },
				dismissedAt: null,
				dismissedByUserId: null,
				dismissedNote: null,
			});
		}

		if (newFindingRows.length > 0) {
			await tx.insert(trustReviewFindings).values(newFindingRows);
		}
	});

	revalidatePath('/trust-review');
	return { ok: true };
}
