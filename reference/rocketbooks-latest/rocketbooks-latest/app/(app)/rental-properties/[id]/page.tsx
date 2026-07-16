import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	documentRecords,
	fixedAssets,
	journalEntries,
	journalEntryLineTags,
	journalEntryLines,
	rentalProperties,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { DeleteRentalPropertyButton } from '../_components/DeleteRentalPropertyButton';

interface PageProps {
	params: Promise<{ id: string }>;
}

interface AddressShape {
	line?: string | null;
	city?: string | null;
	state?: string | null;
	zip?: string | null;
}

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function formatAddress(addr: unknown): string {
	if (!addr || typeof addr !== 'object') return '—';
	const a = addr as AddressShape;
	const parts = [a.line, [a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean);
	return parts.length > 0 ? parts.join(' · ') : '—';
}

function money(n: number): string {
	return CURRENCY_FMT.format(n);
}

export default async function RentalPropertyDetailPage({ params }: PageProps) {
	const { id } = await params;
	const orgId = await getCurrentOrgId();

	const [property] = await db
		.select({
			id: rentalProperties.id,
			displayName: rentalProperties.displayName,
			address: rentalProperties.address,
			status: rentalProperties.status,
			acquiredOn: rentalProperties.acquiredOn,
			fixedAssetId: rentalProperties.fixedAssetId,
			assetCost: fixedAssets.costBasis,
			assetInService: fixedAssets.inServiceDate,
			assetStatus: fixedAssets.status,
			assetCategoryId: fixedAssets.categoryId,
		})
		.from(rentalProperties)
		.leftJoin(fixedAssets, eq(fixedAssets.id, rentalProperties.fixedAssetId))
		.where(and(eq(rentalProperties.id, id), eq(rentalProperties.organizationId, orgId)))
		.limit(1);
	if (!property) notFound();

	// Most-recent lease resolution on file for this property (linked
	// via sourceKind='rental_property'). Used to flip the header
	// affordance between "Draft" and "View" — the unique index on
	// (org, sourceKind, sourceId) where status<>'voided' guarantees
	// at most one non-voided lease at a time. Tenant changes void the
	// prior lease and draft a new one (handled by the user, not yet
	// automated).
	const linkedLease =
		property.status === 'active'
			? (
				await db
					.select({ id: documentRecords.id, status: documentRecords.status })
					.from(documentRecords)
					.where(
						and(
							eq(documentRecords.organizationId, orgId),
							eq(documentRecords.sourceKind, 'rental_property'),
							eq(documentRecords.sourceId, property.id),
							eq(documentRecords.templateId, 'lease-resolution'),
						),
					)
					.orderBy(desc(documentRecords.createdAt))
					.limit(1)
			)[0] ?? null
			: null;

	// Sub-ledger lines: every JE line tagged with this property, on posted
	// JEs that aren't reversals (reversals carry their own reversalOfId).
	// The originals that were reversed are still included here — a fuller
	// "exclude reversed originals" pass needs a NOT IN subquery and the
	// data shape doesn't yet warrant it for v1.
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
				eq(journalEntryLineTags.entityType, 'rental_property'),
				eq(journalEntryLineTags.entityId, id),
				eq(journalEntries.posted, true),
				isNull(journalEntries.reversalOfId),
			),
		)
		.orderBy(desc(journalEntries.date), desc(journalEntries.createdAt));

	type GaapType = string;
	const isIncome = (gt: GaapType) => gt === 'income' || gt === 'revenue';
	const isExpense = (gt: GaapType) => gt === 'expenses' || gt === 'expense';

	// Income lines contribute credit - debit (positive = income).
	// Expense lines contribute debit - credit (positive = expense).
	let grossIncome = 0;
	let totalExpenses = 0;
	const byAccount = new Map<
		string,
		{
			accountNumber: string | null;
			accountName: string;
			gaapType: string;
			amount: number;
			count: number;
		}
	>();
	for (const l of lines) {
		const debit = Number(l.debit ?? 0);
		const credit = Number(l.credit ?? 0);
		const gt = l.gaapType ?? '';
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
				gaapType: gt,
				amount: contrib,
				count: 1,
			});
		}
	}
	const net = grossIncome - totalExpenses;
	const summaryRows = Array.from(byAccount.values()).sort(
		(a, b) => (a.accountNumber ?? '').localeCompare(b.accountNumber ?? ''),
	);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between gap-3">
				<Link
					href="/rental-properties"
					className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
				>
					← Back to rental properties
				</Link>
				<div className="flex items-center gap-2">
					{property.status === 'active' && (
						linkedLease && linkedLease.status !== 'voided' ? (
							<Link
								href={`/trust-documents/${linkedLease.id}`}
								className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
								title="Lease resolution on file for this property"
							>
								View lease resolution
							</Link>
						) : (
							<Link
								href={`/trust-documents/new?template=lease-resolution&fromRental=${property.id}`}
								className="rounded-md border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-sm font-medium text-cyan-700 hover:bg-cyan-100 dark:border-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300 dark:hover:bg-cyan-900/50"
								title="Draft a trustee lease resolution prefilled from this property"
							>
								Draft lease resolution
							</Link>
						)
					)}
					<Link
						href={`/rental-properties/${property.id}/edit`}
						className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
					>
						Edit
					</Link>
					<DeleteRentalPropertyButton
						propertyId={property.id}
						propertyName={property.displayName}
						hasLinkedAsset={!!property.fixedAssetId}
					/>
				</div>
			</div>

			<header>
				<h1 className="text-2xl font-semibold">{property.displayName}</h1>
				<p className="text-sm text-zinc-500 dark:text-zinc-400">
					{formatAddress(property.address)}
					{property.acquiredOn && <span> · Acquired {property.acquiredOn}</span>}
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
				<Card title="Net (should match 430)">
					<div
						className={`text-2xl font-semibold tabular-nums ${
							net >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'
						}`}
					>
						{money(net)}
					</div>
				</Card>
			</div>

			<Card title="Linked building (fixed asset)">
				{property.fixedAssetId ? (
					<div className="flex items-center justify-between gap-4 text-sm">
						<div className="flex flex-col gap-0.5">
							<div className="text-zinc-700 dark:text-zinc-200">
								Cost basis:{' '}
								<span className="tabular-nums">
									{money(Number(property.assetCost ?? 0))}
								</span>
							</div>
							<div className="text-xs text-zinc-500">
								In service {property.assetInService ?? '—'} ·{' '}
								<span className="capitalize">{property.assetStatus ?? '—'}</span>
							</div>
						</div>
						<Link
							href={`/assets/${property.fixedAssetId}`}
							className="text-blue-600 hover:underline dark:text-blue-400"
						>
							Open asset →
						</Link>
					</div>
				) : (
					<div className="text-sm text-zinc-500">
						No building asset linked. This property was created before the asset
						link was wired — delete and recreate it to capture cost basis on the
						balance sheet.
					</div>
				)}
			</Card>

			<Card title="By account">
				{summaryRows.length === 0 ? (
					<div className="text-sm text-zinc-500">
						No journal lines tagged to this property yet. Tag a 430 rental
						income line on the trust review page (or via a transaction edit) to
						start the sub-ledger.
					</div>
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
									<td className="px-2 py-1.5 text-right tabular-nums text-zinc-500">
										{r.count}
									</td>
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
						No journal lines tagged to this property yet.
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
