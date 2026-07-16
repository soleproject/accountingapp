'use server';

import { randomUUID } from 'crypto';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import {
	journalEntries,
	journalEntryLines,
	trustBeneficiaries,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { evaluateBeneficialTrustJournalEntry } from '@/lib/accounting/rules/beneficial-trust';

const Schema = z.object({
	beneficiaryId: z.string().min(1),
	/** Desired NEW value of the live flag. */
	isIncapacitated: z.boolean(),
	/** Date the change takes effect (defaults to today). YYYY-MM-DD. */
	effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export interface UpdateBeneficiaryIncapacitationState {
	error?: string;
	ok?: boolean;
}

/**
 * Toggle a beneficiary's incapacitated status with point-in-time tracking.
 *
 * Maintains two effective-date columns alongside the live boolean:
 *   incapacitated_since      — most recent ON transition
 *   not_incapacitated_since  — most recent OFF transition after an ON
 *
 * When called with the SAME value as the current live flag → no-op
 * (returns ok without touching effective dates). When flipping → stamp
 * the matching column to effectiveDate and re-evaluate any open trust
 * findings whose JE dates straddle the transition, so the Trust Review
 * queue reflects the new state immediately.
 */
export async function updateBeneficiaryIncapacitation(
	_prev: UpdateBeneficiaryIncapacitationState | undefined,
	formData: FormData,
): Promise<UpdateBeneficiaryIncapacitationState | undefined> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const parsed = Schema.safeParse({
		beneficiaryId: formData.get('beneficiaryId'),
		isIncapacitated: formData.get('isIncapacitated') === 'on',
		effectiveDate: formData.get('effectiveDate'),
	});
	if (!parsed.success) {
		return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
	}

	const [bene] = await db
		.select({
			id: trustBeneficiaries.id,
			isIncapacitated: trustBeneficiaries.isIncapacitated,
			incapacitatedSince: trustBeneficiaries.incapacitatedSince,
			notIncapacitatedSince: trustBeneficiaries.notIncapacitatedSince,
		})
		.from(trustBeneficiaries)
		.where(
			and(
				eq(trustBeneficiaries.id, parsed.data.beneficiaryId),
				eq(trustBeneficiaries.organizationId, orgId),
			),
		)
		.limit(1);
	if (!bene) return { error: 'Beneficiary not found in this organization' };

	// No-op when nothing's changing. Avoids stamping spurious dates.
	if (bene.isIncapacitated === parsed.data.isIncapacitated) {
		return { ok: true };
	}

	if (parsed.data.isIncapacitated) {
		// Turning ON: stamp incapacitated_since, leave not_incapacitated_since alone
		// (a future recovery will overwrite it).
		await db
			.update(trustBeneficiaries)
			.set({
				isIncapacitated: true,
				incapacitatedSince: parsed.data.effectiveDate,
				notIncapacitatedSince: null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(trustBeneficiaries.id, bene.id));
	} else {
		// Turning OFF after having been ON: stamp not_incapacitated_since to mark
		// the recovery date. Leave incapacitated_since intact so historical
		// JEs in [incapacitated_since, not_incapacitated_since) still pass the
		// qualifying check.
		await db
			.update(trustBeneficiaries)
			.set({
				isIncapacitated: false,
				notIncapacitatedSince: parsed.data.effectiveDate,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(trustBeneficiaries.id, bene.id));
	}

	// Re-evaluate findings on JEs that this beneficiary is tagged on. The
	// transition might add or clear 815/820 qualifying findings (and the
	// REROUTED_TO_DEMAND_NOTE companions inserted by the categorize action
	// — those don't get touched here, just the rule-engine emitted codes).
	await reevaluateFindingsForBeneficiary(orgId, bene.id);

	revalidatePath('/trust-beneficiaries');
	revalidatePath(`/trust-beneficiaries/${bene.id}`);
	revalidatePath('/trust-review');
	return { ok: true };
}

const RULE_ENGINE_BENEFICIARY_CODES = new Set([
	'TRUST_815_NO_QUALIFYING_BENEFICIARY',
	'TRUST_815_WARN_VERIFY_BENEFICIARY',
	'TRUST_820_NO_QUALIFYING_BENEFICIARY',
	'TRUST_820_WARN_VERIFY_BENEFICIARY',
	'TRUST_BENEFICIARY_LINKAGE_REQUIRED',
	'TRUST_310_FLAG_K1_ISSUANCE',
	'TRUST_310_DEMAND_NOTE_NOT_EXHAUSTED',
	'TRUST_635_RECIPIENT_REQUIRED',
]);

async function reevaluateFindingsForBeneficiary(
	orgId: string,
	beneficiaryId: string,
): Promise<void> {
	const tagged = await db
		.selectDistinct({ id: journalEntryLines.journalEntryId })
		.from(journalEntryLines)
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.where(
			and(
				eq(journalEntries.organizationId, orgId),
				eq(journalEntryLines.beneficiaryId, beneficiaryId),
			),
		);
	if (tagged.length === 0) return;

	for (const { id: jeId } of tagged) {
		const [je] = await db
			.select({
				id: journalEntries.id,
				date: journalEntries.date,
				memo: journalEntries.memo,
				sourceType: journalEntries.sourceType,
				sourceId: journalEntries.sourceId,
			})
			.from(journalEntries)
			.where(eq(journalEntries.id, jeId))
			.limit(1);
		if (!je) continue;

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
			.where(eq(journalEntryLines.journalEntryId, jeId));

		const fresh = await evaluateBeneficialTrustJournalEntry({
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

		const freshByCode = new Map(fresh.findings.map((f) => [f.code, f]));

		await db.transaction(async (tx) => {
			const prior = await tx
				.select({
					id: trustReviewFindings.id,
					code: trustReviewFindings.code,
					dismissedAt: trustReviewFindings.dismissedAt,
					dismissedByUserId: trustReviewFindings.dismissedByUserId,
					dismissedNote: trustReviewFindings.dismissedNote,
				})
				.from(trustReviewFindings)
				.where(eq(trustReviewFindings.journalEntryId, jeId));

			// Only touch codes the rule engine controls — the categorize-action-
			// inserted REROUTED_TO_DEMAND_NOTE codes (and any other UI-action
			// codes) are managed by their own flows.
			const priorEngineCodes = prior.filter((p) => RULE_ENGINE_BENEFICIARY_CODES.has(p.code));
			const dismissedByCode = new Map(
				priorEngineCodes
					.filter((p) => p.dismissedAt)
					.map((p) => [
						p.code,
						{
							dismissedAt: p.dismissedAt,
							dismissedByUserId: p.dismissedByUserId,
							dismissedNote: p.dismissedNote,
						},
					]),
			);

			if (priorEngineCodes.length > 0) {
				await tx
					.delete(trustReviewFindings)
					.where(
						and(
							eq(trustReviewFindings.journalEntryId, jeId),
							inArray(
								trustReviewFindings.code,
								priorEngineCodes.map((p) => p.code),
							),
						),
					);
			}

			const newRows = [...freshByCode.entries()]
				.filter(([code]) => RULE_ENGINE_BENEFICIARY_CODES.has(code))
				.map(([, f]) => {
					const dismiss = dismissedByCode.get(f.code);
					return {
						id: randomUUID(),
						organizationId: orgId,
						journalEntryId: jeId,
						code: f.code,
						severity: f.severity,
						message: f.message,
						metadata: f.metadata ?? null,
						dismissedAt: dismiss?.dismissedAt ?? null,
						dismissedByUserId: dismiss?.dismissedByUserId ?? null,
						dismissedNote: dismiss?.dismissedNote ?? null,
					};
				});

			if (newRows.length > 0) {
				await tx.insert(trustReviewFindings).values(newRows);
			}
			// Suppress the unused-import warning when none of the inserts happen.
			void isNotNull;
		});
	}
}
