'use server';

import { randomUUID } from 'crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	chartOfAccounts,
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
	resolve710Context,
	build710TrusteeAttributionFinding,
} from '@/lib/accounting/trust-710-reroute';
import { splitAmountEvenly } from './split-utils';

export interface Split710Result {
	ok: boolean;
	newJournalEntryId?: string;
	error?: string;
}

/**
 * Reverse the JE referenced by a Trust Review finding and repost it with
 * the 710 (Meals & Entertainment) debit line split evenly across the
 * supplied trustee contacts. Each new 710 line's `contact_id` becomes a
 * different trustee — that contact's typeTag of 'trustee' is what clears
 * the TRUST_710_ATTRIBUTION_REQUIRED rule per-line.
 *
 * transactions.contactId is left as the original vendor (e.g. Starbucks).
 * The trustee attribution lives on the JE lines, not on the txn header —
 * the inbox still shows the vendor name.
 *
 * Single-trustee callers should use the existing tagFindingTrusteeContact
 * action instead — this one is for the multi-trustee "split evenly" flow.
 */
export async function split710ByTrustees(args: {
	findingId: string;
	contactIds: string[];
}): Promise<Split710Result> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();

	if (args.contactIds.length < 2) {
		return { ok: false, error: 'Split needs at least two trustees' };
	}

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

	const ctx = resolve710Context(finding.code, finding.metadata);
	if (!ctx.ok) return { ok: false, error: ctx.error };
	const { sourceAccountId, originalAccountId } = ctx;

	const trustees = await db
		.select({
			id: contacts.id,
			contactName: contacts.contactName,
			typeTags: contacts.typeTags,
		})
		.from(contacts)
		.where(
			and(
				eq(contacts.organizationId, orgId),
				inArray(contacts.id, args.contactIds),
			),
		);
	if (trustees.length !== args.contactIds.length) {
		return { ok: false, error: 'One or more trustee contacts not found in this organization' };
	}
	for (const t of trustees) {
		const tags = Array.isArray(t.typeTags) ? t.typeTags : [];
		const isTrustee = tags.some(
			(tag) => typeof tag === 'string' && tag.toLowerCase() === 'trustee',
		);
		if (!isTrustee) {
			return {
				ok: false,
				error: `${t.contactName} isn't marked as a trustee. Mark them on their contact page first.`,
			};
		}
	}

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

	const meLines = lines.filter((l) => l.accountId === sourceAccountId);
	const otherLines = lines.filter((l) => l.accountId !== sourceAccountId);
	if (meLines.length === 0) {
		return { ok: false, error: 'No matching lines found on this JE — cannot split' };
	}

	const totalCents = meLines.reduce(
		(acc, l) => acc + Math.round(Number(l.debit ?? 0) * 100),
		0,
	);
	if (totalCents <= 0) {
		return { ok: false, error: '710 line has no positive debit amount to split' };
	}
	const splitCents = splitAmountEvenly(totalCents, args.contactIds.length);
	const sharedMemo = meLines[0]?.memo ?? null;

	const [originalAcct] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(eq(chartOfAccounts.id, originalAccountId))
		.limit(1);
	if (!originalAcct) return { ok: false, error: 'Original 710 account missing from CoA' };

	let newJeId: string | null = null;
	try {
		await db.transaction(async (tx) => {
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — 710 line split across ${args.contactIds.length} trustees`,
				},
				tx,
			);

			const newSplitLines = args.contactIds.map((contactId, i) => ({
				accountId: originalAccountId,
				debit: splitCents[i] / 100,
				credit: 0,
				contactId,
				memo: sharedMemo,
				beneficiaryId: null,
			}));

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
					lines: [...newSplitLines, ...carryoverLines],
				},
				tx,
			);
			newJeId = newJe.id;

			// Re-point the transactions row at the new JE. transactions.contact
			// Id intentionally stays as the existing vendor — the trustee
			// attribution lives on the JE lines only. categoryAccountId is
			// set to the original 710 account because every split line shares
			// that account; for an OPEN finding this is a no-op (line was
			// already on 710), for DECISIONED it un-stales a value that
			// previously pointed at the rerouted destination.
			if (je.sourceType === 'transaction' && je.sourceId) {
				await tx
					.update(transactions)
					.set({ journalEntryId: newJe.id, categoryAccountId: originalAccountId })
					.where(
						and(
							eq(transactions.id, je.sourceId),
							eq(transactions.organizationId, orgId),
						),
					);
			}

			const trusteeNames = trustees.map((t) => t.contactName).join(', ');

			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				...build710TrusteeAttributionFinding({
					organizationId: orgId,
					journalEntryId: newJe.id,
					accountId: originalAcct.id,
					accountNumber: originalAcct.accountNumber,
					accountName: originalAcct.accountName,
					trusteeLabel: trusteeNames,
					trusteeCount: args.contactIds.length,
					amount: totalCents / 100,
				}),
			});

			// Dismiss every still-open finding on the reversed JE — see
			// reroute710ToBeneficiary for the rationale.
			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: 710 line split across ${args.contactIds.length} trustees (${trusteeNames}). See JE ${newJe.id.slice(0, 8)}.`,
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
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to split JE' };
	}

	revalidatePath('/trust-review');
	return { ok: true, newJournalEntryId: newJeId ?? undefined };
}
