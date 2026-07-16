'use server';

import { randomUUID } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	contacts,
	journalEntries,
	journalEntryLines,
	transactions,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { createJournalEntry, reverseJournalEntry } from '@/lib/accounting/posting';
import {
	resolve815Or820Context,
	resolveTrust710Account,
} from '@/lib/accounting/trust-food-clothing-reroute';
import { isTrust815TrusteeActionableCode } from '@/lib/accounting/trust-food-clothing-codes';
import { build710TrusteeAttributionFinding } from '@/lib/accounting/trust-710-reroute';

export interface Reroute815ToTrusteeResult {
	ok: boolean;
	newJournalEntryId?: string;
	error?: string;
}

/**
 * Re-attribute a 815 (food) line to a trustee — recovery path for "user
 * said this was for a beneficiary, but it was actually a trustee meal".
 *
 * Reverses the current JE (line may be on 815 itself OR on a 26x demand
 * note if the bene didn't qualify) and reposts on 710 Meals &
 * Entertainment with the trustee's contactId set and the beneficiary tag
 * cleared — the end state matches what would have posted if the user had
 * categorized this as 710 from the start.
 *
 * Inserts a TRUST_710_ATTRIBUTED_TO_TRUSTEE audit on the new JE; dismisses
 * every still-open finding on the reversed JE.
 *
 * 815-only: clothing-to-trustee makes no narrative sense, so the 4 × 820
 * codes are NOT in TRUST_815_TRUSTEE_ACTIONABLE_CODES.
 */
export async function reroute815ToTrustee(args: {
	findingId: string;
	contactId: string;
}): Promise<Reroute815ToTrusteeResult> {
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
	if (!isTrust815TrusteeActionableCode(finding.code)) {
		return {
			ok: false,
			error: `Trustee re-attribution doesn't apply to ${finding.code} findings`,
		};
	}

	const [contact] = await db
		.select({
			id: contacts.id,
			contactName: contacts.contactName,
			typeTags: contacts.typeTags,
		})
		.from(contacts)
		.where(
			and(eq(contacts.id, args.contactId), eq(contacts.organizationId, orgId)),
		)
		.limit(1);
	if (!contact) return { ok: false, error: 'Contact not in this organization' };
	const tags = Array.isArray(contact.typeTags) ? contact.typeTags : [];
	const isTrustee = tags.some(
		(t) => typeof t === 'string' && t.toLowerCase() === 'trustee',
	);
	if (!isTrustee) {
		return {
			ok: false,
			error: 'Contact is not marked as a trustee. Mark them as a trustee on their contact page first.',
		};
	}

	const ctx = await resolve815Or820Context({
		organizationId: orgId,
		code: finding.code,
		metadata: finding.metadata,
		journalEntryId: finding.journalEntryId,
	});
	if (!ctx.ok) return { ok: false, error: ctx.error };

	const meals = await resolveTrust710Account(orgId);
	if (!meals.ok) return { ok: false, error: meals.error };

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

	const sourceLines = lines.filter((l) => l.accountId === ctx.sourceAccountId);
	const otherLines = lines.filter((l) => l.accountId !== ctx.sourceAccountId);
	if (sourceLines.length === 0) {
		return { ok: false, error: 'No matching line found on this JE — nothing to re-attribute' };
	}
	const totalDebit = sourceLines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
	if (totalDebit <= 0) {
		return { ok: false, error: 'Line has no positive debit amount to re-attribute' };
	}
	const sharedMemo = sourceLines[0]?.memo ?? null;

	let newJeId: string | null = null;
	try {
		await db.transaction(async (tx) => {
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — 815 line re-attributed to trustee ${contact.contactName} (admin meal on 710)`,
				},
				tx,
			);

			const newCategoryLine = {
				accountId: meals.accountId,
				debit: totalDebit,
				credit: 0,
				contactId: args.contactId,
				memo: sharedMemo,
				beneficiaryId: null,
			};
			const carryoverLines = otherLines.map((l) => ({
				accountId: l.accountId,
				debit: Number(l.debit ?? 0),
				credit: Number(l.credit ?? 0),
				contactId: l.contactId,
				memo: l.memo,
				beneficiaryId: l.beneficiaryId ?? null,
			}));

			const newJe = await createJournalEntry(
				{
					organizationId: orgId,
					date: je.date,
					memo: je.memo,
					posted: true,
					sourceType: je.sourceType,
					sourceId: je.sourceId,
					lines: [newCategoryLine, ...carryoverLines],
				},
				tx,
			);
			newJeId = newJe.id;

			if (je.sourceType === 'transaction' && je.sourceId) {
				await tx
					.update(transactions)
					.set({ journalEntryId: newJe.id, categoryAccountId: meals.accountId })
					.where(
						and(
							eq(transactions.id, je.sourceId),
							eq(transactions.organizationId, orgId),
						),
					);
			}

			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				...build710TrusteeAttributionFinding({
					organizationId: orgId,
					journalEntryId: newJe.id,
					accountId: meals.accountId,
					accountNumber: meals.accountNumber,
					accountName: meals.accountName,
					trusteeLabel: contact.contactName,
					trusteeCount: 1,
					amount: totalDebit,
				}),
			});

			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: 815 line re-attributed to trustee ${contact.contactName}; reposted on 710. See JE ${newJe.id.slice(0, 8)}.`,
					updatedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(trustReviewFindings.journalEntryId, finding.journalEntryId),
						isNull(trustReviewFindings.dismissedAt),
					),
				);
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to re-attribute' };
	}

	revalidatePath('/trust-review');
	revalidatePath('/trust-beneficiaries');
	return { ok: true, newJournalEntryId: newJeId ?? undefined };
}
