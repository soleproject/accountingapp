import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	journalEntries,
	journalEntryLines,
	loanAmortizationSchedules,
	loans,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { syncLoanWithGL } from '@/lib/loans/sync';
import { RebuildReview, type ReviewRow } from '../../_components/RebuildReview';

interface PageProps {
	params: Promise<{ id: string }>;
}

export default async function LoanRebuildPage({ params }: PageProps) {
	const { id } = await params;
	const orgId = await getCurrentOrgId();

	// Reconcile first — externally-reversed JEs shouldn't show up in the
	// review.
	await syncLoanWithGL({ orgId, loanId: id });

	const [loan] = await db
		.select({
			id: loans.id,
			displayName: loans.displayName,
			liabilityAccountId: loans.liabilityAccountId,
			interestExpenseAccountId: loans.interestExpenseAccountId,
		})
		.from(loans)
		.where(and(eq(loans.id, id), eq(loans.organizationId, orgId)))
		.limit(1);
	if (!loan) notFound();

	const postedRows = await db
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
				eq(loanAmortizationSchedules.loanId, id),
				isNotNull(loanAmortizationSchedules.postedJournalEntryId),
			),
		)
		.orderBy(asc(loanAmortizationSchedules.paymentNumber));

	const jeIds = postedRows
		.map((r) => r.postedJournalEntryId)
		.filter((v): v is string => !!v);

	const jeRows = jeIds.length > 0
		? await db
				.select({
					id: journalEntries.id,
					date: journalEntries.date,
				})
				.from(journalEntries)
				.where(inArray(journalEntries.id, jeIds))
		: [];
	const jeDateById = new Map(jeRows.map((j) => [j.id, j.date]));

	const jeLines = jeIds.length > 0
		? await db
				.select({
					journalEntryId: journalEntryLines.journalEntryId,
					accountId: journalEntryLines.accountId,
					debit: journalEntryLines.debit,
					credit: journalEntryLines.credit,
				})
				.from(journalEntryLines)
				.where(inArray(journalEntryLines.journalEntryId, jeIds))
		: [];
	const linesByJe = new Map<string, typeof jeLines>();
	for (const l of jeLines) {
		const arr = linesByJe.get(l.journalEntryId) ?? [];
		arr.push(l);
		linesByJe.set(l.journalEntryId, arr);
	}

	const reviewRows: ReviewRow[] = postedRows.map((r) => {
		const lines = r.postedJournalEntryId ? linesByJe.get(r.postedJournalEntryId) ?? [] : [];
		const actualPrincipal = lines
			.filter((l) => l.accountId === loan.liabilityAccountId)
			.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
		const actualInterest = lines
			.filter((l) => l.accountId === loan.interestExpenseAccountId)
			.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
		const actualTotal = actualPrincipal + actualInterest;
		const scheduledPrincipal = Number(r.principalAmount);
		const scheduledInterest = Number(r.interestAmount);
		const scheduledTotal = scheduledPrincipal + scheduledInterest;
		const round = (n: number) => Math.round(n * 100) / 100;
		return {
			rowId: r.id,
			paymentNumber: r.paymentNumber,
			dueDate: r.dueDate,
			postedDate: r.postedJournalEntryId ? jeDateById.get(r.postedJournalEntryId) ?? null : null,
			scheduledPrincipal,
			scheduledInterest,
			scheduledTotal,
			actualPrincipal,
			actualInterest,
			actualTotal,
			principalDelta: round(actualPrincipal - scheduledPrincipal),
			interestDelta: round(actualInterest - scheduledInterest),
			delta: round(actualTotal - scheduledTotal),
			journalEntryId: r.postedJournalEntryId,
		};
	});

	// A row is a real "match" only when BOTH split components agree —
	// totals matching with split drift (e.g. APR changed but payment
	// amount didn't) is a variance the user should see and decide on.
	const isMatch = (r: ReviewRow) =>
		Math.abs(r.principalDelta) < 0.005 && Math.abs(r.interestDelta) < 0.005;
	const matchCount = reviewRows.filter(isMatch).length;
	const varianceCount = reviewRows.length - matchCount;

	return (
		<div className="flex flex-col gap-4">
			<Link
				href={`/loans/${loan.id}`}
				className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
			>
				← Back to loan
			</Link>
			<header>
				<h1 className="text-2xl font-semibold">Review rebuild</h1>
				<p className="text-sm text-zinc-500 dark:text-zinc-400">
					{loan.displayName} · {reviewRows.length} posted payment
					{reviewRows.length === 1 ? '' : 's'} · {matchCount} match
					{matchCount === 1 ? '' : 'es'}, {varianceCount} variance
					{varianceCount === 1 ? '' : 's'}
				</p>
			</header>

			{reviewRows.length === 0 ? (
				<div className="rounded-lg border border-zinc-200 bg-white p-10 text-center text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
					Nothing to review — no posted payments on this loan.
					<div className="mt-2">
						<Link href={`/loans/${loan.id}`} className="text-blue-600 hover:underline dark:text-blue-400">
							Return to loan
						</Link>
					</div>
				</div>
			) : (
				<RebuildReview loanId={loan.id} rows={reviewRows} />
			)}
		</div>
	);
}
