import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	assetBooks,
	assetCategories,
	chartOfAccounts,
	contacts,
	fixedAssets,
	loanAmortizationSchedules,
	loans,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { RecordPaymentForm } from '../_components/RecordPaymentForm';
import { DeleteLoanButton } from '../_components/DeleteLoanButton';

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const PCT_FMT = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 4 });

interface PageProps {
	params: Promise<{ id: string }>;
}

function todayISO(): string {
	const d = new Date();
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export default async function LoanDetailPage({ params }: PageProps) {
	const { id } = await params;
	const orgId = await getCurrentOrgId();

	const [loan] = await db
		.select({
			id: loans.id,
			displayName: loans.displayName,
			lenderContactId: loans.lenderContactId,
			originalPrincipal: loans.originalPrincipal,
			currentPrincipal: loans.currentPrincipal,
			annualInterestRate: loans.annualInterestRate,
			termMonths: loans.termMonths,
			paymentAmount: loans.paymentAmount,
			startDate: loans.startDate,
			firstPaymentDate: loans.firstPaymentDate,
			status: loans.status,
			noteDocumentUrl: loans.noteDocumentUrl,
			liabilityAccountId: loans.liabilityAccountId,
			interestExpenseAccountId: loans.interestExpenseAccountId,
			collateralAssetId: loans.collateralAssetId,
		})
		.from(loans)
		.where(and(eq(loans.id, id), eq(loans.organizationId, orgId)))
		.limit(1);
	if (!loan) notFound();

	// Linked collateral asset (when present). Pulled separately to keep
	// the loan select tight, and to allow showing the asset's current
	// book value alongside the loan balance for a quick equity view.
	let collateral: {
		id: string;
		name: string;
		assetNumber: string | null;
		status: string;
		costBasis: number;
		accumulatedDepreciation: number;
		categoryName: string;
	} | null = null;
	if (loan.collateralAssetId) {
		const [row] = await db
			.select({
				id: fixedAssets.id,
				name: fixedAssets.name,
				assetNumber: fixedAssets.assetNumber,
				status: fixedAssets.status,
				costBasis: fixedAssets.costBasis,
				fmvAtDod: fixedAssets.fmvAtDod,
				acquisitionType: fixedAssets.acquisitionType,
				categoryName: assetCategories.name,
				accumulatedDepreciation: assetBooks.accumulatedDepreciation,
			})
			.from(fixedAssets)
			.innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
			.leftJoin(
				assetBooks,
				and(eq(assetBooks.assetId, fixedAssets.id), eq(assetBooks.bookType, 'fiduciary')),
			)
			.where(eq(fixedAssets.id, loan.collateralAssetId))
			.limit(1);
		if (row) {
			const basis = row.acquisitionType === 'inherited' && row.fmvAtDod
				? Number(row.fmvAtDod)
				: Number(row.costBasis);
			collateral = {
				id: row.id,
				name: row.name,
				assetNumber: row.assetNumber,
				status: row.status,
				costBasis: basis,
				accumulatedDepreciation: Number(row.accumulatedDepreciation ?? 0),
				categoryName: row.categoryName,
			};
		}
	}

	const lender = loan.lenderContactId
		? (
				await db
					.select({ contactName: contacts.contactName })
					.from(contacts)
					.where(eq(contacts.id, loan.lenderContactId))
					.limit(1)
			)[0]?.contactName ?? null
		: null;

	const schedule = await db
		.select({
			id: loanAmortizationSchedules.id,
			paymentNumber: loanAmortizationSchedules.paymentNumber,
			dueDate: loanAmortizationSchedules.dueDate,
			principalAmount: loanAmortizationSchedules.principalAmount,
			interestAmount: loanAmortizationSchedules.interestAmount,
			remainingBalance: loanAmortizationSchedules.remainingBalance,
			postedJournalEntryId: loanAmortizationSchedules.postedJournalEntryId,
			postedAt: loanAmortizationSchedules.postedAt,
		})
		.from(loanAmortizationSchedules)
		.where(eq(loanAmortizationSchedules.loanId, loan.id))
		.orderBy(asc(loanAmortizationSchedules.paymentNumber));

	const nextRow = schedule.find((r) => !r.postedJournalEntryId);
	const postedCount = schedule.filter((r) => r.postedJournalEntryId).length;
	const totalPrincipalPaid = Number(loan.originalPrincipal) - Number(loan.currentPrincipal);
	const principalPaidPct = Number(loan.originalPrincipal) > 0
		? Math.min(100, (totalPrincipalPaid / Number(loan.originalPrincipal)) * 100)
		: 0;
	const finalRow = schedule[schedule.length - 1];

	// Bank accounts for the Record Payment form.
	const bankAccounts = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(
			sql`${chartOfAccounts.organizationId} = ${orgId}
				AND ${chartOfAccounts.accountType} = 'bank'`,
		)
		.orderBy(asc(chartOfAccounts.accountNumber));

	const today = todayISO();

	return (
		<div className="flex flex-col gap-6">
			<Link
				href="/loans"
				className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
			>
				← Back to loans
			</Link>

			<header className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="text-2xl font-semibold">{loan.displayName}</h1>
					<p className="text-sm text-zinc-500 dark:text-zinc-400">
						{lender ? `${lender} · ` : ''}
						{loan.termMonths} months · started {loan.startDate} ·{' '}
						{PCT_FMT.format(Number(loan.annualInterestRate))} APR
						{loan.status !== 'active' && <> · {loan.status === 'paid_off' ? 'Paid off' : 'Written off'}</>}
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Link
						href={`/loans/${loan.id}/edit`}
						className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
					>
						Edit
					</Link>
					{postedCount === 0 && (
						<DeleteLoanButton loanId={loan.id} loanName={loan.displayName} />
					)}
				</div>
			</header>

			{/* Header card */}
			<section className="rounded-lg border border-zinc-400 bg-amber-50 p-4 shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 dark:border-zinc-500 dark:bg-amber-950/20 dark:shadow-black/60 dark:ring-white/10">
				<div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
					<Stat label="Current balance" value={CURRENCY_FMT.format(Number(loan.currentPrincipal))} />
					<Stat
						label="Next payment"
						value={nextRow ? nextRow.dueDate : '—'}
						sub={
							nextRow
								? CURRENCY_FMT.format(Number(nextRow.principalAmount) + Number(nextRow.interestAmount))
								: 'all paid'
						}
					/>
					<Stat
						label="Monthly payment"
						value={loan.paymentAmount ? CURRENCY_FMT.format(Number(loan.paymentAmount)) : '—'}
					/>
					<Stat label="Payoff date" value={finalRow?.dueDate ?? '—'} />
				</div>
				<div className="mt-4">
					<div className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-300">
						<span>
							Principal paid: {CURRENCY_FMT.format(totalPrincipalPaid)} of{' '}
							{CURRENCY_FMT.format(Number(loan.originalPrincipal))}
						</span>
						<span className="tabular-nums">
							{postedCount} of {schedule.length} payments posted
						</span>
					</div>
					<div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
						<div
							className="h-full rounded-full bg-emerald-500 dark:bg-emerald-600"
							style={{ width: `${principalPaidPct}%` }}
						/>
					</div>
				</div>
				{loan.noteDocumentUrl && (
					<div className="mt-3 text-xs">
						<a
							className="text-blue-600 hover:underline dark:text-blue-400"
							href={loan.noteDocumentUrl}
							target="_blank"
							rel="noopener noreferrer"
						>
							View loan agreement →
						</a>
					</div>
				)}
			</section>

			{/* Linked collateral asset */}
			{collateral && (
				<section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
					<div className="flex items-start justify-between gap-4">
						<div>
							<div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
								Collateral
							</div>
							<Link
								href={`/assets/${collateral.id}`}
								className="mt-1 inline-flex items-center text-base font-semibold text-blue-700 hover:underline dark:text-blue-400"
							>
								{collateral.name}
								{collateral.assetNumber && (
									<span className="ml-1 font-mono text-xs text-zinc-500">#{collateral.assetNumber}</span>
								)}
							</Link>
							<div className="text-xs text-zinc-500">
								{collateral.categoryName}{collateral.status !== 'active' && ` · ${collateral.status}`}
							</div>
						</div>
						<div className="text-right text-sm tabular-nums">
							<div className="text-zinc-500 text-xs">Asset book value</div>
							<div className="font-semibold">
								{CURRENCY_FMT.format(collateral.costBasis - collateral.accumulatedDepreciation)}
							</div>
							<div className="mt-1 text-zinc-500 text-xs">Equity in asset</div>
							<div
								className={`font-semibold ${
									collateral.costBasis - collateral.accumulatedDepreciation - Number(loan.currentPrincipal) >= 0
										? 'text-emerald-700 dark:text-emerald-400'
										: 'text-rose-700 dark:text-rose-400'
								}`}
							>
								{CURRENCY_FMT.format(
									collateral.costBasis - collateral.accumulatedDepreciation - Number(loan.currentPrincipal),
								)}
							</div>
						</div>
					</div>
				</section>
			)}

			{/* Record payment */}
			{loan.status === 'active' && nextRow && (
				<section>
					<h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
						Record next payment
					</h2>
					<RecordPaymentForm
						loanId={loan.id}
						scheduleRowId={nextRow.id}
						paymentNumber={nextRow.paymentNumber}
						dueDate={nextRow.dueDate}
						scheduledPrincipal={Number(nextRow.principalAmount)}
						scheduledInterest={Number(nextRow.interestAmount)}
						bankAccounts={bankAccounts}
						defaultPaymentDate={today}
					/>
				</section>
			)}

			{/* Amortization schedule */}
			<section>
				<h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
					Amortization schedule
				</h2>
				<div className="overflow-hidden rounded-lg border border-zinc-400 bg-amber-50 shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 dark:border-zinc-500 dark:bg-amber-950/20 dark:shadow-black/60 dark:ring-white/10">
					<table className="w-full text-sm">
						<thead className="bg-amber-100/60 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-amber-900/30">
							<tr>
								<th className="px-4 py-2 font-medium">#</th>
								<th className="px-4 py-2 font-medium">Due</th>
								<th className="px-4 py-2 text-right font-medium">Principal</th>
								<th className="px-4 py-2 text-right font-medium">Interest</th>
								<th className="px-4 py-2 text-right font-medium">Balance after</th>
								<th className="px-4 py-2 font-medium">Status</th>
							</tr>
						</thead>
						<tbody>
							{schedule.map((r, i) => {
								const isToday = r.dueDate >= today && (i === 0 || schedule[i - 1].dueDate < today);
								const posted = !!r.postedJournalEntryId;
								return (
									<tr
										key={r.id}
										className={`border-t border-zinc-100 dark:border-zinc-800 ${posted ? 'opacity-70' : ''} ${isToday ? 'bg-blue-50/40 dark:bg-blue-900/10' : ''}`}
									>
										<td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">
											{r.paymentNumber}
										</td>
										<td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">
											{r.dueDate}
										</td>
										<td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
											{CURRENCY_FMT.format(Number(r.principalAmount))}
										</td>
										<td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
											{CURRENCY_FMT.format(Number(r.interestAmount))}
										</td>
										<td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
											{CURRENCY_FMT.format(Number(r.remainingBalance))}
										</td>
										<td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
											{posted ? (
												<Link
													href={`/journal-entries/${r.postedJournalEntryId}`}
													className="inline-flex items-center gap-1 text-xs"
												>
													<span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
														posted
													</span>
													<span className="text-blue-600 hover:underline dark:text-blue-400">
														view JE
													</span>
												</Link>
											) : (
												<span className="text-xs text-zinc-500">scheduled</span>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			</section>
		</div>
	);
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
	return (
		<div className="flex flex-col">
			<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
			<span className="mt-0.5 text-base font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
				{value}
			</span>
			{sub && <span className="text-xs text-zinc-500 tabular-nums">{sub}</span>}
		</div>
	);
}
