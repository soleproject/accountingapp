'use server';

import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	journalEntries,
	journalEntryLineTags,
	journalEntryLines,
	rentalProperties,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';

export interface LinkLineToPropertyResult {
	ok: boolean;
	error?: string;
}

/**
 * Resolve TRUST_DEFERRED_RENTAL_NET_NEEDED by tagging the 430 line with
 * a rental_property_id. No JE reversal — the spec wants only NET on 430
 * and the tag enables the per-property sub-ledger roll-up. Drops a
 * TRUST_RENTAL_LINKED_TO_PROPERTY audit on the same JE; dismisses the
 * original finding.
 */
export async function linkLineToProperty(args: {
	findingId: string;
	rentalPropertyId: string;
}): Promise<LinkLineToPropertyResult> {
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
	if (finding.code !== 'TRUST_DEFERRED_RENTAL_NET_NEEDED') {
		return { ok: false, error: 'linkLineToProperty only applies to RENTAL_NET findings' };
	}

	const meta = (finding.metadata ?? {}) as { accountId?: string };
	if (!meta.accountId) return { ok: false, error: 'Finding metadata missing accountId' };

	const [property] = await db
		.select({
			id: rentalProperties.id,
			displayName: rentalProperties.displayName,
		})
		.from(rentalProperties)
		.where(
			and(
				eq(rentalProperties.id, args.rentalPropertyId),
				eq(rentalProperties.organizationId, orgId),
			),
		)
		.limit(1);
	if (!property) return { ok: false, error: 'Rental property not in this organization' };

	const [je] = await db
		.select({ id: journalEntries.id })
		.from(journalEntries)
		.where(eq(journalEntries.id, finding.journalEntryId))
		.limit(1);
	if (!je) return { ok: false, error: 'JE not found' };

	try {
		await db.transaction(async (tx) => {
			// Tag every 430 line on this JE with the property. Multi-line
			// JEs (multiple 430 lines) get one tag each; in practice
			// this is one line. Uses the polymorphic tag store so the tag
			// shows up in rollups alongside any other rental-property
			// tags applied through the general TagsPanel flow.
			const lineIds = await tx
				.select({ id: journalEntryLines.id })
				.from(journalEntryLines)
				.where(
					and(
						eq(journalEntryLines.journalEntryId, je.id),
						eq(journalEntryLines.accountId, meta.accountId!),
					),
				);
			if (lineIds.length > 0) {
				const ids = lineIds.map((r) => r.id);
				// Clear any existing rental_property tag on these lines first
				// (upsert via delete+insert; UNIQUE on (line, entity_type)).
				await tx
					.delete(journalEntryLineTags)
					.where(
						and(
							eq(journalEntryLineTags.entityType, 'rental_property'),
							inArray(journalEntryLineTags.journalEntryLineId, ids),
						),
					);
				await tx.insert(journalEntryLineTags).values(
					ids.map((lineId) => ({
						id: randomUUID(),
						organizationId: orgId,
						journalEntryLineId: lineId,
						entityType: 'rental_property',
						entityId: property.id,
					})),
				);
			}

			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				organizationId: orgId,
				journalEntryId: je.id,
				code: 'TRUST_RENTAL_LINKED_TO_PROPERTY',
				severity: 'warn',
				message: `Linked to rental property "${property.displayName}". Per-property sub-ledger will roll up to confirm net.`,
				metadata: { rentalPropertyId: property.id, accountId: meta.accountId },
			});

			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: linked to "${property.displayName}".`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to link to property' };
	}

	revalidatePath('/trust-review');
	revalidatePath('/rental-properties');
	return { ok: true };
}
