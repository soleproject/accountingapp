import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { assetCategories } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { RentalPropertyForm, type CategoryPick } from '../_components/RentalPropertyForm';

export default async function NewRentalPropertyPage() {
	const orgId = await getCurrentOrgId();

	const categories: CategoryPick[] = await db
		.select({
			id: assetCategories.id,
			name: assetCategories.name,
			defaultMethod: assetCategories.defaultMethod,
			defaultUsefulLifeMonths: assetCategories.defaultUsefulLifeMonths,
		})
		.from(assetCategories)
		.where(eq(assetCategories.organizationId, orgId))
		.orderBy(asc(assetCategories.name));

	// Heuristic: pre-select the first category whose name contains "building"
	// (case-insensitive). Falls through to the first option otherwise.
	const defaultCategoryId =
		categories.find((c) => /building/i.test(c.name))?.id ?? null;

	return (
		<div className="flex flex-col gap-4">
			<header>
				<h1 className="text-2xl font-semibold">New rental property</h1>
				<p className="text-sm text-zinc-500 dark:text-zinc-400">
					Creates the building as a fixed asset and links it back here so 430
					rental-income deposits can roll up to the per-property sub-ledger.
				</p>
			</header>
			<RentalPropertyForm categories={categories} defaultCategoryId={defaultCategoryId} />
		</div>
	);
}
