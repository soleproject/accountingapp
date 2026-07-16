'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { chartOfAccounts, trustBeneficiaries } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';

const Schema = z.object({
	beneficiaryId: z.string().min(1),
	fullName: z.string().min(1).max(200),
	/** Optional — accept empty string for "clear". YYYY-MM-DD. */
	dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
	relationship: z.string().max(80).optional().or(z.literal('')),
});

export interface UpdateBeneficiaryState {
	error?: string;
	ok?: boolean;
}

/**
 * Edit a beneficiary's display fields. Does NOT touch:
 *   - isIncapacitated + the two effective-date columns
 *     (use updateBeneficiaryIncapacitation — that path also re-evaluates
 *      findings)
 *   - demandNoteAccountId (system-managed via seedBeneficiaryDemandNotes)
 *
 * Also renames the associated `${fullName} - Demand Note` account when
 * fullName changes so the COA stays consistent with the beneficiary's
 * name. Skipped if the beneficiary has no demand-note account yet.
 */
export async function updateBeneficiary(
	_prev: UpdateBeneficiaryState | undefined,
	formData: FormData,
): Promise<UpdateBeneficiaryState | undefined> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const parsed = Schema.safeParse({
		beneficiaryId: formData.get('beneficiaryId'),
		fullName: formData.get('fullName'),
		dateOfBirth: formData.get('dateOfBirth') ?? '',
		relationship: formData.get('relationship') ?? '',
	});
	if (!parsed.success) {
		return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
	}

	const [bene] = await db
		.select({
			id: trustBeneficiaries.id,
			fullName: trustBeneficiaries.fullName,
			demandNoteAccountId: trustBeneficiaries.demandNoteAccountId,
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

	const newName = parsed.data.fullName.trim();
	const nameChanged = newName !== bene.fullName;

	await db.transaction(async (tx) => {
		await tx
			.update(trustBeneficiaries)
			.set({
				fullName: newName,
				dateOfBirth: parsed.data.dateOfBirth || null,
				relationship: parsed.data.relationship?.trim() || null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(trustBeneficiaries.id, bene.id));

		// Keep the demand-note account name aligned with the beneficiary's
		// display name so the GL doesn't drift ("John Doe - Demand Note" stays
		// matched).
		if (nameChanged && bene.demandNoteAccountId) {
			await tx
				.update(chartOfAccounts)
				.set({ accountName: `${newName} - Demand Note` })
				.where(
					and(
						eq(chartOfAccounts.id, bene.demandNoteAccountId),
						eq(chartOfAccounts.organizationId, orgId),
					),
				);
		}
	});

	revalidatePath('/trust-beneficiaries');
	revalidatePath(`/trust-beneficiaries/${bene.id}`);
	return { ok: true };
}
