import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	assetBooks,
	assetCategories,
	chartOfAccounts,
	documentRecords,
	fixedAssets,
	journalEntries,
	journalEntryLineTags,
	journalEntryLines,
	loans,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { DisposeAssetButton } from './_components/DisposeAssetButton';
import { EditAssetForm } from './_components/EditAssetForm';

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

interface PageProps {
	params: Promise<{ id: string }>;
}

export default async function AssetDetailPage({ params }: PageProps) {
	const { id } = await params;
	const orgId = await getCurrentOrgId();

	const [asset] = await db
		.select({
			id: fixedAssets.id,
			name: fixedAssets.name,
			assetNumber: fixedAssets.assetNumber,
			serialNumber: fixedAssets.serialNumber,
			location: fixedAssets.location,
			notes: fixedAssets.notes,
			status: fixedAssets.status,
			acquisitionType: fixedAssets.acquisitionType,
			inServiceDate: fixedAssets.inServiceDate,
			costBasis: fixedAssets.costBasis,
			fmvAtDod: fixedAssets.fmvAtDod,
			alternateValuationDate: fixedAssets.alternateValuationDate,
			replacedAssetId: fixedAssets.replacedAssetId,
			carryoverBasis: fixedAssets.carryoverBasis,
			excessBasis: fixedAssets.excessBasis,
			parentAssetId: fixedAssets.parentAssetId,
			salvageValue: fixedAssets.salvageValue,
			autoDepreciate: fixedAssets.autoDepreciate,
			disposedAt: fixedAssets.disposedAt,
			disposalProceeds: fixedAssets.disposalProceeds,
			categoryName: assetCategories.name,
			assetAccountId: assetCategories.assetAccountId,
			assetAccountNumber: chartOfAccounts.accountNumber,
			assetAccountName: chartOfAccounts.accountName,
		})
		.from(fixedAssets)
		.innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
		.leftJoin(chartOfAccounts, eq(chartOfAccounts.id, assetCategories.assetAccountId))
		.where(
			and(
				eq(fixedAssets.id, id),
				eq(fixedAssets.organizationId, orgId),
			),
		)
		.limit(1);
	if (!asset) notFound();

	// Per-book schedule snapshot.
	const books = await db
		.select({
			bookType: assetBooks.bookType,
			method: assetBooks.method,
			usefulLifeMonths: assetBooks.usefulLifeMonths,
			convention: assetBooks.convention,
			accumulatedDepreciation: assetBooks.accumulatedDepreciation,
			accumulatedThroughDate: assetBooks.accumulatedThroughDate,
		})
		.from(assetBooks)
		.where(eq(assetBooks.assetId, asset.id))
		.orderBy(assetBooks.bookType);

	// JE history sourced from this asset (sourceType='fixed_asset' +
	// sourceId=asset.id). Lets the user see the beginning-balance post,
	// any depreciation runs that included it (Phase 4), and disposal
	// entries (Phase 4).
	const jeHistory = await db
		.select({
			id: journalEntries.id,
			date: journalEntries.date,
			memo: journalEntries.memo,
		})
		.from(journalEntries)
		.where(
			and(
				eq(journalEntries.organizationId, orgId),
				eq(journalEntries.sourceType, 'fixed_asset'),
				eq(journalEntries.sourceId, asset.id),
			),
		)
		.orderBy(desc(journalEntries.date));

	const fiduciaryBook = books.find((b) => b.bookType === 'fiduciary');
	const cost = Number(asset.costBasis);
	const depBasis = asset.acquisitionType === 'inherited' && asset.fmvAtDod
		? Number(asset.fmvAtDod)
		: cost;
	const accum = Number(fiduciaryBook?.accumulatedDepreciation ?? 0);
	const bookValue = depBasis - accum;

	// Bank accounts available as the proceeds-recipient on the dispose
	// modal. Pulled once with the rest of the page data — small list.
	const bankAccts = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.organizationId, orgId),
				eq(chartOfAccounts.isActive, true),
				inArray(chartOfAccounts.accountType, ['bank']),
			),
		)
		.orderBy(asc(chartOfAccounts.accountNumber));
	const bankAccounts = bankAccts.map((b) => ({
		id: b.id,
		label: b.accountNumber ? `${b.accountNumber} · ${b.accountName}` : b.accountName,
	}));

	const canEdit = asset.status !== 'disposed';
	const canDispose = asset.status === 'active';

	// Linked Bill of Sale (contributed / inherited assets only). When
	// one already exists for this asset, the header shows "View Bill
	// of Sale" instead of "Draft" — auto-draft idempotency means we
	// never spawn duplicates, and the affordance should reflect that.
	const linkedBillOfSale =
		asset.acquisitionType === 'contributed' || asset.acquisitionType === 'inherited'
			? (
				await db
					.select({ id: documentRecords.id, status: documentRecords.status })
					.from(documentRecords)
					.where(
						and(
							eq(documentRecords.organizationId, orgId),
							eq(documentRecords.sourceKind, 'fixed_asset'),
							eq(documentRecords.sourceId, asset.id),
							eq(documentRecords.templateId, 'bill-of-sale'),
						),
					)
					.orderBy(desc(documentRecords.createdAt))
					.limit(1)
			)[0] ?? null
			: null;

	// Is this asset real property by category name? Mirrors the
	// heuristic in prefillRealEstatePurchaseFromAsset — keeps the
	// gating consistent between "show the button" and "actually
	// prefill the form."
	const categoryLower = (asset.categoryName ?? '').toLowerCase();
	const isRealProperty =
		categoryLower.includes('land')
		|| categoryLower.includes('building')
		|| categoryLower.includes('real')
		|| categoryLower.includes('property');

	// Linked Real Estate Purchase / Sale resolutions. Mirror the
	// Bill-of-Sale and Disposition queries — when one already exists
	// for this asset, the button flips from "Draft" → "View".
	const linkedRePurchase =
		isRealProperty && asset.acquisitionType === 'purchased'
			? (
				await db
					.select({ id: documentRecords.id, status: documentRecords.status })
					.from(documentRecords)
					.where(
						and(
							eq(documentRecords.organizationId, orgId),
							eq(documentRecords.sourceKind, 'fixed_asset'),
							eq(documentRecords.sourceId, asset.id),
							eq(documentRecords.templateId, 'real-estate-purchase'),
						),
					)
					.orderBy(desc(documentRecords.createdAt))
					.limit(1)
			)[0] ?? null
			: null;

	const linkedReSale =
		isRealProperty && asset.status === 'disposed'
			? (
				await db
					.select({ id: documentRecords.id, status: documentRecords.status })
					.from(documentRecords)
					.where(
						and(
							eq(documentRecords.organizationId, orgId),
							eq(documentRecords.sourceKind, 'fixed_asset'),
							eq(documentRecords.sourceId, asset.id),
							eq(documentRecords.templateId, 'real-estate-sale'),
						),
					)
					.orderBy(desc(documentRecords.createdAt))
					.limit(1)
			)[0] ?? null
			: null;

	// Linked Insurance Authorization. Available for any active asset
	// regardless of acquisition type. Idempotency note: we DON'T flip
	// to "View" when one exists — a single asset may carry multiple
	// concurrent policies (property + umbrella + valuable-items
	// floater), so each click should be free to draft another. The
	// uniqueness index on (org, sourceKind, sourceId) is keyed on
	// templateId too, but here we want re-drafts intentionally allowed;
	// drop the "Draft" affordance only when there's any non-voided
	// insurance on file as a soft hint, but keep the path open via
	// the catalog if needed.
	const linkedInsurance =
		asset.status !== 'disposed'
			? (
				await db
					.select({ id: documentRecords.id, status: documentRecords.status })
					.from(documentRecords)
					.where(
						and(
							eq(documentRecords.organizationId, orgId),
							eq(documentRecords.sourceKind, 'fixed_asset'),
							eq(documentRecords.sourceId, asset.id),
							eq(documentRecords.templateId, 'insurance-authorization'),
						),
					)
					.orderBy(desc(documentRecords.createdAt))
					.limit(1)
			)[0] ?? null
			: null;

	// Linked Disposition Resolution (disposed assets only). The
	// disposeAsset hook auto-spawns one; the asset detail page shows
	// "View disposition resolution" when it exists, or "Draft" as a
	// fallback for assets disposed before this feature shipped.
	const linkedDisposition =
		asset.status === 'disposed'
			? (
				await db
					.select({ id: documentRecords.id, status: documentRecords.status })
					.from(documentRecords)
					.where(
						and(
							eq(documentRecords.organizationId, orgId),
							eq(documentRecords.sourceKind, 'fixed_asset'),
							eq(documentRecords.sourceId, `disposed:${asset.id}`),
							eq(documentRecords.templateId, 'asset-disposition-resolution'),
						),
					)
					.orderBy(desc(documentRecords.createdAt))
					.limit(1)
			)[0] ?? null
			: null;

	// Loans linked to this asset (could be 0, 1, or many — a building can
	// have a 1st mortgage + a HELOC). Used to derive Net equity in the
	// header and warn the dispose flow when payoff is required.
	const linkedLoans = await db
		.select({
			id: loans.id,
			displayName: loans.displayName,
			currentPrincipal: loans.currentPrincipal,
			originalPrincipal: loans.originalPrincipal,
			status: loans.status,
		})
		.from(loans)
		.where(
			and(
				eq(loans.organizationId, orgId),
				eq(loans.collateralAssetId, asset.id),
			),
		)
		.orderBy(asc(loans.displayName));
	const totalLoanBalance = linkedLoans.reduce(
		(a, l) => a + Number(l.currentPrincipal),
		0,
	);
	const netEquity = bookValue - totalLoanBalance;

	// Lines tagged with this asset's fixed_asset_id (set via the Tags
	// panel on a transaction). Distinct from the JE history above —
	// that filters by sourceType='fixed_asset'; this surfaces every
	// other transaction the user attributed to the asset (repairs,
	// fuel, etc.). Posted, non-reversal JEs only.
	const taggedLines = await db
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
				eq(journalEntryLineTags.entityType, 'fixed_asset'),
				eq(journalEntryLineTags.entityId, asset.id),
				eq(journalEntries.posted, true),
				isNull(journalEntries.reversalOfId),
			),
		)
		.orderBy(desc(journalEntries.date), desc(journalEntries.createdAt));
	const totalTaggedSpend = taggedLines.reduce((acc, l) => {
		const gt = (l.gaapType ?? '').toLowerCase();
		if (gt === 'expense' || gt === 'expenses') {
			return acc + (Number(l.debit) - Number(l.credit));
		}
		return acc;
	}, 0);

	return (
		<div className="flex flex-col gap-6">
			<Link
				href="/assets"
				className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
			>
				← Back to assets
			</Link>
			<header className="flex items-start justify-between gap-4">
				<div className="min-w-0 flex-1">
					<h1 className="text-2xl font-semibold">{asset.name}</h1>
					<p className="text-sm text-zinc-500 dark:text-zinc-400">
						{asset.categoryName}
						{asset.assetNumber && <> · #{asset.assetNumber}</>}
						{asset.serialNumber && <> · SN {asset.serialNumber}</>}
					</p>
				</div>
				<div className="flex shrink-0 items-start gap-3">
					<div className="text-right">
						<div className="text-2xl font-semibold tabular-nums">
							{CURRENCY_FMT.format(bookValue)}
						</div>
						<div className="text-xs text-zinc-500">book value</div>
					</div>
					<div className="flex items-center gap-2">
						{asset.acquisitionType === 'purchased' && (
							<Link
								href={`/trust-documents/new?template=asset-acquisition-resolution&fromAsset=${asset.id}`}
								className="rounded-md border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-100 dark:border-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300 dark:hover:bg-cyan-900/50"
								title="Draft a trustee resolution authorizing this purchase"
							>
								Draft acquisition resolution
							</Link>
						)}
						{(asset.acquisitionType === 'contributed' || asset.acquisitionType === 'inherited') && (
							linkedBillOfSale && linkedBillOfSale.status !== 'voided' ? (
								<Link
									href={`/trust-documents/${linkedBillOfSale.id}`}
									className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
									title="Bill of Sale documenting this contribution"
								>
									View Bill of Sale
								</Link>
							) : (
								<Link
									href={`/trust-documents/new?template=bill-of-sale&fromAsset=${asset.id}`}
									className="rounded-md border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-100 dark:border-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300 dark:hover:bg-cyan-900/50"
									title="Draft the per-event Bill of Sale documenting this contribution"
								>
									Draft Bill of Sale
								</Link>
							)
						)}
						{asset.status === 'disposed' && (
							linkedDisposition && linkedDisposition.status !== 'voided' ? (
								<Link
									href={`/trust-documents/${linkedDisposition.id}`}
									className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
									title="Disposition resolution for this asset"
								>
									View disposition resolution
								</Link>
							) : (
								<Link
									href={`/trust-documents/new?template=asset-disposition-resolution&fromAsset=${asset.id}`}
									className="rounded-md border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-100 dark:border-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300 dark:hover:bg-cyan-900/50"
									title="Draft a trustee resolution authorizing this disposition"
								>
									Draft disposition resolution
								</Link>
							)
						)}
						{isRealProperty && asset.acquisitionType === 'purchased' && (
							linkedRePurchase && linkedRePurchase.status !== 'voided' ? (
								<Link
									href={`/trust-documents/${linkedRePurchase.id}`}
									className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
									title="Real Estate Purchase resolution for this asset"
								>
									View RE purchase resolution
								</Link>
							) : (
								<Link
									href={`/trust-documents/new?template=real-estate-purchase&fromAsset=${asset.id}`}
									className="rounded-md border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-100 dark:border-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300 dark:hover:bg-cyan-900/50"
									title="Draft the full RE-specific purchase resolution (vesting, due-on-sale, title insurance, recording)"
								>
									Draft RE purchase resolution
								</Link>
							)
						)}
						{isRealProperty && asset.status === 'disposed' && (
							linkedReSale && linkedReSale.status !== 'voided' ? (
								<Link
									href={`/trust-documents/${linkedReSale.id}`}
									className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
									title="Real Estate Sale resolution for this asset"
								>
									View RE sale resolution
								</Link>
							) : (
								<Link
									href={`/trust-documents/new?template=real-estate-sale&fromAsset=${asset.id}`}
									className="rounded-md border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-100 dark:border-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300 dark:hover:bg-cyan-900/50"
									title="Draft the full RE-specific sale resolution (§1001 gain calc, §1250 split, §121 recital)"
								>
									Draft RE sale resolution
								</Link>
							)
						)}
						{asset.status !== 'disposed' && (
							linkedInsurance && linkedInsurance.status !== 'voided' ? (
								<Link
									href={`/trust-documents/${linkedInsurance.id}`}
									className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
									title="Insurance authorization on file for this asset"
								>
									View insurance auth
								</Link>
							) : (
								<Link
									href={`/trust-documents/new?template=insurance-authorization&fromAsset=${asset.id}`}
									className="rounded-md border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-100 dark:border-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300 dark:hover:bg-cyan-900/50"
									title="Draft UTC §809 insurance authorization for this asset"
								>
									Draft insurance auth
								</Link>
							)
						)}
						{canEdit && (
							<EditAssetForm
								assetId={asset.id}
								initial={{
									name: asset.name,
									assetNumber: asset.assetNumber,
									serialNumber: asset.serialNumber,
									location: asset.location,
									notes: asset.notes,
									autoDepreciate: asset.autoDepreciate,
								}}
							/>
						)}
						{canDispose && (
							<DisposeAssetButton
								assetId={asset.id}
								assetName={asset.name}
								bookValue={bookValue}
								bankAccounts={bankAccounts}
							/>
						)}
					</div>
				</div>
			</header>

			<section className="grid grid-cols-1 gap-4 md:grid-cols-3">
				<Card label="Acquisition">
					<div className="font-medium capitalize">
						{asset.acquisitionType.replace('_', ' ')}
					</div>
					<div className="text-xs text-zinc-500">in service {asset.inServiceDate}</div>
				</Card>
				<Card label="Cost basis">
					<div className="font-medium tabular-nums">{CURRENCY_FMT.format(cost)}</div>
					{asset.acquisitionType === 'inherited' && asset.fmvAtDod && (
						<div className="text-xs text-zinc-500">
							FMV at DOD: {CURRENCY_FMT.format(Number(asset.fmvAtDod))}
							{asset.alternateValuationDate && (
								<> · AVD {asset.alternateValuationDate}</>
							)}
						</div>
					)}
					{asset.acquisitionType === 'exchanged_1031' && (
						<div className="text-xs text-zinc-500">
							{asset.carryoverBasis && (
								<>Carryover {CURRENCY_FMT.format(Number(asset.carryoverBasis))}</>
							)}
							{asset.excessBasis && (
								<>{asset.carryoverBasis ? ' · ' : ''}Excess {CURRENCY_FMT.format(Number(asset.excessBasis))}</>
							)}
						</div>
					)}
				</Card>
				<Card label="Status">
					<div className="font-medium capitalize">{asset.status}</div>
					{asset.disposedAt && (
						<div className="text-xs text-zinc-500">
							disposed {asset.disposedAt}
							{asset.disposalProceeds != null && (
								<> · proceeds {CURRENCY_FMT.format(Number(asset.disposalProceeds))}</>
							)}
						</div>
					)}
					{asset.status === 'active' && (
						<div className="text-xs text-zinc-500">
							Auto-depreciate: {asset.autoDepreciate ? 'on' : 'off'}
						</div>
					)}
				</Card>
			</section>

			{asset.assetAccountNumber && (
				<section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
					<div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						GL account
					</div>
					<div className="mt-1 text-sm">
						<span className="font-mono text-xs text-zinc-500">{asset.assetAccountNumber}</span>{' '}
						{asset.assetAccountName}
					</div>
				</section>
			)}

			{linkedLoans.length > 0 && (
				<section>
					<div className="mb-2 flex items-end justify-between">
						<h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
							Linked loans
						</h2>
						<div className="text-right text-xs text-zinc-500">
							<div>
								Book value{' '}
								<span className="tabular-nums text-zinc-700 dark:text-zinc-300">
									{CURRENCY_FMT.format(bookValue)}
								</span>{' '}
								− Loans{' '}
								<span className="tabular-nums text-zinc-700 dark:text-zinc-300">
									{CURRENCY_FMT.format(totalLoanBalance)}
								</span>
							</div>
							<div className="mt-0.5">
								Net equity{' '}
								<span
									className={`font-semibold tabular-nums ${
										netEquity >= 0
											? 'text-emerald-700 dark:text-emerald-400'
											: 'text-rose-700 dark:text-rose-400'
									}`}
								>
									{CURRENCY_FMT.format(netEquity)}
								</span>
							</div>
						</div>
					</div>
					<div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
						<table className="w-full text-sm">
							<thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
								<tr>
									<th className="px-4 py-2 font-medium">Loan</th>
									<th className="px-4 py-2 text-right font-medium">Original</th>
									<th className="px-4 py-2 text-right font-medium">Current balance</th>
									<th className="px-4 py-2 font-medium">Status</th>
								</tr>
							</thead>
							<tbody>
								{linkedLoans.map((l) => (
									<tr key={l.id} className="border-t border-zinc-100 dark:border-zinc-800">
										<td className="px-4 py-2">
											<Link
												href={`/loans/${l.id}`}
												className="text-blue-700 hover:underline dark:text-blue-400"
											>
												{l.displayName}
											</Link>
										</td>
										<td className="px-4 py-2 text-right tabular-nums">
											{CURRENCY_FMT.format(Number(l.originalPrincipal))}
										</td>
										<td className="px-4 py-2 text-right tabular-nums font-medium">
											{CURRENCY_FMT.format(Number(l.currentPrincipal))}
										</td>
										<td className="px-4 py-2 text-xs capitalize">{l.status}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</section>
			)}

			<section>
				<h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
					Depreciation books
				</h2>
				<div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
					<table className="w-full text-sm">
						<thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
							<tr>
								<th className="px-4 py-2 font-medium">Book</th>
								<th className="px-4 py-2 font-medium">Method</th>
								<th className="px-4 py-2 font-medium">Life</th>
								<th className="px-4 py-2 font-medium">Convention</th>
								<th className="px-4 py-2 text-right font-medium">Accumulated</th>
								<th className="px-4 py-2 font-medium">Through</th>
							</tr>
						</thead>
						<tbody>
							{books.map((b) => (
								<tr key={b.bookType} className="border-t border-zinc-100 dark:border-zinc-800">
									<td className="px-4 py-2 capitalize">{b.bookType}</td>
									<td className="px-4 py-2 capitalize">{b.method.replace(/_/g, ' ')}</td>
									<td className="px-4 py-2 tabular-nums">
										{Math.round(b.usefulLifeMonths / 12)} yr
										<span className="text-xs text-zinc-500"> ({b.usefulLifeMonths} mo)</span>
									</td>
									<td className="px-4 py-2 capitalize">{b.convention.replace('_', ' ')}</td>
									<td className="px-4 py-2 text-right tabular-nums">
										{CURRENCY_FMT.format(Number(b.accumulatedDepreciation))}
									</td>
									<td className="px-4 py-2 tabular-nums">{b.accumulatedThroughDate ?? '—'}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>

			<section>
				<h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
					Journal entries
				</h2>
				{jeHistory.length === 0 ? (
					<div className="rounded-lg border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
						No JEs yet. Beginning-balance and depreciation entries will appear here.
					</div>
				) : (
					<div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
						<table className="w-full text-sm">
							<thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
								<tr>
									<th className="px-4 py-2 font-medium">Date</th>
									<th className="px-4 py-2 font-medium">JE</th>
									<th className="px-4 py-2 font-medium">Memo</th>
								</tr>
							</thead>
							<tbody>
								{jeHistory.map((je) => (
									<tr key={je.id} className="border-t border-zinc-100 dark:border-zinc-800">
										<td className="px-4 py-2 tabular-nums">{je.date}</td>
										<td className="px-4 py-2">
											<Link
												href={`/journal-entries/${je.id}`}
												className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
											>
												{je.id.slice(0, 8)}
											</Link>
										</td>
										<td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{je.memo ?? '—'}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>

			<section>
				<div className="mb-2 flex items-baseline justify-between gap-2">
					<h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
						Tagged transactions ({taggedLines.length})
					</h2>
					{totalTaggedSpend > 0 && (
						<span className="text-xs text-zinc-500">
							Expense tagged to this asset:{' '}
							<span className="font-medium tabular-nums text-zinc-700 dark:text-zinc-300">
								{CURRENCY_FMT.format(totalTaggedSpend)}
							</span>
						</span>
					)}
				</div>
				{taggedLines.length === 0 ? (
					<div className="rounded-lg border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
						No transactions tagged to this asset yet. Open a transaction and use
						the Tags panel to attribute spend (repairs, fuel, etc.).
					</div>
				) : (
					<div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
						<table className="w-full text-sm">
							<thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
								<tr>
									<th className="px-4 py-2 font-medium">Date</th>
									<th className="px-4 py-2 font-medium">Account</th>
									<th className="px-4 py-2 font-medium">Memo</th>
									<th className="px-4 py-2 text-right font-medium">Debit</th>
									<th className="px-4 py-2 text-right font-medium">Credit</th>
									<th className="px-4 py-2 font-medium">JE</th>
								</tr>
							</thead>
							<tbody>
								{taggedLines.map((l) => (
									<tr key={l.lineId} className="border-t border-zinc-100 dark:border-zinc-800">
										<td className="px-4 py-2 tabular-nums">{l.date}</td>
										<td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
											{l.accountNumber && (
												<span className="text-zinc-400">{l.accountNumber} · </span>
											)}
											{l.accountName}
										</td>
										<td className="px-4 py-2 text-zinc-500">{l.memo ?? '—'}</td>
										<td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
											{Number(l.debit) > 0 ? CURRENCY_FMT.format(Number(l.debit)) : '—'}
										</td>
										<td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
											{Number(l.credit) > 0 ? CURRENCY_FMT.format(Number(l.credit)) : '—'}
										</td>
										<td className="px-4 py-2">
											<Link
												href={`/transactions/${l.jeId}`}
												className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
											>
												{l.jeId.slice(0, 8)}
											</Link>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>

			{asset.notes && (
				<section>
					<h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
						Notes
					</h2>
					<div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
						{asset.notes}
					</div>
				</section>
			)}
		</div>
	);
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
			<div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
			<div className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{children}</div>
		</div>
	);
}
