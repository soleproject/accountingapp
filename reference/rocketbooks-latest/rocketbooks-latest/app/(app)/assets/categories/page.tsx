import Link from 'next/link';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	assetCategories,
	chartOfAccounts,
	fixedAssets,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import {
	AssetCategoryRow,
	type AccountOption,
	type CategoryRowData,
} from './_components/AssetCategoryRow';
import { NewAssetCategoryForm } from './_components/NewAssetCategoryForm';

export default async function AssetCategoriesPage() {
	const orgId = await getCurrentOrgId();

	const [categories, accounts, counts] = await Promise.all([
		db
			.select({
				id: assetCategories.id,
				name: assetCategories.name,
				assetAccountId: assetCategories.assetAccountId,
				accumulatedDepAccountId: assetCategories.accumulatedDepAccountId,
				depExpenseAccountId: assetCategories.depExpenseAccountId,
				defaultMethod: assetCategories.defaultMethod,
				defaultUsefulLifeMonths: assetCategories.defaultUsefulLifeMonths,
				defaultAutoDepreciate: assetCategories.defaultAutoDepreciate,
			})
			.from(assetCategories)
			.where(eq(assetCategories.organizationId, orgId))
			.orderBy(asc(assetCategories.name)),
		db
			.select({
				id: chartOfAccounts.id,
				accountNumber: chartOfAccounts.accountNumber,
				accountName: chartOfAccounts.accountName,
				accountType: chartOfAccounts.accountType,
				gaapType: chartOfAccounts.gaapType,
				detailType: chartOfAccounts.detailType,
			})
			.from(chartOfAccounts)
			.where(
				and(
					eq(chartOfAccounts.organizationId, orgId),
					eq(chartOfAccounts.isActive, true),
				),
			)
			.orderBy(asc(chartOfAccounts.accountNumber)),
		// Asset counts per category for the row display.
		db
			.select({
				categoryId: fixedAssets.categoryId,
				n: sql<number>`count(*)::int`,
			})
			.from(fixedAssets)
			.where(eq(fixedAssets.organizationId, orgId))
			.groupBy(fixedAssets.categoryId),
	]);

	// Partition accounts into the three relevant pools so each select only
	// shows the right thing. Asset side = fixed_assets gaap; expense side
	// includes the depreciation slot under other_expense / expenses.
	const fmt = (a: typeof accounts[number]): AccountOption => ({
		id: a.id,
		label: a.accountNumber ? `${a.accountNumber} · ${a.accountName}` : a.accountName,
	});
	const assetAccounts = accounts
		.filter((a) => a.accountType === 'fixed_assets' && a.detailType !== 'accumulated_depreciation' && a.detailType !== 'accumulated_amortization')
		.map(fmt);
	const accumDepAccounts = accounts
		.filter((a) => a.detailType === 'accumulated_depreciation' || a.detailType === 'accumulated_amortization')
		.map(fmt);
	const expenseAccounts = accounts
		.filter((a) => a.gaapType === 'expense')
		.map(fmt);

	const countByCategory = new Map(counts.map((c) => [c.categoryId, c.n]));
	const rows: CategoryRowData[] = categories.map((c) => ({
		id: c.id,
		name: c.name,
		assetAccountId: c.assetAccountId,
		accumulatedDepAccountId: c.accumulatedDepAccountId,
		depExpenseAccountId: c.depExpenseAccountId,
		defaultMethod: c.defaultMethod,
		defaultUsefulLifeMonths: c.defaultUsefulLifeMonths,
		defaultAutoDepreciate: c.defaultAutoDepreciate,
		assetCount: countByCategory.get(c.id) ?? 0,
	}));

	void inArray;

	return (
		<div className="flex flex-col gap-4">
			<Link
				href="/assets"
				className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
			>
				← Back to assets
			</Link>
			<header className="flex items-end justify-between">
				<div>
					<h1 className="text-2xl font-semibold">Asset categories</h1>
					<p className="text-sm text-zinc-500 dark:text-zinc-400">
						Each category binds new assets to a GL triple (asset / accumulated
						depreciation / depreciation expense) plus default depreciation
						method, life, and auto-depreciate setting.
					</p>
				</div>
				<NewAssetCategoryForm
					assetAccounts={assetAccounts}
					accumDepAccounts={accumDepAccounts}
					expenseAccounts={expenseAccounts}
				/>
			</header>

			{rows.length === 0 ? (
				<div className="rounded-lg border border-zinc-200 bg-white p-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
					No categories yet. Click + New category to seed one.
				</div>
			) : (
				<div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
					<table className="w-full text-sm">
						<thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
							<tr>
								<th className="px-4 py-2 font-medium">Name</th>
								<th className="px-4 py-2 font-medium">Asset account</th>
								<th className="px-4 py-2 font-medium">Accum dep</th>
								<th className="px-4 py-2 font-medium">Dep expense</th>
								<th className="px-4 py-2 font-medium">Default method</th>
								<th className="px-4 py-2 font-medium">Default life</th>
								<th className="px-4 py-2 font-medium">Auto</th>
								<th className="px-4 py-2 text-right font-medium" />
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => (
								<AssetCategoryRow
									key={r.id}
									row={r}
									assetAccounts={assetAccounts}
									accumDepAccounts={accumDepAccounts}
									expenseAccounts={expenseAccounts}
								/>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
