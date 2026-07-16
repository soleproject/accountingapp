'use server';

import { z } from 'zod';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import {
	previewDobCorrection,
	type DobCorrectionDiff,
} from '@/lib/accounting/trust-dob-correction';

const Schema = z.object({
	beneficiaryId: z.string().min(1),
	newDob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export interface PreviewDobChangeResult {
	ok: boolean;
	diff?: DobCorrectionDiff;
	error?: string;
}

/**
 * Server-action wrapper around previewDobCorrection. Stateless — returns
 * the diff to the client so the modal can render it and the user can
 * confirm before any DB writes happen.
 */
export async function previewBeneficiaryDobChange(
	args: { beneficiaryId: string; newDob: string },
): Promise<PreviewDobChangeResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const parsed = Schema.safeParse(args);
	if (!parsed.success) {
		return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
	}
	try {
		const diff = await previewDobCorrection({
			organizationId: orgId,
			beneficiaryId: parsed.data.beneficiaryId,
			newDob: parsed.data.newDob,
		});
		return { ok: true, diff };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : 'Failed to compute preview',
		};
	}
}
