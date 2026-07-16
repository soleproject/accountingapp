import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { tagDimensions, tagDimensionValues } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { SYSTEM_TAG_DIMENSIONS } from '@/lib/tags/dimensions';
import { NewDimensionForm } from './NewDimensionForm';
import { UserDimensionCard, type UserDimensionRow, type UserDimensionValueRow } from './UserDimensionCard';

/**
 * Manage tab. Read-only list of system dimensions + CRUD for
 * user-defined dimensions (Class, Location, custom) and their values.
 *
 * User-defined dimensions don't participate in auto-tag memory in v1
 * because the semantics are unknown — a "Department" tag isn't
 * vendor-stable the way "this rental property" is. Can be opt-in
 * later via a column on tag_dimensions.
 */
export async function TagManageView() {
	const orgId = await getCurrentOrgId();

	const dimRows = await db
		.select({
			id: tagDimensions.id,
			slug: tagDimensions.slug,
			label: tagDimensions.label,
			emoji: tagDimensions.emoji,
		})
		.from(tagDimensions)
		.where(eq(tagDimensions.organizationId, orgId))
		.orderBy(asc(tagDimensions.sortOrder), asc(tagDimensions.label));

	// Bulk-load all values + per-value usage counts in one round-trip
	// each, then bucket client-side. Avoids N+1 across dimensions.
	const dimIds = dimRows.map((d) => d.id);
	const allValues = dimIds.length
		? await db
				.select({
					id: tagDimensionValues.id,
					dimensionId: tagDimensionValues.dimensionId,
					label: tagDimensionValues.label,
					archivedAt: tagDimensionValues.archivedAt,
				})
				.from(tagDimensionValues)
				.where(
					and(
						eq(tagDimensionValues.organizationId, orgId),
						inArray(tagDimensionValues.dimensionId, dimIds),
					),
				)
				.orderBy(asc(tagDimensionValues.sortOrder), asc(tagDimensionValues.label))
		: [];

	const valuesByDim = new Map<string, UserDimensionValueRow[]>();
	for (const v of allValues) {
		const list = valuesByDim.get(v.dimensionId) ?? [];
		list.push({
			id: v.id,
			label: v.label,
			archived: !!v.archivedAt,
		});
		valuesByDim.set(v.dimensionId, list);
	}

	const userDims: UserDimensionRow[] = dimRows.map((d) => ({
		id: d.id,
		slug: d.slug,
		label: d.label,
		emoji: d.emoji,
		values: valuesByDim.get(d.id) ?? [],
	}));

	return (
		<div className="flex flex-col gap-6">
			<section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
				<header className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
					<h2 className="text-base font-medium">System dimensions</h2>
					<p className="text-xs text-zinc-500 dark:text-zinc-400">
						Built-in tag dimensions backed by typed entity tables. Every JE
						line can carry one tag per dimension.
					</p>
				</header>
				<table className="w-full text-sm">
					<thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
						<tr>
							<th className="px-4 py-2 font-medium">Dimension</th>
							<th className="px-4 py-2 font-medium">Slug</th>
							<th className="px-4 py-2 font-medium">Auto-tag</th>
							<th className="px-4 py-2 font-medium">Detail page</th>
						</tr>
					</thead>
					<tbody>
						{SYSTEM_TAG_DIMENSIONS.map((d) => (
							<tr key={d.entityType} className="border-t border-zinc-100 dark:border-zinc-800">
								<td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
									<span aria-hidden>{d.emoji}</span> {d.label}
									<span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-800">
										system
									</span>
								</td>
								<td className="px-4 py-2">
									<code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
										{d.entityType}
									</code>
								</td>
								<td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
									{d.participatesInAutoTag ? (
										<span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200">
											on
										</span>
									) : (
										<span className="text-xs text-zinc-400">off</span>
									)}
								</td>
								<td className="px-4 py-2 text-xs text-zinc-500">
									{d.detailPath
										? d.detailPath('{id}')
										: <span className="text-zinc-400">— none —</span>}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>

			<section className="flex flex-col gap-3">
				<div className="flex items-center justify-between gap-3">
					<div>
						<h2 className="text-base font-medium">User-defined dimensions</h2>
						<p className="text-xs text-zinc-500 dark:text-zinc-400">
							Create your own tag dimensions (Class, Location, Department,
							anything else). They show up in the same Tags panel and BulkBar
							as system dimensions, with their own value list.
						</p>
					</div>
				</div>

				<NewDimensionForm />

				{userDims.length === 0 ? (
					<div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/40">
						No user-defined dimensions yet. Add one above.
					</div>
				) : (
					<div className="flex flex-col gap-3">
						{userDims.map((d) => (
							<UserDimensionCard key={d.id} dimension={d} />
						))}
					</div>
				)}
			</section>
		</div>
	);
}
