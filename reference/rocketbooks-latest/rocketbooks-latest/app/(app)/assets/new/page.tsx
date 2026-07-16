import Link from 'next/link';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { assetCategories, fixedAssets } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { NewAssetForm, type CategoryOption } from './_components/NewAssetForm';

export default async function NewAssetPage() {
	const orgId = await getCurrentOrgId();

	const [categoryRows, activeAssets] = await Promise.all([
		db
			.select({
				id: assetCategories.id,
				name: assetCategories.name,
				defaultMethod: assetCategories.defaultMethod,
				defaultUsefulLifeMonths: assetCategories.defaultUsefulLifeMonths,
				defaultAutoDepreciate: assetCategories.defaultAutoDepreciate,
			})
			.from(assetCategories)
			.where(eq(assetCategories.organizationId, orgId))
			.orderBy(asc(assetCategories.name)),
		// Replaced-asset + parent-asset dropdowns pull from active or
		// disposed (replacing a recently-disposed asset via 1031 is the
		// common case). Drafts are excluded — they aren't really assets yet.
		db
			.select({ id: fixedAssets.id, name: fixedAssets.name })
			.from(fixedAssets)
			.where(
				and(
					eq(fixedAssets.organizationId, orgId),
					inArray(fixedAssets.status, ['active', 'disposed']),
				),
			)
			.orderBy(asc(fixedAssets.name)),
	]);

	const categories: CategoryOption[] = categoryRows;

	return (
		<div className="flex flex-col gap-4">
			<Link
				href="/assets"
				className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
			>
				← Back to assets
			</Link>
			<header>
				<h1 className="text-2xl font-semibold">Register a new asset</h1>
				<p className="text-sm text-zinc-500 dark:text-zinc-400">
					Posts a beginning-balance JE: debit the category&rsquo;s asset account, credit Trust Corpus.
					If you supply prior accumulated depreciation, the JE also debits Trust Corpus + credits Accumulated Depreciation so the book value lands at the migrated number.
				</p>
			</header>

			{categories.length === 0 ? (
				<div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
					No asset categories exist on this org yet. Run the trust seed script or visit{' '}
					<Link href="/assets/categories" className="underline">
						/assets/categories
					</Link>{' '}
					to create one.
				</div>
			) : (
				<NewAssetForm categories={categories} activeAssets={activeAssets} />
			)}
		</div>
	);
}
