import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	journalEntries,
	journalEntryLineTags,
	journalEntryLines,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getEntityLabel, loadDimensionMeta } from '@/lib/tags/dimensions';

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (n: number) => CURRENCY_FMT.format(n);

interface PageProps {
	params: Promise<{ type: string; id: string }>;
}

/**
 * Generic per-entity tag rollup. Works for any dimension in the
 * registry — rental property, fixed asset, loan, future user-defined.
 * Mirrors the layout of /rental-properties/[id] and /assets/[id]
 * (gross income / expenses / net + by-account rollup + lines table)
 * but with no dimension-specific code path.
 *
 * Dimension-specific detail pages (/rental-properties/[id],
 * /assets/[id]) carry extra dimension-specific cards (linked asset,
 * cost basis, etc.) and remain the canonical detail for their type.
 * This generic page is the only detail page for dimensions without a
 * dedicated route (loan, future user-defined).
 */
export default async function GenericTagDetailPage({ params }: PageProps) {
	const { type, id } = await params;
	const orgId = await getCurrentOrgId();

	if (!type || typeof type !== 'string') notFound();
	const dim = await loadDimensionMeta(orgId, type);
	if (!dim) notFound();

	const label = await getEntityLabel({
		organizationId: orgId,
		entityType: type,
		entityId: id,
	});
	if (!label) notFound();

	const lines = await db
		.select({
			lineId: journalEntryLines.id,
			jeId: journalEntries.id,
			date: journalEntries.date,
			memo: journalEntries.memo,
			debit: journalEntryLines.debit,
			credit: journalEntryLines.credit,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
			gaapType: chartOfAccounts.gaapType,
		})
		.from(journalEntryLineTags)
		.innerJoin(journalEntryLines, eq(journalEntryLines.id, journalEntryLineTags.journalEntryLineId))
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.where(
			and(
				eq(journalEntryLineTags.organizationId, orgId),
				eq(journalEntryLineTags.entityType, type),
				eq(journalEntryLineTags.entityId, id),
				eq(journalEntries.posted, true),
				isNull(journalEntries.reversalOfId),
			),
		)
		.orderBy(desc(journalEntries.date), desc(journalEntries.createdAt));

	const isIncome = (gt: string) => gt === 'income' || gt === 'revenue';
	const isExpense = (gt: string) => gt === 'expense' || gt === 'expenses';
	let grossIncome = 0;
	let totalExpenses = 0;
	const byAccount = new Map<
		string,
		{
			accountNumber: string | null;
			accountName: string;
			amount: number;
			count: number;
		}
	>();
	for (const l of lines) {
		const debit = Number(l.debit ?? 0);
		const credit = Number(l.credit ?? 0);
		const gt = (l.gaapType ?? '').toLowerCase();
		const contrib = isIncome(gt) ? credit - debit : isExpense(gt) ? debit - credit : 0;
		if (isIncome(gt)) grossIncome += contrib;
		if (isExpense(gt)) totalExpenses += contrib;
		const key = `${l.accountNumber ?? ''}:${l.accountName}`;
		const cur = byAccount.get(key);
		if (cur) {
			cur.amount += contrib;
			cur.count += 1;
		} else {
			byAccount.set(key, {
				accountNumber: l.accountNumber,
				accountName: l.accountName,
				amount: contrib,
				count: 1,
			});
		}
	}
	const net = grossIncome - totalExpenses;
	const summaryRows = Array.from(byAccount.values()).sort((a, b) =>
		(a.accountNumber ?? '').localeCompare(b.accountNumber ?? ''),
	);

	const dedicatedDetailHref = dim.detailPath?.(id) ?? null;

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between">
				<Link
					href="/tags?tab=explorer"
					className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
				>
					← Back to tags
				</Link>
				{dedicatedDetailHref && (
					<Link
						href={dedicatedDetailHref}
						className="text-sm text-blue-600 hover:underline dark:text-blue-400"
					>
						Open dedicated {dim.label.toLowerCase()} page →
					</Link>
				)}
			</div>

			<header>
				<h1 className="text-2xl font-semibold">
					<span aria-hidden>{dim.emoji}</span> {label.label}
				</h1>
				<p className="text-sm text-zinc-500 dark:text-zinc-400">
					{dim.label}
					{label.subLabel && <span> · {label.subLabel}</span>}
				</p>
			</header>

			<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
				<Card title="Gross income">
					<div className="text-2xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
						{money(grossIncome)}
					</div>
				</Card>
				<Card title="Expenses">
					<div className="text-2xl font-semibold tabular-nums text-zinc-700 dark:text-zinc-300">
						{money(totalExpenses)}
					</div>
				</Card>
				<Card title="Net">
					<div
						className={`text-2xl font-semibold tabular-nums ${
							net >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'
						}`}
					>
						{money(net)}
					</div>
				</Card>
			</div>

			<Card title="By account">
				{summaryRows.length === 0 ? (
					<div className="text-sm text-zinc-500">No tagged lines yet.</div>
				) : (
					<table className="w-full text-sm">
						<thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
							<tr>
								<th className="px-2 py-1.5 font-medium">Account</th>
								<th className="px-2 py-1.5 text-right font-medium">Lines</th>
								<th className="px-2 py-1.5 text-right font-medium">Amount</th>
							</tr>
						</thead>
						<tbody>
							{summaryRows.map((r, i) => (
								<tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
									<td className="px-2 py-1.5 text-zinc-700 dark:text-zinc-300">
										{r.accountNumber && (
											<span className="text-zinc-400">{r.accountNumber} · </span>
										)}
										{r.accountName}
									</td>
									<td className="px-2 py-1.5 text-right tabular-nums text-zinc-500">{r.count}</td>
									<td className="px-2 py-1.5 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
										{money(r.amount)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</Card>

			<Card title={`Lines (${lines.length})`}>
				{lines.length === 0 ? (
					<div className="text-sm text-zinc-500">
						No journal lines tagged to this {dim.label.toLowerCase()} yet.
					</div>
				) : (
					<table className="w-full text-sm">
						<thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
							<tr>
								<th className="px-2 py-1.5 font-medium">Date</th>
								<th className="px-2 py-1.5 font-medium">Account</th>
								<th className="px-2 py-1.5 font-medium">Memo</th>
								<th className="px-2 py-1.5 text-right font-medium">Debit</th>
								<th className="px-2 py-1.5 text-right font-medium">Credit</th>
								<th className="px-2 py-1.5 font-medium">JE</th>
							</tr>
						</thead>
						<tbody>
							{lines.map((l) => (
								<tr key={l.lineId} className="border-t border-zinc-100 dark:border-zinc-800">
									<td className="px-2 py-1.5 tabular-nums text-zinc-700 dark:text-zinc-300">
										{l.date}
									</td>
									<td className="px-2 py-1.5 text-zinc-700 dark:text-zinc-300">
										{l.accountNumber && (
											<span className="text-zinc-400">{l.accountNumber} · </span>
										)}
										{l.accountName}
									</td>
									<td className="px-2 py-1.5 text-zinc-500">{l.memo ?? '—'}</td>
									<td className="px-2 py-1.5 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
										{Number(l.debit) > 0 ? money(Number(l.debit)) : '—'}
									</td>
									<td className="px-2 py-1.5 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
										{Number(l.credit) > 0 ? money(Number(l.credit)) : '—'}
									</td>
									<td className="px-2 py-1.5">
										<Link
											href={`/transactions/${l.jeId}`}
											className="text-blue-600 hover:underline dark:text-blue-400"
										>
											View
										</Link>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</Card>
		</div>
	);
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
			<h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</h2>
			{children}
		</section>
	);
}
