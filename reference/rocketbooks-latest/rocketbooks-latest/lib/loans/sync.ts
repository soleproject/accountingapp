import 'server-only';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	journalEntries,
	loanAmortizationSchedules,
	loans,
} from '@/db/schema/schema';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Detect schedule rows whose linked JE has been reversed outside the
 * loan flow (e.g. via /journal-entries) and silently restore them to
 * "scheduled" state.
 *
 * Without this, a user who reverses a payment JE elsewhere would see
 * the loan's posted-count stay > 0 forever, blocking edit/delete and
 * refusing re-record on what should be an unposted row. Run this at the
 * start of any flow that branches on posted-state — recordLoanPayment,
 * deleteLoan, the term-edit rebuild — so the loan view always reflects
 * what the GL actually says.
 *
 * Pure cleanup, idempotent. Returns the number of rows reverted so
 * callers can log/surface the sync if it ever does work.
 */
export async function syncLoanWithGL(args: {
	orgId: string;
	loanId: string;
	tx?: Tx;
}): Promise<{ rowsReverted: number }> {
	const exec = args.tx ?? db;

	const posted = await exec
		.select({
			id: loanAmortizationSchedules.id,
			principalAmount: loanAmortizationSchedules.principalAmount,
			postedJournalEntryId: loanAmortizationSchedules.postedJournalEntryId,
		})
		.from(loanAmortizationSchedules)
		.where(
			and(
				eq(loanAmortizationSchedules.loanId, args.loanId),
				isNotNull(loanAmortizationSchedules.postedJournalEntryId),
			),
		);
	if (posted.length === 0) return { rowsReverted: 0 };

	const jeIds = posted
		.map((r) => r.postedJournalEntryId)
		.filter((v): v is string => !!v);

	const reversedRows = await exec
		.select({ originalId: journalEntries.reversalOfId })
		.from(journalEntries)
		.where(
			and(
				eq(journalEntries.organizationId, args.orgId),
				inArray(journalEntries.reversalOfId, jeIds),
			),
		);
	const reversedOriginals = new Set(reversedRows.map((r) => r.originalId));
	if (reversedOriginals.size === 0) return { rowsReverted: 0 };

	const toClear = posted.filter((r) => reversedOriginals.has(r.postedJournalEntryId));
	if (toClear.length === 0) return { rowsReverted: 0 };

	const principalToReturn = toClear.reduce(
		(acc, r) => acc + Number(r.principalAmount ?? 0),
		0,
	);

	const ids = toClear.map((r) => r.id);
	await exec
		.update(loanAmortizationSchedules)
		.set({
			postedJournalEntryId: null,
			postedAt: null,
			updatedAt: new Date().toISOString(),
		})
		.where(inArray(loanAmortizationSchedules.id, ids));

	await exec
		.update(loans)
		.set({
			currentPrincipal: sql`${loans.currentPrincipal} + ${principalToReturn}`,
			// If a row was reverted, the loan can't be paid_off anymore.
			status: sql`CASE WHEN ${loans.status} = 'paid_off' THEN 'active' ELSE ${loans.status} END`,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(loans.id, args.loanId));

	return { rowsReverted: toClear.length };
}
