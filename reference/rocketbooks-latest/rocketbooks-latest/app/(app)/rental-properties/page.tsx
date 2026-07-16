import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { fixedAssets, rentalProperties } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { DeleteRentalPropertyButton } from './_components/DeleteRentalPropertyButton';

interface AddressShape {
	line?: string | null;
	city?: string | null;
	state?: string | null;
	zip?: string | null;
}

function formatAddress(addr: unknown): string {
	if (!addr || typeof addr !== 'object') return '—';
	const a = addr as AddressShape;
	const parts = [a.line, [a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean);
	return parts.length > 0 ? parts.join(' · ') : '—';
}

function formatMoney(v: string | null): string {
	if (v == null) return '—';
	const n = Number(v);
	if (!Number.isFinite(n)) return '—';
	return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export default async function RentalPropertiesPage() {
	const orgId = await getCurrentOrgId();
	const rows = await db
		.select({
			id: rentalProperties.id,
			displayName: rentalProperties.displayName,
			address: rentalProperties.address,
			status: rentalProperties.status,
			acquiredOn: rentalProperties.acquiredOn,
			fixedAssetId: rentalProperties.fixedAssetId,
			assetCost: fixedAssets.costBasis,
		})
		.from(rentalProperties)
		.leftJoin(fixedAssets, eq(fixedAssets.id, rentalProperties.fixedAssetId))
		.where(eq(rentalProperties.organizationId, orgId))
		.orderBy(asc(rentalProperties.displayName));

	return (
		<div className="flex flex-col gap-4">
			<header className="flex items-end justify-between">
				<div>
					<h1 className="text-2xl font-semibold">Rental Properties</h1>
					<p className="text-sm text-zinc-500 dark:text-zinc-400">
						{rows.length} on file. Each rental income deposit on 430 should be
						tagged to a property here so the spec-required per-property
						sub-ledger ties out (gross income − expenses = net posted to 430).
					</p>
				</div>
				<Link
					href="/rental-properties/new"
					className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
				>
					New property
				</Link>
			</header>

			{rows.length === 0 ? (
				<div className="rounded-lg border border-zinc-200 bg-white p-10 text-center text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
					No properties on file yet. Click &ldquo;New property&rdquo; to add one.
				</div>
			) : (
				<div className="overflow-hidden rounded-lg border border-zinc-400 bg-amber-50 shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 dark:border-zinc-500 dark:bg-amber-950/20 dark:shadow-black/60 dark:ring-white/10">
					<table className="w-full text-sm">
						<thead className="bg-amber-100/60 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-amber-900/30">
							<tr>
								<th className="px-4 py-2 font-medium">Name</th>
								<th className="px-4 py-2 font-medium">Address</th>
								<th className="px-4 py-2 font-medium">Acquired</th>
								<th className="px-4 py-2 text-right font-medium">Cost basis</th>
								<th className="px-4 py-2 font-medium">Asset</th>
								<th className="px-4 py-2 font-medium">Status</th>
								<th className="px-4 py-2 text-right font-medium">Actions</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => (
								<tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
									<td className="px-4 py-2">
										<Link
											href={`/rental-properties/${r.id}`}
											className="font-medium text-blue-600 hover:underline dark:text-blue-400"
										>
											{r.displayName}
										</Link>
									</td>
									<td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{formatAddress(r.address)}</td>
									<td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">
										{r.acquiredOn ?? '—'}
									</td>
									<td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
										{formatMoney(r.assetCost)}
									</td>
									<td className="px-4 py-2">
										{r.fixedAssetId ? (
											<Link
												href={`/assets/${r.fixedAssetId}`}
												className="text-blue-600 hover:underline dark:text-blue-400"
											>
												View
											</Link>
										) : (
											<span className="text-xs text-zinc-400">not linked</span>
										)}
									</td>
									<td className="px-4 py-2">
										<span
											className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
												r.status === 'active'
													? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
													: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
											}`}
										>
											{r.status === 'active' ? 'Active' : r.status}
										</span>
									</td>
									<td className="px-4 py-2">
										<div className="flex items-center justify-end gap-2">
											<Link
												href={`/rental-properties/${r.id}/edit`}
												className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
											>
												Edit
											</Link>
											<DeleteRentalPropertyButton
												propertyId={r.id}
												propertyName={r.displayName}
												hasLinkedAsset={!!r.fixedAssetId}
											/>
										</div>
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
