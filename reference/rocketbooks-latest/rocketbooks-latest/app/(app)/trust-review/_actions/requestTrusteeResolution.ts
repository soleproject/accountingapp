'use server';

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { trustReviewFindings } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';

/**
 * Document types the Trust Documentation module (Phase 1+) generates.
 * The trust-docs worker queries open TRUST_DOCUMENTATION_REQUESTED
 * findings and routes them by `documentType` in metadata.
 *
 * Keep in sync with the trust-docs template registry as new templates
 * land. Today: personal_use_lease is the only one Trust Review surfaces.
 */
export type TrustDocumentType =
	| 'personal_use_lease' // Trustee Personal Use Lease Agreement ($300–500/mo)
	| 'mileage_log' // Periodic mileage log for shared-use vehicles
	| 'tax_receipt_verification'; // 501(c)(3) acknowledgment letter capture

export interface RequestTrusteeResolutionResult {
	ok: boolean;
	error?: string;
}

/**
 * Move a Trust Review finding into the Trust Documentation queue. Emits
 * a TRUST_DOCUMENTATION_REQUESTED audit on the same JE — the trust-docs
 * pipeline (Phase 1+) picks it up by code + documentType in metadata,
 * generates the resolution / template, and stores the output in the
 * document_records table. Dismisses the original finding so Trust
 * Review reflects "we asked for the doc".
 *
 * Cross-module contract: the trust-docs worker should READ the open
 * TRUST_DOCUMENTATION_REQUESTED rows and WRITE its own dismiss/audit
 * back when the doc is generated; nothing in trust-review depends on
 * that follow-up, so the queue functions even if trust-docs isn't
 * running yet.
 */
export async function requestTrusteeResolution(args: {
	findingId: string;
	documentType: TrustDocumentType;
}): Promise<RequestTrusteeResolutionResult> {
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

	try {
		await db.transaction(async (tx) => {
			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				organizationId: orgId,
				journalEntryId: finding.journalEntryId,
				code: 'TRUST_DOCUMENTATION_REQUESTED',
				severity: 'warn',
				message: `Trustee resolution / documentation requested: ${labelForDocumentType(args.documentType)}. Trust Documentation will generate the template.`,
				metadata: {
					documentType: args.documentType,
					originatingFindingCode: finding.code,
					originatingFindingId: finding.id,
					// Pass through any original metadata so the trust-docs
					// pipeline has the context the rule captured.
					originatingMetadata: finding.metadata ?? null,
				},
			});
			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: ${labelForDocumentType(args.documentType)} requested from Trust Documentation.`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to request resolution' };
	}

	revalidatePath('/trust-review');
	// Trust-docs page will list these once it ships; revalidate
	// preemptively so a same-session round-trip is fresh.
	revalidatePath('/trust-documents');
	return { ok: true };
}

function labelForDocumentType(t: TrustDocumentType): string {
	switch (t) {
		case 'personal_use_lease':
			return 'Trustee Personal Use Lease Agreement';
		case 'mileage_log':
			return 'Mileage log';
		case 'tax_receipt_verification':
			return '501(c)(3) verification + acknowledgment letter';
	}
}
