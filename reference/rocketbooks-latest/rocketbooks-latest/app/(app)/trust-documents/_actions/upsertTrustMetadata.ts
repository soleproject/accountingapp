'use server';

import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { trustMetadata } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';

const Schema = z.object({
	trustName: z.string().optional().nullable(),
	effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
	governingState: z.string().optional().nullable(),
	situsState: z.string().optional().nullable(),
	ein: z.string().optional().nullable(),
	fiscalYearEnd: z.string().regex(/^\d{2}-\d{2}$/).optional().nullable(),
	grantorName: z.string().optional().nullable(),
	defaultSigningAuthority: z.enum(['sole', 'majority', 'unanimous']).optional().nullable(),
});

export interface UpsertTrustMetadataResult {
	ok: boolean;
	error?: string;
}

/**
 * Upsert the trust_metadata row for the current org. Called by the
 * lazy-prompt that appears the first time a user drafts a doc whose
 * template needs trust-level fields (governing state, trust name,
 * etc.). Writes are partial-friendly — any null/omitted field leaves
 * the existing value alone.
 */
export async function upsertTrustMetadata(
	args: z.input<typeof Schema>,
): Promise<UpsertTrustMetadataResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const parsed = Schema.safeParse(args);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return { ok: false, error: `${first?.path.join('.') ?? '(root)'} — ${first?.message ?? 'invalid'}` };
	}

	const now = new Date().toISOString();
	const data = parsed.data;
	// Build the SET clause manually so we only overwrite fields the
	// caller actually sent. COALESCE(EXCLUDED.x, trust_metadata.x)
	// keeps existing values when the new value is NULL.
	await db
		.insert(trustMetadata)
		.values({
			organizationId: orgId,
			trustName: data.trustName ?? null,
			effectiveDate: data.effectiveDate ?? null,
			governingState: data.governingState ?? null,
			situsState: data.situsState ?? null,
			ein: data.ein ?? null,
			fiscalYearEnd: data.fiscalYearEnd ?? null,
			grantorName: data.grantorName ?? null,
			defaultSigningAuthority: data.defaultSigningAuthority ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: trustMetadata.organizationId,
			set: {
				trustName: sql`COALESCE(EXCLUDED.trust_name, ${trustMetadata.trustName})`,
				effectiveDate: sql`COALESCE(EXCLUDED.effective_date, ${trustMetadata.effectiveDate})`,
				governingState: sql`COALESCE(EXCLUDED.governing_state, ${trustMetadata.governingState})`,
				situsState: sql`COALESCE(EXCLUDED.situs_state, ${trustMetadata.situsState})`,
				ein: sql`COALESCE(EXCLUDED.ein, ${trustMetadata.ein})`,
				fiscalYearEnd: sql`COALESCE(EXCLUDED.fiscal_year_end, ${trustMetadata.fiscalYearEnd})`,
				grantorName: sql`COALESCE(EXCLUDED.grantor_name, ${trustMetadata.grantorName})`,
				defaultSigningAuthority: sql`COALESCE(EXCLUDED.default_signing_authority, ${trustMetadata.defaultSigningAuthority})`,
				updatedAt: now,
			},
		});

	revalidatePath('/trust-documents');
	void eq;
	return { ok: true };
}
