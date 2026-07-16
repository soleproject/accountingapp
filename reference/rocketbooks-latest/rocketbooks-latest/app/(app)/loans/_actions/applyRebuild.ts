'use server';

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	journalEntries,
	journalEntryLines,
	loanAmortizationSchedules,
	loans,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { createJournalEntry, reverseJournalEntry } from '@/lib/accounting/posting';
import { syncLoanWithGL } from '@/lib/loans/sync';

export type RebuildAction = 'accept' | 'redo' | 'reverse';

export interface RebuildDecision {
	scheduleRowId: string;
	action: RebuildAction;
}

export interface ApplyRebuildResult {
	ok: boolean;
	error?: string;
	processed?: number;
}

/**
 * Commit the user's per-row decisions after a term-edit rebuild.
 *
 *   accept  → leave the JE linked; overwrite the row's principal/interest
 *             with the JE's actual amounts so the saved schedule reflects
 *             what was really posted.
 *   redo    → reverse the existing JE, post a fresh one at the row's NEW
 *             scheduled amount using the same bank account from the
 *             original payment.
 *   reverse → reverse the JE, clear the row's linkage; row goes back to
 *             "scheduled" and the principal returns to current_principal.
 *
 * Whole batch runs in one tx — partial failures roll the loan back to
 * the pre-rebuild state so the user can retry.
 */
export async function applyRebuild(args: {
	loanId: string;
	decisions: RebuildDecision[];
}): Promise<ApplyRebuildResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	if (!args.loanId) return { ok: false, error: 'Missing loanId' };
	if (args.decisions.length === 0) return { ok: false, error: 'No decisions provided' };

	await syncLoanWithGL({ orgId, loanId: args.loanId });

	const [loan] = await db
		.select({
			id: loans.id,
			organizationId: loans.organizationId,
			displayName: loans.displayName,
			liabilityAccountId: loans.liabilityAccountId,
			interestExpenseAccountId: loans.interestExpenseAccountId,
		})
		.from(loans)
		.where(eq(loans.id, args.loanId))
		.limit(1);
	if (!loan) return { ok: false, error: 'Loan not found' };
	if (loan.organizationId !== orgId) return { ok: false, error: 'Not authorized' };
	if (!loan.interestExpenseAccountId) {
		return { ok: false, error: 'Loan has no interest expense account configured' };
	}

	const rowIds = args.decisions.map((d) => d.scheduleRowId);
	const rows = await db
		.select({
			id: loanAmortizationSchedules.id,
			paymentNumber: loanAmortizationSchedules.paymentNumber,
			dueDate: loanAmortizationSchedules.dueDate,
			principalAmount: loanAmortizationSchedules.principalAmount,
			interestAmount: loanAmortizationSchedules.interestAmount,
			postedJournalEntryId: loanAmortizationSchedules.postedJournalEntryId,
		})
		.from(loanAmortizationSchedules)
		.where(
			and(
				eq(loanAmortizationSchedules.loanId, args.loanId),
				inArray(loanAmortizationSchedules.id, rowIds),
			),
		);
	const rowById = new Map(rows.map((r) => [r.id, r]));

	// Validate every decision row exists + has a posted JE (otherwise
	// there's nothing to accept/redo/reverse).
	for (const d of args.decisions) {
		const r = rowById.get(d.scheduleRowId);
		if (!r) return { ok: false, error: `Schedule row ${d.scheduleRowId.slice(0, 8)} not found` };
		if (!r.postedJournalEntryId) {
			return { ok: false, error: `Row #${r.paymentNumber} has no posted payment to act on` };
		}
	}

	// Fetch every JE we'll touch — needed for bank-account lookup on redo
	// and for amount lookup on accept.
	const jeIds = Array.from(
		new Set(
			rows
				.map((r) => r.postedJournalEntryId)
				.filter((v): v is string => !!v),
		),
	);
	const jeHeaders = await db
		.select({
			id: journalEntries.id,
			date: journalEntries.date,
			memo: journalEntries.memo,
			sourceType: journalEntries.sourceType,
			sourceId: journalEntries.sourceId,
		})
		.from(journalEntries)
		.where(inArray(journalEntries.id, jeIds));
	const jeHeaderById = new Map(jeHeaders.map((j) => [j.id, j]));

	const jeLines = await db
		.select({
			journalEntryId: journalEntryLines.journalEntryId,
			accountId: journalEntryLines.accountId,
			debit: journalEntryLines.debit,
			credit: journalEntryLines.credit,
		})
		.from(journalEntryLines)
		.where(inArray(journalEntryLines.journalEntryId, jeIds));
	const linesByJe = new Map<string, typeof jeLines>();
	for (const l of jeLines) {
		const arr = linesByJe.get(l.journalEntryId) ?? [];
		arr.push(l);
		linesByJe.set(l.journalEntryId, arr);
	}

	// Identify the bank account on each JE (the credit-side line not on
	// the liability or interest accounts). Needed for redo so we re-post
	// against the same bank.
	const bankAccountByJe = new Map<string, string>();
	for (const [jeId, lines] of linesByJe) {
		const bankLine = lines.find(
			(l) =>
				Number(l.credit ?? 0) > 0
				&& l.accountId !== loan.liabilityAccountId
				&& l.accountId !== loan.interestExpenseAccountId,
		);
		if (bankLine) bankAccountByJe.set(jeId, bankLine.accountId);
	}

	// Build the list of bank account ids we'll use; verify they're all
	// bank-type and belong to this org (defense against a JE that points
	// at something silly).
	const usedBankIds = Array.from(new Set(bankAccountByJe.values()));
	if (usedBankIds.length > 0) {
		const bankAccts = await db
			.select({
				id: chartOfAccounts.id,
				accountType: chartOfAccounts.accountType,
			})
			.from(chartOfAccounts)
			.where(
				and(
					eq(chartOfAccounts.organizationId, orgId),
					inArray(chartOfAccounts.id, usedBankIds),
				),
			);
		const validBank = new Set(
			bankAccts.filter((a) => a.accountType === 'bank').map((a) => a.id),
		);
		for (const [jeId, bankId] of bankAccountByJe) {
			if (!validBank.has(bankId)) {
				return {
					ok: false,
					error: `JE ${jeId.slice(0, 8)}'s bank account is no longer valid; reverse this row manually.`,
				};
			}
		}
	}

	let processed = 0;
	try {
		await db.transaction(async (tx) => {
			for (const d of args.decisions) {
				const row = rowById.get(d.scheduleRowId)!;
				const jeId = row.postedJournalEntryId!;
				const lines = linesByJe.get(jeId) ?? [];

				if (d.action === 'accept') {
					// Overwrite the row's principal/interest with the JE's actuals.
					// That lets the saved schedule reflect what was really posted,
					// and keeps current_principal = originalPrincipal − Σ(rows'
					// principal across posted rows) honest.
					const actualPrincipal = lines
						.filter((l) => l.accountId === loan.liabilityAccountId)
						.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
					const actualInterest = lines
						.filter((l) => l.accountId === loan.interestExpenseAccountId)
						.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
					await tx
						.update(loanAmortizationSchedules)
						.set({
							principalAmount: String(actualPrincipal),
							interestAmount: String(actualInterest),
							updatedAt: new Date().toISOString(),
						})
						.where(eq(loanAmortizationSchedules.id, row.id));
				} else if (d.action === 'reverse') {
					await reverseJournalEntry(
						{
							organizationId: orgId,
							journalEntryId: jeId,
							reversalMemo: `Reversal — loan payment #${row.paymentNumber} for ${loan.displayName} (rebuild)`,
						},
						tx,
					);
					await tx
						.update(loanAmortizationSchedules)
						.set({
							postedJournalEntryId: null,
							postedAt: null,
							updatedAt: new Date().toISOString(),
						})
						.where(eq(loanAmortizationSchedules.id, row.id));
				} else if (d.action === 'redo') {
					const bankAccountId = bankAccountByJe.get(jeId);
					if (!bankAccountId) {
						throw new Error(
							`Row #${row.paymentNumber}: original JE has no bank line to re-use; reverse and re-record manually.`,
						);
					}
					const header = jeHeaderById.get(jeId);
					if (!header) throw new Error(`Row #${row.paymentNumber}: original JE not found`);

					await reverseJournalEntry(
						{
							organizationId: orgId,
							journalEntryId: jeId,
							reversalMemo: `Reversal — loan payment #${row.paymentNumber} for ${loan.displayName} (rebuild → re-record)`,
						},
						tx,
					);

					const principal = Number(row.principalAmount);
					const interest = Number(row.interestAmount);
					const total = Math.round((principal + interest) * 100) / 100;
					const newJe = await createJournalEntry(
						{
							organizationId: orgId,
							date: header.date,
							memo: `Loan payment #${row.paymentNumber} — ${loan.displayName} (rebuild)`,
							posted: true,
							sourceType: 'loan_payment',
							sourceId: row.id,
							lines: [
								{ accountId: loan.liabilityAccountId, debit: principal, credit: 0 },
								{ accountId: loan.interestExpenseAccountId!, debit: interest, credit: 0 },
								{ accountId: bankAccountId, debit: 0, credit: total },
							],
						},
						tx,
					);
					await tx
						.update(loanAmortizationSchedules)
						.set({
							postedJournalEntryId: newJe.id,
							postedAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
						})
						.where(eq(loanAmortizationSchedules.id, row.id));
				}
				processed++;
			}

			// Recompute current_principal from the (now-settled) posted rows.
			const remaining = await tx
				.select({
					principalAmount: loanAmortizationSchedules.principalAmount,
				})
				.from(loanAmortizationSchedules)
				.where(
					and(
						eq(loanAmortizationSchedules.loanId, args.loanId),
						isNotNull(loanAmortizationSchedules.postedJournalEntryId),
					),
				);
			const [original] = await tx
				.select({ originalPrincipal: loans.originalPrincipal })
				.from(loans)
				.where(eq(loans.id, args.loanId))
				.limit(1);
			const totalPaid = remaining.reduce((acc, r) => acc + Number(r.principalAmount ?? 0), 0);
			const newCurrent = Math.max(
				0,
				Math.round((Number(original?.originalPrincipal ?? 0) - totalPaid) * 100) / 100,
			);
			await tx
				.update(loans)
				.set({
					currentPrincipal: String(newCurrent),
					updatedAt: new Date().toISOString(),
				})
				.where(eq(loans.id, args.loanId));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Rebuild apply failed', processed };
	}

	revalidatePath('/loans');
	revalidatePath(`/loans/${args.loanId}`);
	revalidatePath(`/loans/${args.loanId}/rebuild`);
	return { ok: true, processed };
}
