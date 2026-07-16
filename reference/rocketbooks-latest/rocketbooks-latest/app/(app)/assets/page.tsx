import Link from 'next/link';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	assetBooks,
	assetCategories,
	assetDepreciationRuns,
	assetSettings,
	chartOfAccounts,
	fixedAssets,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { RunDepreciationButton } from './_components/RunDepreciationButton';
import { AssetSettingsCard } from './_components/AssetSettingsCard';

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

interface PageProps {
	searchParams: Promise<{ status?: string }>;
}

const VALID_STATUSES = ['active', 'draft', 'disposed', 'all'] as const;
type StatusFilter = (typeof VALID_STATUSES)[number];

export default async function AssetsPage({ searchParams }: PageProps) {
	const orgId = await getCurrentOrgId();
	const sp = await searchParams;
	const statusFilter: StatusFilter = (VALID_STATUSES as readonly string[]).includes(sp.status ?? '')
		? (sp.status as StatusFilter)
		: 'active';

	const where = statusFilter === 'all'
		? eq(fixedAssets.organizationId, orgId)
		: and(eq(fixedAssets.organizationId, orgId), eq(fixedAssets.status, statusFilter));

	// One query joins assets → fiduciary book → category → asset COA
	// row. We pull the fiduciary book's accumulated depreciation so the
	// register row can show book value without a per-row recompute.
	const rows = await db
		.select({
			id: fixedAssets.id,
			name: fixedAssets.name,
			assetNumber: fixedAssets.assetNumber,
			status: fixedAssets.status,
			acquisitionType: fixedAssets.acquisitionType,
			inServiceDate: fixedAssets.inServiceDate,
			costBasis: fixedAssets.costBasis,
			fmvAtDod: fixedAssets.fmvAtDod,
			disposedAt: fixedAssets.disposedAt,
			categoryName: assetCategories.name,
			assetAccountNumber: chartOfAccounts.accountNumber,
			accumulatedDepreciation: assetBooks.accumulatedDepreciation,
			bookType: assetBooks.bookType,
		})
		.from(fixedAssets)
		.innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
		.leftJoin(chartOfAccounts, eq(chartOfAccounts.id, assetCategories.assetAccountId))
		.leftJoin(
			assetBooks,
			and(
				eq(assetBooks.assetId, fixedAssets.id),
				eq(assetBooks.bookType, 'fiduciary'),
			),
		)
		.where(where)
		.orderBy(asc(fixedAssets.inServiceDate));

	// Aggregate counts for the status tab strip.
	const counts = await db
		.select({
			status: fixedAssets.status,
			n: sql<number>`count(*)::int`,
		})
		.from(fixedAssets)
		.where(eq(fixedAssets.organizationId, orgId))
		.groupBy(fixedAssets.status);
	const countByStatus = new Map(counts.map((c) => [c.status, c.n]));
	const totalCount = counts.reduce((a, c) => a + c.n, 0);

	// Most-recent fiduciary-book run, used for the header strip.
	const [lastRun] = await db
		.select({
			periodEndDate: assetDepreciationRuns.periodEndDate,
			totalExpense: assetDepreciationRuns.totalExpense,
			assetsIncluded: assetDepreciationRuns.assetsIncluded,
		})
		.from(assetDepreciationRuns)
		.where(
			and(
				eq(assetDepreciationRuns.organizationId, orgId),
				eq(assetDepreciationRuns.bookType, 'fiduciary'),
			),
		)
		.orderBy(desc(assetDepreciationRuns.periodEndDate))
		.limit(1);

	// Per-org settings (cron on/off + default-auto-flag for new assets).
	// Defaults to off when no row exists — trustees opt in.
	const [settings] = await db
		.select({
			cronEnabled: assetSettings.cronEnabled,
			defaultAutoDepreciate: assetSettings.defaultAutoDepreciate,
		})
		.from(assetSettings)
		.where(eq(assetSettings.organizationId, orgId))
		.limit(1);
	const resolvedSettings = settings ?? { cronEnabled: false, defaultAutoDepreciate: false };

	const totalCost = rows.reduce((a, r) => a + Number(r.costBasis), 0);
	const totalAccum = rows.reduce((a, r) => a + Number(r.accumulatedDepreciation ?? 0), 0);
	const totalBookValue = totalCost - totalAccum;

	return (
		<div className="flex flex-col gap-4">
			<header className="flex items-end justify-between">
				<div>
					<h1 className="text-2xl font-semibold">Assets</h1>
					<p className="text-sm text-zinc-500 dark:text-zinc-400">
						{totalCount} on file ·{' '}
						{rows.length} {statusFilter === 'all' ? 'shown' : statusFilter} ·{' '}
						{CURRENCY_FMT.format(totalCost)} cost ·{' '}
						{CURRENCY_FMT.format(totalBookValue)} book value
					</p>
				</div>
				<div className="flex items-center gap-2">
					<RunDepreciationButton />
					<Link
						href="/assets/categories"
						className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
					>
						Categories
					</Link>
					<Link
						href="/assets/new"
						className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
					>
						+ Add asset
					</Link>
				</div>
			</header>

			<AssetSettingsCard initial={resolvedSettings} />

			<div className="flex items-center gap-2 text-sm">
				<StatusTab href="/assets?status=active" active={statusFilter === 'active'} label="Active" count={countByStatus.get('active') ?? 0} />
				<StatusTab href="/assets?status=draft" active={statusFilter === 'draft'} label="Draft" count={countByStatus.get('draft') ?? 0} />
				<StatusTab href="/assets?status=disposed" active={statusFilter === 'disposed'} label="Disposed" count={countByStatus.get('disposed') ?? 0} />
				<StatusTab href="/assets?status=all" active={statusFilter === 'all'} label="All" count={totalCount} />
				{lastRun && (
					<span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">
						Last run: {lastRun.periodEndDate} · {lastRun.assetsIncluded} asset
						{lastRun.assetsIncluded === 1 ? '' : 's'} ·{' '}
						{CURRENCY_FMT.format(Number(lastRun.totalExpense))}
					</span>
				)}
			</div>

			{rows.length === 0 ? (
				<div className="rounded-lg border border-zinc-200 bg-white p-10 text-center text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
					{statusFilter === 'active' && totalCount > 0
						? 'No active assets — check the Draft or Disposed tabs.'
						: 'No assets on file yet. Click + Add asset to register one.'}
				</div>
			) : (
				<div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
					<table className="w-full text-sm">
						<thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
							<tr>
								<th className="px-4 py-2 font-medium">Name</th>
								<th className="px-4 py-2 font-medium">Category</th>
								<th className="px-4 py-2 font-medium">In service</th>
								<th className="px-4 py-2 font-medium">Acquisition</th>
								<th className="px-4 py-2 text-right font-medium">Cost</th>
								<th className="px-4 py-2 text-right font-medium">Accum dep</th>
								<th className="px-4 py-2 text-right font-medium">Book value</th>
								<th className="px-4 py-2 font-medium">Status</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => {
								const cost = Number(r.costBasis);
								const accum = Number(r.accumulatedDepreciation ?? 0);
								const bookValue = cost - accum;
								return (
									<tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
										<td className="px-4 py-2 align-top text-zinc-700 dark:text-zinc-300">
											<Link href={`/assets/${r.id}`} className="font-medium hover:underline">
												{r.name}
											</Link>
											{r.assetNumber && (
												<div className="font-mono text-xs text-zinc-500">#{r.assetNumber}</div>
											)}
										</td>
										<td className="px-4 py-2 align-top text-zinc-700 dark:text-zinc-300">
											{r.categoryName}
											{r.assetAccountNumber && (
												<div className="font-mono text-[10px] text-zinc-500">acct {r.assetAccountNumber}</div>
											)}
										</td>
										<td className="px-4 py-2 align-top tabular-nums text-zinc-700 dark:text-zinc-300">
											{r.inServiceDate}
										</td>
										<td className="px-4 py-2 align-top text-zinc-700 dark:text-zinc-300">
											<AcquisitionPill type={r.acquisitionType} />
										</td>
										<td className="px-4 py-2 align-top text-right tabular-nums text-zinc-700 dark:text-zinc-300">
											{CURRENCY_FMT.format(cost)}
											{r.acquisitionType === 'inherited' && r.fmvAtDod && (
												<div className="text-xs text-zinc-500">
													FMV {CURRENCY_FMT.format(Number(r.fmvAtDod))}
												</div>
											)}
										</td>
										<td className="px-4 py-2 align-top text-right tabular-nums text-zinc-700 dark:text-zinc-300">
											{CURRENCY_FMT.format(accum)}
										</td>
										<td className="px-4 py-2 align-top text-right tabular-nums font-medium text-zinc-800 dark:text-zinc-200">
											{CURRENCY_FMT.format(bookValue)}
										</td>
										<td className="px-4 py-2 align-top">
											<StatusPill status={r.status} disposedAt={r.disposedAt} />
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

function StatusTab({
	href,
	active,
	label,
	count,
}: {
	href: string;
	active: boolean;
	label: string;
	count: number;
}) {
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
			{label} <span className="ml-1 text-xs opacity-75">{count.toLocaleString()}</span>
		</Link>
	);
}

function StatusPill({ status, disposedAt }: { status: string; disposedAt: string | null }) {
	const cls =
		status === 'active'
			? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
			: status === 'draft'
				? 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
				: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200';
	return (
		<div>
			<span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${cls}`}>
				{status}
			</span>
			{status === 'disposed' && disposedAt && (
				<div className="mt-0.5 text-xs text-zinc-500">on {disposedAt}</div>
			)}
		</div>
	);
}

function AcquisitionPill({ type }: { type: string }) {
	const label =
		type === 'purchased'
			? 'Purchased'
			: type === 'inherited'
				? 'Inherited'
				: type === 'exchanged_1031'
					? '§1031 exchange'
					: type === 'contributed'
						? 'Contributed'
						: type;
	const cls =
		type === 'inherited'
			? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
			: type === 'exchanged_1031'
				? 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200'
				: type === 'contributed'
					? 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200'
					: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
	return (
		<span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
			{label}
		</span>
	);
}
