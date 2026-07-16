import Link from 'next/link';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, loanAmortizationSchedules, loans } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const PCT_FMT = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 4 });

interface PageProps {
	searchParams: Promise<{ status?: string }>;
}

const STATUS_PILL_CLS: Record<string, string> = {
	active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
	paid_off: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
	written_off: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

export default async function LoansPage({ searchParams }: PageProps) {
	const orgId = await getCurrentOrgId();
	const sp = await searchParams;
	const statusFilter = ['active', 'paid_off', 'written_off'].includes(sp.status ?? '')
		? sp.status
		: 'active';

	// Header rows + the earliest unposted schedule row per loan (= "next
	// payment"). Single query per loan because Postgres lacks DISTINCT ON
	// in Drizzle's typed builder for this shape — we fetch all next-payment
	// rows in one shot via a window-style aggregation.
	const headerWhere = and(
		eq(loans.organizationId, orgId),
		statusFilter ? eq(loans.status, statusFilter) : undefined,
	);
	const loanRows = await db
		.select({
			id: loans.id,
			displayName: loans.displayName,
			lenderContactId: loans.lenderContactId,
			originalPrincipal: loans.originalPrincipal,
			currentPrincipal: loans.currentPrincipal,
			annualInterestRate: loans.annualInterestRate,
			termMonths: loans.termMonths,
			status: loans.status,
			startDate: loans.startDate,
		})
		.from(loans)
		.where(headerWhere)
		.orderBy(asc(loans.displayName));

	const loanIds = loanRows.map((l) => l.id);

	// Lender names — one round-trip for all visible loans.
	const lenderIds = loanRows
		.map((l) => l.lenderContactId)
		.filter((v): v is string => !!v);
	const lenderRows = lenderIds.length > 0
		? await db
				.select({ id: contacts.id, contactName: contacts.contactName })
				.from(contacts)
				.where(and(eq(contacts.organizationId, orgId), sql`${contacts.id} IN ${lenderIds}`))
		: [];
	const lenderById = new Map(lenderRows.map((c) => [c.id, c.contactName]));

	// Next unposted payment per loan. Distinct-on-loan via a CTE keeps it
	// to one round-trip even with hundreds of schedule rows per loan.
	const nextPayments = loanIds.length > 0
		? await db
				.select({
					loanId: loanAmortizationSchedules.loanId,
					dueDate: loanAmortizationSchedules.dueDate,
					principalAmount: loanAmortizationSchedules.principalAmount,
					interestAmount: loanAmortizationSchedules.interestAmount,
					paymentNumber: loanAmortizationSchedules.paymentNumber,
				})
				.from(loanAmortizationSchedules)
				.where(
					and(
						isNull(loanAmortizationSchedules.postedJournalEntryId),
						sql`${loanAmortizationSchedules.loanId} IN ${loanIds}`,
					),
				)
				.orderBy(asc(loanAmortizationSchedules.loanId), asc(loanAmortizationSchedules.paymentNumber))
		: [];
	const nextPaymentByLoan = new Map<
		string,
		{ dueDate: string; principalAmount: string; interestAmount: string; paymentNumber: number }
	>();
	for (const r of nextPayments) {
		if (!nextPaymentByLoan.has(r.loanId)) {
			nextPaymentByLoan.set(r.loanId, {
				dueDate: r.dueDate,
				principalAmount: r.principalAmount,
				interestAmount: r.interestAmount,
				paymentNumber: r.paymentNumber,
			});
		}
	}

	const enriched = loanRows.map((l) => {
		const next = nextPaymentByLoan.get(l.id);
		const nextTotal = next ? Number(next.principalAmount) + Number(next.interestAmount) : null;
		return {
			...l,
			lenderName: l.lenderContactId ? lenderById.get(l.lenderContactId) ?? null : null,
			nextDueDate: next?.dueDate ?? null,
			nextTotal,
		};
	});

	return (
		<div className="flex flex-col gap-4">
			<header className="flex items-end justify-between">
				<div>
					<h1 className="text-2xl font-semibold">Loans</h1>
					<p className="text-sm text-zinc-500 dark:text-zinc-400">
						{enriched.length} {statusFilter} loan{enriched.length === 1 ? '' : 's'}
					</p>
				</div>
				<Link
					href="/loans/new"
					className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
				>
					New loan
				</Link>
			</header>

			<div className="flex items-center gap-2 text-sm">
				<StatusTab href="/loans?status=active" active={statusFilter === 'active'} label="Active" />
				<StatusTab href="/loans?status=paid_off" active={statusFilter === 'paid_off'} label="Paid off" />
				<StatusTab href="/loans?status=written_off" active={statusFilter === 'written_off'} label="Written off" />
			</div>

			{enriched.length === 0 ? (
				<div className="rounded-lg border border-zinc-200 bg-white p-10 text-center text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
					{statusFilter === 'active'
						? 'No active loans. Click "New loan" to add one.'
						: `No ${statusFilter} loans.`}
				</div>
			) : (
				<div className="overflow-hidden rounded-xl border border-zinc-400 bg-amber-50 shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 transition-all hover:shadow-amber-600/60 hover:ring-2 hover:ring-amber-600/70 dark:border-zinc-500 dark:bg-amber-950/20 dark:shadow-black/60 dark:ring-white/10 dark:hover:shadow-amber-500/60 dark:hover:ring-amber-500/60">
					<table className="w-full text-sm">
						<thead className="bg-amber-100/60 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-amber-900/30">
							<tr>
								<th className="px-4 py-2 font-medium">Name</th>
								<th className="px-4 py-2 font-medium">Lender</th>
								<th className="px-4 py-2 text-right font-medium">Original</th>
								<th className="px-4 py-2 text-right font-medium">Current balance</th>
								<th className="px-4 py-2 font-medium">Next payment</th>
								<th className="px-4 py-2 text-right font-medium">APR</th>
								<th className="px-4 py-2 font-medium">Status</th>
							</tr>
						</thead>
						<tbody>
							{enriched.map((l) => (
								<tr key={l.id} className="border-t border-zinc-100 dark:border-zinc-800">
									<td className="px-4 py-2 align-top">
										<Link
											href={`/loans/${l.id}`}
											className="font-medium text-blue-600 hover:underline dark:text-blue-400"
										>
											{l.displayName}
										</Link>
										<div className="text-xs text-zinc-500">{l.termMonths} mo · started {l.startDate}</div>
									</td>
									<td className="px-4 py-2 align-top text-zinc-700 dark:text-zinc-300">
										{l.lenderName ?? <span className="text-zinc-400">—</span>}
									</td>
									<td className="px-4 py-2 align-top text-right tabular-nums text-zinc-700 dark:text-zinc-300">
										{CURRENCY_FMT.format(Number(l.originalPrincipal))}
									</td>
									<td className="px-4 py-2 align-top text-right tabular-nums text-zinc-700 dark:text-zinc-300">
										{CURRENCY_FMT.format(Number(l.currentPrincipal))}
									</td>
									<td className="px-4 py-2 align-top text-zinc-700 dark:text-zinc-300">
										{l.nextDueDate && l.nextTotal !== null ? (
											<>
												<div>{l.nextDueDate}</div>
												<div className="text-xs text-zinc-500 tabular-nums">
													{CURRENCY_FMT.format(l.nextTotal)}
												</div>
											</>
										) : (
											<span className="text-zinc-400">—</span>
										)}
									</td>
									<td className="px-4 py-2 align-top text-right tabular-nums text-zinc-700 dark:text-zinc-300">
										{PCT_FMT.format(Number(l.annualInterestRate))}
									</td>
									<td className="px-4 py-2 align-top">
										<span
											className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL_CLS[l.status] ?? STATUS_PILL_CLS.active}`}
										>
											{l.status === 'paid_off' ? 'Paid off' : l.status === 'written_off' ? 'Written off' : 'Active'}
										</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

function StatusTab({ href, active, label }: { href: string; active: boolean; label: string }) {
	return (
		<Link
			href={href}
			aria-pressed={active}
			className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
				active
					? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
					: 'border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900'
			}`}
		>
			{label}
		</Link>
	);
}
