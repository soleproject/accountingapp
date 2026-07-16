'use server';

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	journalEntries,
	journalEntryLines,
	transactions,
	trustBeneficiaries,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { createJournalEntry, reverseJournalEntry } from '@/lib/accounting/posting';

export interface RerouteNoReceiptResult {
	ok: boolean;
	error?: string;
	newJournalEntryId?: string;
}

/**
 * Resolve a TRUST_NO_RECEIPT_POSSIBLE_DISTRIBUTION finding when no
 * receipt can be obtained. Per spec, the line moves to the responsible
 * party's 26x demand note as a non-deductible personal advance rather
 * than staying on the original expense account.
 *
 * The user picks WHICH beneficiary (the person who actually got the
 * benefit); the action reverses the JE, finds the line that hit the
 * original expense account, reposts it on the bene's demand note,
 * emits TRUST_NO_RECEIPT_REROUTED_TO_DEMAND_NOTE on the new JE, and
 * dismisses the original finding.
 *
 * The "no demand-note capacity → escalate to 310 + K-1" branch is
 * deferred to the 310/K-1 wizard slice.
 */
export async function rerouteNoReceiptToDemandNote(args: {
	findingId: string;
	beneficiaryId: string;
	/** When the JE has multiple expense lines, the user picks which one
	 *  to reroute. If omitted, the action picks the largest debit on a
	 *  non-bank/non-liability account. */
	expenseAccountId?: string;
}): Promise<RerouteNoReceiptResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();

	const [finding] = await db
		.select({
			id: trustReviewFindings.id,
			code: trustReviewFindings.code,
			organizationId: trustReviewFindings.organizationId,
			journalEntryId: trustReviewFindings.journalEntryId,
		})
		.from(trustReviewFindings)
		.where(eq(trustReviewFindings.id, args.findingId))
		.limit(1);
	if (!finding) return { ok: false, error: 'Finding not found' };
	if (finding.organizationId !== orgId) return { ok: false, error: 'Not authorized' };
	if (finding.code !== 'TRUST_NO_RECEIPT_POSSIBLE_DISTRIBUTION') {
		return { ok: false, error: 'rerouteNoReceiptToDemandNote only applies to NO_RECEIPT findings' };
	}

	const [bene] = await db
		.select({
			id: trustBeneficiaries.id,
			fullName: trustBeneficiaries.fullName,
			demandNoteAccountId: trustBeneficiaries.demandNoteAccountId,
		})
		.from(trustBeneficiaries)
		.where(and(eq(trustBeneficiaries.id, args.beneficiaryId), eq(trustBeneficiaries.organizationId, orgId)))
		.limit(1);
	if (!bene) return { ok: false, error: 'Beneficiary not in this organization' };
	if (!bene.demandNoteAccountId) {
		return { ok: false, error: `${bene.fullName} has no 26x demand-note account on file` };
	}

	const [demandAcct] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(eq(chartOfAccounts.id, bene.demandNoteAccountId))
		.limit(1);
	if (!demandAcct) return { ok: false, error: 'Demand-note account missing from CoA' };

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

	// Load lines + the accounts they sit on so we can pick the expense
	// line to move (avoid bank-side and liability-side lines).
	const lineRows = await db
		.select({
			accountId: journalEntryLines.accountId,
			debit: journalEntryLines.debit,
			credit: journalEntryLines.credit,
			contactId: journalEntryLines.contactId,
			memo: journalEntryLines.memo,
			beneficiaryId: journalEntryLines.beneficiaryId,
			accountType: chartOfAccounts.accountType,
		})
		.from(journalEntryLines)
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.where(eq(journalEntryLines.journalEntryId, je.id));

	let targetLineAccountId: string;
	if (args.expenseAccountId) {
		if (!lineRows.some((l) => l.accountId === args.expenseAccountId)) {
			return { ok: false, error: 'Picked expense account is not on this JE' };
		}
		targetLineAccountId = args.expenseAccountId;
	} else {
		// Largest debit that isn't on a bank or liability account.
		const candidates = lineRows
			.filter(
				(l) =>
					Number(l.debit ?? 0) > 0
					&& l.accountType !== 'bank'
					&& l.accountType !== 'long_term_liabilities'
					&& l.accountType !== 'other_current_liabilities'
					&& l.accountType !== 'accounts_payable',
			)
			.sort((a, b) => Number(b.debit ?? 0) - Number(a.debit ?? 0));
		if (candidates.length === 0) {
			return { ok: false, error: 'No expense line found to reroute' };
		}
		targetLineAccountId = candidates[0].accountId;
	}

	const sourceLines = lineRows.filter((l) => l.accountId === targetLineAccountId);
	const otherLines = lineRows.filter((l) => l.accountId !== targetLineAccountId);
	const totalDebit = sourceLines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
	if (totalDebit <= 0) return { ok: false, error: 'Picked line has no debit to reroute' };

	const [sourceAcct] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(eq(chartOfAccounts.id, targetLineAccountId))
		.limit(1);

	let newJeId: string;
	try {
		await db.transaction(async (tx) => {
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — no-receipt expense rerouted to ${demandAcct.accountNumber ?? ''} ${demandAcct.accountName} for ${bene.fullName}`,
				},
				tx,
			);

			const newDemandLine = {
				accountId: demandAcct.id,
				debit: totalDebit,
				credit: 0,
				contactId: sourceLines[0]?.contactId ?? null,
				memo: sourceLines[0]?.memo ?? null,
				beneficiaryId: bene.id,
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
					lines: [newDemandLine, ...carryoverLines],
				},
				tx,
			);
			newJeId = newJe.id;

			if (je.sourceType === 'transaction' && je.sourceId) {
				await tx
					.update(transactions)
					.set({ journalEntryId: newJe.id, categoryAccountId: demandAcct.id })
					.where(
						and(
							eq(transactions.id, je.sourceId),
							eq(transactions.organizationId, orgId),
						),
					);
			}

			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				organizationId: orgId,
				journalEntryId: newJe.id,
				code: 'TRUST_NO_RECEIPT_REROUTED_TO_DEMAND_NOTE',
				severity: 'warn',
				message: `${sourceAcct?.accountNumber ?? ''} ${sourceAcct?.accountName ?? 'expense'} line ($${totalDebit.toFixed(2)}) rerouted to ${demandAcct.accountNumber ?? ''} ${demandAcct.accountName} (demand note) for ${bene.fullName} — no receipt obtainable.`,
				metadata: {
					accountId: demandAcct.id,
					accountNumber: demandAcct.accountNumber,
					fromAccountId: targetLineAccountId,
					fromAccountNumber: sourceAcct?.accountNumber,
					toAccountId: demandAcct.id,
					toAccountNumber: demandAcct.accountNumber,
					beneficiaryId: bene.id,
					amount: totalDebit,
				},
			});

			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: no-receipt expense rerouted to demand note for ${bene.fullName}. See JE ${newJe.id.slice(0, 8)}.`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to reroute' };
	}

	revalidatePath('/trust-review');
	revalidatePath('/trust-beneficiaries');
	return { ok: true, newJournalEntryId: newJeId! };
}
