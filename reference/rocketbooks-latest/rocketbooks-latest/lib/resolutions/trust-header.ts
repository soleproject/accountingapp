import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { trustMetadata } from '@/db/schema/schema';
import type { TrustHeader } from './types';

/**
 * Load the header data every template needs: trust name, governing
 * state, effective date, EIN, etc. Returns a TrustHeader with mostly-
 * null fields if the org hasn't filled out trust_metadata yet — the
 * caller decides whether that's a blocker (templates with
 * `requiresState: true` should be blocked at draft time until
 * `governingState` is populated).
 */
export async function loadTrustHeader(organizationId: string): Promise<TrustHeader> {
	const [meta] = await db
		.select({
			trustName: trustMetadata.trustName,
			effectiveDate: trustMetadata.effectiveDate,
			governingState: trustMetadata.governingState,
			situsState: trustMetadata.situsState,
			ein: trustMetadata.ein,
			grantorName: trustMetadata.grantorName,
			defaultSigningAuthority: trustMetadata.defaultSigningAuthority,
		})
		.from(trustMetadata)
		.where(eq(trustMetadata.organizationId, organizationId))
		.limit(1);

	const authority = meta?.defaultSigningAuthority;
	const narrowed: TrustHeader['defaultSigningAuthority'] =
		authority === 'sole' || authority === 'majority' || authority === 'unanimous'
			? authority
			: null;

	return {
		organizationId,
		trustName: meta?.trustName ?? null,
		effectiveDate: meta?.effectiveDate ?? null,
		governingState: meta?.governingState ?? null,
		situsState: meta?.situsState ?? null,
		ein: meta?.ein ?? null,
		grantorName: meta?.grantorName ?? null,
		defaultSigningAuthority: narrowed,
	};
}
