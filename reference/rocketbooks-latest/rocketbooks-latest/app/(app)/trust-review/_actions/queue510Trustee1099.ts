'use server';

import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	contacts,
	journalEntryLines,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';

export interface Queue510Trustee1099Result {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/**
 * Per-contact bulk action for TRUST_510_FLAG_1099_ISSUANCE. Sets each
 * finding's 510 line.contactId to the picked trustee (verifying the
 * contact carries the 'trustee' typeTag), drops a TRUST_510_1099_QUEUED
 * audit, dismisses. Year-end the CPA queries open
 * TRUST_510_1099_QUEUED findings to assemble the 1099-MISC batch.
 *
 * Source line on the JE is located by detail_type='trustee_compensation'.
 */
export async function queue510Trustee1099(args: {
	findingIds: string[];
	trusteeContactId: string;
}): Promise<Queue510Trustee1099Result> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();

	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	if (!args.trusteeContactId) {
		return { ok: false, processed: 0, failed: [], error: 'No trustee picked' };
	}

	const [trustee] = await db
		.select({ id: contacts.id, contactName: contacts.contactName, typeTags: contacts.typeTags })
		.from(contacts)
		.where(and(eq(contacts.id, args.trusteeContactId), eq(contacts.organizationId, orgId)))
		.limit(1);
	if (!trustee) {
		return { ok: false, processed: 0, failed: [], error: 'Trustee contact not in this organization' };
	}
	const tags = Array.isArray(trustee.typeTags)
		? (trustee.typeTags as unknown[]).filter((t): t is string => typeof t === 'string')
		: [];
	if (!tags.some((t) => t.toLowerCase() === 'trustee')) {
		return {
			ok: false, processed: 0, failed: [],
			error: 'Picked contact is not marked as a trustee. Mark them on their contact page first.',
		};
	}

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
			if (finding.code !== 'TRUST_510_FLAG_1099_ISSUANCE') {
				failed.push({ findingId, error: `Doesn't apply to ${finding.code}` });
				continue;
			}

			// Find the 510 line on the JE (detail_type='trustee_compensation').
			const lines = await db
				.select({ accountId: journalEntryLines.accountId })
				.from(journalEntryLines)
				.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
				.where(
					and(
						eq(journalEntryLines.journalEntryId, finding.journalEntryId),
						eq(chartOfAccounts.organizationId, orgId),
						eq(chartOfAccounts.detailType, 'trustee_compensation'),
					),
				);
			if (lines.length === 0) {
				failed.push({ findingId, error: 'No 510 (trustee_compensation) line on this JE' });
				continue;
			}
			const acctIds = Array.from(new Set(lines.map((l) => l.accountId)));

			await db.transaction(async (tx) => {
				await tx
					.update(journalEntryLines)
					.set({ contactId: trustee.id })
					.where(
						and(
							eq(journalEntryLines.journalEntryId, finding.journalEntryId),
							inArray(journalEntryLines.accountId, acctIds),
						),
					);

				await tx.insert(trustReviewFindings).values({
					id: randomUUID(),
					organizationId: orgId,
					journalEntryId: finding.journalEntryId,
					code: 'TRUST_510_1099_QUEUED',
					severity: 'warn',
					message: `510 line tagged to ${trustee.contactName} — queued for year-end 1099-MISC issuance.`,
					metadata: { trusteeContactId: trustee.id, trusteeName: trustee.contactName },
				});

				await tx
					.update(trustReviewFindings)
					.set({
						dismissedAt: new Date().toISOString(),
						dismissedByUserId: userId,
						dismissedNote: `Auto-dismissed: 510 line queued for 1099-MISC to ${trustee.contactName}.`,
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
