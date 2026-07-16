import 'server-only';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	trustReviewFindings,
	journalEntries,
	journalEntryLines,
	chartOfAccounts,
	trustBeneficiaries,
	fixedAssets,
	assetBooks,
	assetCategories,
	contacts,
	documentRecords,
	transactions,
	rentalProperties,
} from '@/db/schema/schema';

export interface DistributionAuthorizationPrefill {
	beneficiaryName: string;
	beneficiaryRelationship: string | null;
	amountCents: number;
	distributionDate: string;
	taxYear: number;
	sourceAccountLabel: string | null;
	sourceFindingId: string;
}

/**
 * Pull a `TRUST_310_FLAG_K1_ISSUANCE` finding (or any 310-distribution
 * flavored finding with the same shape) into the variable set the
 * Distribution Authorization template expects. The user reviews +
 * fills in purpose / standardApplied / character before drafting —
 * we never make up those judgment-call fields.
 *
 * Returns null when:
 *   - the finding doesn't exist or belongs to a different org
 *   - the JE doesn't have a 310-shaped beneficiary distribution line
 *
 * For prefill from other finding codes (asset acquisition, etc.), add
 * a parallel function with its own return type; don't overload this
 * one — different findings hand off to different templates.
 */
export async function prefillDistributionFromFinding(args: {
	organizationId: string;
	findingId: string;
}): Promise<DistributionAuthorizationPrefill | null> {
	const [finding] = await db
		.select({
			id: trustReviewFindings.id,
			code: trustReviewFindings.code,
			organizationId: trustReviewFindings.organizationId,
			journalEntryId: trustReviewFindings.journalEntryId,
		})
		.from(trustReviewFindings)
		.where(eq(trustReviewFindings.id, args.findingId))
		.limit(1);
	if (!finding) return null;
	if (finding.organizationId !== args.organizationId) return null;
	if (finding.code !== 'TRUST_310_FLAG_K1_ISSUANCE') return null;

	const [je] = await db
		.select({
			id: journalEntries.id,
			date: journalEntries.date,
		})
		.from(journalEntries)
		.where(eq(journalEntries.id, finding.journalEntryId))
		.limit(1);
	if (!je) return null;

	// Distribution lines: debit to a 310-detail-type account, tagged
	// with the beneficiary. Sum their debits — JEs can have multiple
	// 310 lines if a single distribution event splits across
	// characters (e.g., part DNI, part principal).
	const distributionLines = await db
		.select({
			debit: journalEntryLines.debit,
			beneficiaryId: journalEntryLines.beneficiaryId,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
			detailType: chartOfAccounts.detailType,
		})
		.from(journalEntryLines)
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.where(
			and(
				eq(journalEntryLines.journalEntryId, je.id),
				eq(chartOfAccounts.detailType, 'trust_distribution'),
				sql`${journalEntryLines.beneficiaryId} IS NOT NULL`,
			),
		);

	if (distributionLines.length === 0) return null;

	const amountCents = Math.round(
		distributionLines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0) * 100,
	);
	if (amountCents <= 0) return null;

	const beneId = distributionLines[0].beneficiaryId;
	if (!beneId) return null;

	const [bene] = await db
		.select({
			fullName: trustBeneficiaries.fullName,
			relationship: trustBeneficiaries.relationship,
		})
		.from(trustBeneficiaries)
		.where(eq(trustBeneficiaries.id, beneId))
		.limit(1);
	if (!bene) return null;

	const sourceLine = distributionLines[0];
	const sourceAccountLabel = sourceLine.accountNumber
		? `${sourceLine.accountNumber} ${sourceLine.accountName}`
		: sourceLine.accountName;

	const taxYear = Number.parseInt(je.date.slice(0, 4), 10);

	return {
		beneficiaryName: bene.fullName,
		beneficiaryRelationship: bene.relationship ?? null,
		amountCents,
		distributionDate: je.date,
		taxYear,
		sourceAccountLabel,
		sourceFindingId: finding.id,
	};
}

export interface AssetAcquisitionPrefill {
	assetDescription: string;
	vendorName: string;
	vendorAddress: string | null;
	costCents: number;
	fundingSource: 'cash' | 'financed' | 'mixed';
	acquisitionDate: string;
	fixedAssetId: string;
}

/**
 * Pull a fixed_assets row into the variables the Asset Acquisition
 * Resolution template expects. Only meaningful when
 * acquisitionType='purchased' — contributed / inherited assets use
 * the Bill of Sale template instead, and 1031 exchanges deserve
 * their own template (not in Phase 1 scope).
 *
 * Tries hard to populate vendor: first from the source-transaction's
 * contact (Plaid vendor), then leaves blank. Falls back gracefully
 * — the user can always type a vendor name on the form.
 */
export async function prefillAssetAcquisitionFromAsset(args: {
	organizationId: string;
	fixedAssetId: string;
}): Promise<AssetAcquisitionPrefill | null> {
	const [asset] = await db
		.select({
			id: fixedAssets.id,
			name: fixedAssets.name,
			assetNumber: fixedAssets.assetNumber,
			serialNumber: fixedAssets.serialNumber,
			location: fixedAssets.location,
			notes: fixedAssets.notes,
			costBasis: fixedAssets.costBasis,
			inServiceDate: fixedAssets.inServiceDate,
			acquisitionType: fixedAssets.acquisitionType,
			sourceTransactionId: fixedAssets.sourceTransactionId,
			organizationId: fixedAssets.organizationId,
		})
		.from(fixedAssets)
		.where(eq(fixedAssets.id, args.fixedAssetId))
		.limit(1);
	if (!asset) return null;
	if (asset.organizationId !== args.organizationId) return null;
	if (asset.acquisitionType !== 'purchased') return null;

	// Build a description string that reads cleanly in the recital
	// paragraph. Asset number / serial / location appended when
	// available — successor trustees inventorying years from now will
	// want every identifier.
	const descriptionParts: string[] = [asset.name];
	if (asset.assetNumber) descriptionParts.push(`Asset # ${asset.assetNumber}`);
	if (asset.serialNumber) descriptionParts.push(`Serial / VIN: ${asset.serialNumber}`);
	if (asset.location) descriptionParts.push(`Location: ${asset.location}`);
	if (asset.notes) descriptionParts.push(asset.notes);
	const assetDescription = descriptionParts.join(' · ');

	// Vendor from the source transaction if we have one. Plaid txns
	// typically carry the vendor as transactions.contactId; falling
	// through to empty is fine.
	let vendorName = '';
	let vendorAddress: string | null = null;
	if (asset.sourceTransactionId) {
		const [txn] = await db
			.select({ contactId: transactions.contactId })
			.from(transactions)
			.where(
				and(
					eq(transactions.id, asset.sourceTransactionId),
					eq(transactions.organizationId, args.organizationId),
				),
			)
			.limit(1);
		if (txn?.contactId) {
			const [c] = await db
				.select({ contactName: contacts.contactName, address: contacts.address })
				.from(contacts)
				.where(eq(contacts.id, txn.contactId))
				.limit(1);
			if (c) {
				vendorName = c.contactName;
				// contacts.address is jsonb — only surface a flat-text
				// preview when the JSON has a recognizable shape.
				const addr = c.address as { line1?: string; city?: string; state?: string; postalCode?: string } | null;
				if (addr) {
					const flat = [addr.line1, addr.city, addr.state, addr.postalCode]
						.filter(Boolean)
						.join(', ');
					vendorAddress = flat || null;
				}
			}
		}
	}

	const costCents = Math.round(Number(asset.costBasis) * 100);

	return {
		assetDescription,
		vendorName,
		vendorAddress,
		costCents,
		fundingSource: 'cash',
		acquisitionDate: asset.inServiceDate,
		fixedAssetId: asset.id,
	};
}

export interface BillOfSaleAssetPrefill {
	sellerName: string;
	sellerAddress: string | null;
	assetDescription: string;
	assetType: 'vehicle' | 'real_property' | 'equipment' | 'investment' | 'other';
	considerationCents: number;
	paymentTerms: 'demand_note' | 'cash' | 'mixed';
	transferDate: string;
	demandNoteAccountLabel: string | null;
	sourceAssetId: string;
}

/**
 * Pull a fixed_assets row (contributed or inherited) into Bill of
 * Sale variables. Mirrors prefillAssetAcquisitionFromAsset shape
 * but inverts the recital — Bill of Sale is the per-event contribution
 * doc; Asset Acquisition Resolution is for purchases. Only meaningful
 * when acquisitionType IN ('contributed','inherited').
 *
 * The seller is the grantor (settlor) of the trust by default — the
 * trust's source-doc spec treats every contribution as a sale-to-
 * trust from the grantor. When a real fixed_assets.sourceTransactionId
 * points to a different vendor, we surface that vendor instead.
 */
export async function prefillBillOfSaleFromAsset(args: {
	organizationId: string;
	fixedAssetId: string;
}): Promise<BillOfSaleAssetPrefill | null> {
	const [asset] = await db
		.select({
			id: fixedAssets.id,
			name: fixedAssets.name,
			assetNumber: fixedAssets.assetNumber,
			serialNumber: fixedAssets.serialNumber,
			location: fixedAssets.location,
			notes: fixedAssets.notes,
			costBasis: fixedAssets.costBasis,
			inServiceDate: fixedAssets.inServiceDate,
			acquisitionType: fixedAssets.acquisitionType,
			sourceTransactionId: fixedAssets.sourceTransactionId,
			categoryName: assetCategories.name,
			organizationId: fixedAssets.organizationId,
		})
		.from(fixedAssets)
		.innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
		.where(eq(fixedAssets.id, args.fixedAssetId))
		.limit(1);
	if (!asset) return null;
	if (asset.organizationId !== args.organizationId) return null;
	if (asset.acquisitionType !== 'contributed' && asset.acquisitionType !== 'inherited') {
		return null;
	}

	const descriptionParts: string[] = [asset.name];
	if (asset.assetNumber) descriptionParts.push(`Asset # ${asset.assetNumber}`);
	if (asset.serialNumber) descriptionParts.push(`Serial / VIN: ${asset.serialNumber}`);
	if (asset.location) descriptionParts.push(`Location: ${asset.location}`);
	if (asset.notes) descriptionParts.push(asset.notes);
	const assetDescription = descriptionParts.join(' · ');

	// Map the asset category to a Bill of Sale assetType. Imperfect —
	// real-world category names vary — but covers the common cases.
	const cat = (asset.categoryName ?? '').toLowerCase();
	const assetType: BillOfSaleAssetPrefill['assetType'] =
		cat.includes('vehicle') || cat.includes('auto') ? 'vehicle'
		: cat.includes('land') || cat.includes('building') || cat.includes('real') || cat.includes('property') ? 'real_property'
		: cat.includes('equip') || cat.includes('machinery') || cat.includes('furniture') ? 'equipment'
		: cat.includes('invest') || cat.includes('security') ? 'investment'
		: 'other';

	// Seller: grantor-on-record by default. The spec treats contributions
	// as sale-to-trust from the grantor; when a real vendor exists on the
	// source transaction we surface that instead (rare for contributions
	// but possible).
	let sellerName = '';
	let sellerAddress: string | null = null;
	if (asset.sourceTransactionId) {
		const [txn] = await db
			.select({ contactId: transactions.contactId })
			.from(transactions)
			.where(
				and(
					eq(transactions.id, asset.sourceTransactionId),
					eq(transactions.organizationId, args.organizationId),
				),
			)
			.limit(1);
		if (txn?.contactId) {
			const [c] = await db
				.select({ contactName: contacts.contactName, address: contacts.address })
				.from(contacts)
				.where(eq(contacts.id, txn.contactId))
				.limit(1);
			if (c) {
				sellerName = c.contactName;
				const addr = c.address as { line1?: string; city?: string; state?: string; postalCode?: string } | null;
				if (addr) {
					const flat = [addr.line1, addr.city, addr.state, addr.postalCode].filter(Boolean).join(', ');
					sellerAddress = flat || null;
				}
			}
		}
	}

	return {
		sellerName,
		sellerAddress,
		assetDescription,
		assetType,
		considerationCents: Math.round(Number(asset.costBasis) * 100),
		paymentTerms: 'demand_note',
		transferDate: asset.inServiceDate,
		demandNoteAccountLabel: null,
		sourceAssetId: asset.id,
	};
}

export interface BillOfSaleFromDepositPrefill {
	sellerName: string;
	sellerAddress: string | null;
	assetDescription: string;
	assetType: 'other';
	considerationCents: number;
	paymentTerms: 'cash';
	transferDate: string;
	demandNoteAccountLabel: null;
	sourceFindingId: string;
}

/**
 * Pull a TRUST_DEPOSIT_CLASSIFIED_AS_CORPUS finding into Bill of
 * Sale variables. Cash-contribution shape — paymentTerms='cash',
 * assetType='other' (the contribution is currency, not a fixed
 * asset). Description summarizes the deposit so a successor trustee
 * can reconcile the doc against the GL.
 */
export async function prefillBillOfSaleFromCorpusFinding(args: {
	organizationId: string;
	findingId: string;
}): Promise<BillOfSaleFromDepositPrefill | null> {
	const [finding] = await db
		.select({
			id: trustReviewFindings.id,
			code: trustReviewFindings.code,
			organizationId: trustReviewFindings.organizationId,
			journalEntryId: trustReviewFindings.journalEntryId,
			metadata: trustReviewFindings.metadata,
		})
		.from(trustReviewFindings)
		.where(eq(trustReviewFindings.id, args.findingId))
		.limit(1);
	if (!finding) return null;
	if (finding.organizationId !== args.organizationId) return null;
	if (
		finding.code !== 'TRUST_DEPOSIT_CLASSIFIED_AS_CORPUS'
		&& finding.code !== 'TRUST_DEPOSIT_SPLIT_CORPUS_AND_INCOME'
	) return null;

	const meta = (finding.metadata ?? {}) as { accountId?: string };
	const targetAccountId = meta.accountId;

	const [je] = await db
		.select({
			id: journalEntries.id,
			date: journalEntries.date,
			memo: journalEntries.memo,
			sourceType: journalEntries.sourceType,
			sourceId: journalEntries.sourceId,
		})
		.from(journalEntries)
		.where(eq(journalEntries.id, finding.journalEntryId))
		.limit(1);
	if (!je) return null;

	// The deposit credit lives on the corpus equity account. Sum it.
	const corpusLines = targetAccountId
		? await db
				.select({
					credit: journalEntryLines.credit,
					memo: journalEntryLines.memo,
				})
				.from(journalEntryLines)
				.where(
					and(
						eq(journalEntryLines.journalEntryId, je.id),
						eq(journalEntryLines.accountId, targetAccountId),
					),
				)
		: [];
	const totalCredit = corpusLines.reduce((acc, l) => acc + Number(l.credit ?? 0), 0);
	if (totalCredit <= 0) return null;

	// Seller (depositor) — look at the JE's source transaction's contact
	// for a vendor name. Often the grantor sending the contribution.
	let sellerName = '';
	let sellerAddress: string | null = null;
	if (je.sourceType === 'transaction' && je.sourceId) {
		const [txn] = await db
			.select({ contactId: transactions.contactId, bankDescription: transactions.bankDescription })
			.from(transactions)
			.where(
				and(
					eq(transactions.id, je.sourceId),
					eq(transactions.organizationId, args.organizationId),
				),
			)
			.limit(1);
		if (txn?.contactId) {
			const [c] = await db
				.select({ contactName: contacts.contactName, address: contacts.address })
				.from(contacts)
				.where(eq(contacts.id, txn.contactId))
				.limit(1);
			if (c) {
				sellerName = c.contactName;
				const addr = c.address as { line1?: string; city?: string; state?: string; postalCode?: string } | null;
				if (addr) {
					const flat = [addr.line1, addr.city, addr.state, addr.postalCode].filter(Boolean).join(', ');
					sellerAddress = flat || null;
				}
			}
		}
	}

	const descLines: string[] = [
		`Cash contribution of $${(totalCredit).toFixed(2)} on ${je.date}.`,
	];
	if (je.memo) descLines.push(`Memo: ${je.memo}`);
	const assetDescription = descLines.join(' ');

	return {
		sellerName,
		sellerAddress,
		assetDescription,
		assetType: 'other',
		considerationCents: Math.round(totalCredit * 100),
		paymentTerms: 'cash',
		transferDate: je.date,
		demandNoteAccountLabel: null,
		sourceFindingId: finding.id,
	};
}

export interface CapitalGainToCorpusPrefill {
	assetDescription: string;
	amountCents: number;
	gainDate: string;
	taxYear: number;
	holdingPeriodNote: string | null;
	sourceFindingId: string;
}

/**
 * Pull a TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_CORPUS audit finding
 * into the variables the Capital Gain to Corpus memo expects.
 *
 * Asset description is derived from the JE memo / line memo because
 * the JE doesn't have a structured "asset sold" field — capital-gain
 * JEs typically post just the gain credit + the offsetting basis
 * decrease, without a richer asset link. The user can refine the
 * description on the form before drafting.
 *
 * Trustee's allocation justification + trust-instrument citation are
 * NOT prefilled — those are judgment-call fields and the audit trail
 * needs them in the trustee's own words.
 */
export async function prefillCapitalGainToCorpusFromFinding(args: {
	organizationId: string;
	findingId: string;
}): Promise<CapitalGainToCorpusPrefill | null> {
	const [finding] = await db
		.select({
			id: trustReviewFindings.id,
			code: trustReviewFindings.code,
			organizationId: trustReviewFindings.organizationId,
			journalEntryId: trustReviewFindings.journalEntryId,
			metadata: trustReviewFindings.metadata,
		})
		.from(trustReviewFindings)
		.where(eq(trustReviewFindings.id, args.findingId))
		.limit(1);
	if (!finding) return null;
	if (finding.organizationId !== args.organizationId) return null;
	if (finding.code !== 'TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_CORPUS') return null;

	const meta = (finding.metadata ?? {}) as { accountId?: string; amount?: number };

	const [je] = await db
		.select({
			id: journalEntries.id,
			date: journalEntries.date,
			memo: journalEntries.memo,
		})
		.from(journalEntries)
		.where(eq(journalEntries.id, finding.journalEntryId))
		.limit(1);
	if (!je) return null;

	// Sum the credit on the corpus account from this JE to get the
	// actual gain amount. Fall back to metadata.amount if no line
	// matches (shouldn't happen for a fresh JE, but defensive).
	let amountCents = Math.round(Number(meta.amount ?? 0) * 100);
	let lineMemo: string | null = null;
	if (meta.accountId) {
		const lines = await db
			.select({ credit: journalEntryLines.credit, memo: journalEntryLines.memo })
			.from(journalEntryLines)
			.where(
				and(
					eq(journalEntryLines.journalEntryId, je.id),
					eq(journalEntryLines.accountId, meta.accountId),
				),
			);
		const sum = lines.reduce((acc, l) => acc + Number(l.credit ?? 0), 0);
		if (sum > 0) amountCents = Math.round(sum * 100);
		lineMemo = lines[0]?.memo ?? null;
	}
	if (amountCents <= 0) return null;

	const assetDescription = lineMemo ?? je.memo ?? 'Long-term capital gain — describe the disposed asset';
	const taxYear = Number.parseInt(je.date.slice(0, 4), 10);

	return {
		assetDescription,
		amountCents,
		gainDate: je.date,
		taxYear,
		holdingPeriodNote: null,
		sourceFindingId: finding.id,
	};
}

export interface ScheduleAAssetItem {
	name: string;
	categoryName: string | null;
	acquisitionType: 'contributed' | 'inherited';
	costBasisCents: number;
	fmvCents: number | null;
	inServiceDate: string;
	assetNumber: string | null;
	serialNumber: string | null;
	location: string | null;
}

export interface ScheduleAPrefill {
	revision: number;
	asOfDate: string;
	assets: ScheduleAAssetItem[];
}

/**
 * Snapshot every contributed/inherited asset in the trust's fixed-
 * asset register into the Schedule A template variables. Also picks
 * the next revision number by counting existing Schedule A document
 * records — revision 1 is the initial, 2+ are Amendments.
 *
 * Disposed assets are excluded — they're not in corpus today. If a
 * trustee needs the schedule "as of" a historical date that included
 * a now-disposed asset, the user can edit the prefilled list before
 * drafting.
 */
export async function prefillScheduleA(args: {
	organizationId: string;
}): Promise<ScheduleAPrefill> {
	const rows = await db
		.select({
			name: fixedAssets.name,
			categoryName: assetCategories.name,
			acquisitionType: fixedAssets.acquisitionType,
			costBasis: fixedAssets.costBasis,
			fmvAtDod: fixedAssets.fmvAtDod,
			inServiceDate: fixedAssets.inServiceDate,
			assetNumber: fixedAssets.assetNumber,
			serialNumber: fixedAssets.serialNumber,
			location: fixedAssets.location,
		})
		.from(fixedAssets)
		.innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
		.where(
			and(
				eq(fixedAssets.organizationId, args.organizationId),
				inArray(fixedAssets.acquisitionType, ['contributed', 'inherited']),
				sql`${fixedAssets.status} <> 'disposed'`,
			),
		)
		.orderBy(asc(fixedAssets.inServiceDate), asc(fixedAssets.name));

	const assets: ScheduleAAssetItem[] = rows.map((r) => ({
		name: r.name,
		categoryName: r.categoryName ?? null,
		acquisitionType: r.acquisitionType as 'contributed' | 'inherited',
		costBasisCents: Math.round(Number(r.costBasis) * 100),
		// FMV is meaningful for inherited assets (FMV at date of death
		// becomes the basis). For contributed, fall back to cost basis.
		fmvCents: r.fmvAtDod != null
			? Math.round(Number(r.fmvAtDod) * 100)
			: Math.round(Number(r.costBasis) * 100),
		inServiceDate: r.inServiceDate,
		assetNumber: r.assetNumber ?? null,
		serialNumber: r.serialNumber ?? null,
		location: r.location ?? null,
	}));

	// Revision = 1 + number of prior schedule-a docs that have been
	// drafted on this org (any status). We count by templateId, not
	// by document presence in /trust-documents — a deleted Schedule A
	// still occupied a revision slot conceptually, but we count
	// existing docs so deletes "reclaim" the revision number. That's
	// the simpler behavior and matches user expectation.
	const [{ n: priorCount }] = await db
		.select({ n: count() })
		.from(documentRecords)
		.where(
			and(
				eq(documentRecords.organizationId, args.organizationId),
				eq(documentRecords.templateId, 'schedule-a'),
			),
		);

	return {
		revision: Number(priorCount ?? 0) + 1,
		asOfDate: new Date().toISOString().slice(0, 10),
		assets,
	};
}

export interface AssetDispositionPrefill {
	assetDescription: string;
	dispositionDate: string;
	buyerName: string | null;
	buyerAddress: string | null;
	method: 'sale' | 'write_off' | 'trade_in' | 'abandonment' | 'other';
	proceedsCents: number;
	feesCents: number;
	costBasisCents: number;
	accumulatedDepreciationCents: number;
	gainOrLossCents: number;
	holdingPeriodNote: string | null;
	fixedAssetId: string;
}

/**
 * Pull a disposed fixed_assets row into Asset Disposition Resolution
 * variables. Refuses to prefill when status !== 'disposed' (the
 * Resolution documents an event that's already happened in the GL).
 *
 * Gain/loss computed from disposeAsset's stored values:
 *   gainOrLoss = (proceeds - fees) - (cost_basis - accumulated_dep)
 *
 * For inherited assets the basis is fmv_at_dod, matching disposeAsset.
 *
 * Method defaults to 'sale' for any disposition with proceeds > 0,
 * 'write_off' for $0-proceeds dispositions. The user can override on
 * the form before drafting.
 */
export async function prefillAssetDispositionFromAsset(args: {
	organizationId: string;
	fixedAssetId: string;
}): Promise<AssetDispositionPrefill | null> {
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
			disposedAt: fixedAssets.disposedAt,
			disposalProceeds: fixedAssets.disposalProceeds,
			disposalFees: fixedAssets.disposalFees,
			organizationId: fixedAssets.organizationId,
		})
		.from(fixedAssets)
		.where(eq(fixedAssets.id, args.fixedAssetId))
		.limit(1);
	if (!asset) return null;
	if (asset.organizationId !== args.organizationId) return null;
	if (asset.status !== 'disposed' || !asset.disposedAt) return null;

	const descriptionParts: string[] = [asset.name];
	if (asset.assetNumber) descriptionParts.push(`Asset # ${asset.assetNumber}`);
	if (asset.serialNumber) descriptionParts.push(`Serial / VIN: ${asset.serialNumber}`);
	if (asset.location) descriptionParts.push(`Location: ${asset.location}`);
	if (asset.notes) descriptionParts.push(asset.notes);
	const assetDescription = descriptionParts.join(' · ');

	// Accumulated depreciation pulled from the fiduciary book — same
	// basis used by disposeAsset for the gain/loss math.
	const [book] = await db
		.select({ accumulated: assetBooks.accumulatedDepreciation })
		.from(assetBooks)
		.where(
			and(
				eq(assetBooks.assetId, asset.id),
				eq(assetBooks.bookType, 'fiduciary'),
			),
		)
		.limit(1);

	const recordedBasis = asset.acquisitionType === 'inherited' && asset.fmvAtDod
		? Number(asset.fmvAtDod)
		: Number(asset.costBasis);
	const accumulated = Number(book?.accumulated ?? 0);
	const proceeds = Number(asset.disposalProceeds ?? 0);
	const fees = Number(asset.disposalFees ?? 0);
	const netProceeds = proceeds - fees;
	const netBasis = recordedBasis - accumulated;
	const gainOrLoss = netProceeds - netBasis;

	const inServiceDate = asset.inServiceDate;
	const disposedAt = asset.disposedAt;
	const holdingPeriodNote = inServiceDate
		? `Acquired ${inServiceDate}, disposed ${disposedAt}`
		: null;

	return {
		assetDescription,
		dispositionDate: disposedAt,
		buyerName: null,
		buyerAddress: null,
		method: proceeds > 0 ? 'sale' : 'write_off',
		proceedsCents: Math.round(proceeds * 100),
		feesCents: Math.round(fees * 100),
		costBasisCents: Math.round(recordedBasis * 100),
		accumulatedDepreciationCents: Math.round(accumulated * 100),
		gainOrLossCents: Math.round(gainOrLoss * 100),
		holdingPeriodNote,
		fixedAssetId: asset.id,
	};
}

export interface AnnualAccountingBalance {
	accountNumber: string | null;
	accountName: string;
	balanceCents: number;
}

export interface AnnualAccountingActivity {
	accountNumber: string | null;
	accountName: string;
	amountCents: number;
}

export interface AnnualAccountingDistribution {
	beneficiaryName: string;
	amountCents: number;
	distributionCount: number;
}

export interface AnnualAccountingPrefill {
	taxYear: number;
	periodStartDate: string;
	periodEndDate: string;
	assetBalances: AnnualAccountingBalance[];
	liabilityBalances: AnnualAccountingBalance[];
	receipts: AnnualAccountingActivity[];
	disbursements: AnnualAccountingActivity[];
	distributions: AnnualAccountingDistribution[];
	trusteeCompensationCents: number;
}

/**
 * Build the year's beneficiary accounting from the GL. Single roll-up
 * query per section since the PDF is one snapshot, not a live view.
 *
 *   asset balances     = sum of (debit - credit) through period end on
 *                        asset accounts (and excluding contra-assets
 *                        like accumulated depreciation which net into
 *                        their parent line)
 *   liability balances = sum of (credit - debit) through period end on
 *                        liability accounts (positive = owed)
 *   receipts           = sum of credits in period on income accounts
 *                        (income + other_income) plus any inflow to
 *                        equity (corpus contributions)
 *   disbursements      = sum of debits in period on expense accounts
 *                        excluding 310 distributions and 510 trustee
 *                        compensation (broken out separately)
 *   distributions      = sum of debits in period on 310 grouped by
 *                        beneficiary tag
 *   trustee comp       = sum of debits in period on 510
 */
export async function prefillAnnualBeneficiaryAccounting(args: {
	organizationId: string;
	taxYear: number;
	periodStartDate?: string;
	periodEndDate?: string;
}): Promise<AnnualAccountingPrefill> {
	const periodStart = args.periodStartDate ?? `${args.taxYear}-01-01`;
	const periodEnd = args.periodEndDate ?? `${args.taxYear}-12-31`;

	// Asset balances through period end (cumulative — not just period
	// activity).
	const assetRows = await db
		.select({
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
			net: sql<string>`sum(${journalEntryLines.debit} - ${journalEntryLines.credit})`,
		})
		.from(journalEntryLines)
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.where(
			and(
				eq(chartOfAccounts.organizationId, args.organizationId),
				eq(journalEntries.organizationId, args.organizationId),
				inArray(chartOfAccounts.accountType, [
					'bank',
					'accounts_receivable',
					'other_current_asset',
					'fixed_asset',
					'other_asset',
				]),
				sql`${journalEntries.date} <= ${periodEnd}`,
				sql`${journalEntries.reversalOfId} IS NULL`,
			),
		)
		.groupBy(chartOfAccounts.id, chartOfAccounts.accountNumber, chartOfAccounts.accountName);

	const assetBalances: AnnualAccountingBalance[] = assetRows
		.map((r) => ({
			accountNumber: r.accountNumber ?? null,
			accountName: r.accountName,
			balanceCents: Math.round(Number(r.net ?? 0) * 100),
		}))
		.filter((b) => b.balanceCents !== 0)
		.sort((a, b) => (a.accountNumber ?? '').localeCompare(b.accountNumber ?? ''));

	// Liability balances through period end (credit-normal so flip the
	// sign).
	const liabilityRows = await db
		.select({
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
			net: sql<string>`sum(${journalEntryLines.credit} - ${journalEntryLines.debit})`,
		})
		.from(journalEntryLines)
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.where(
			and(
				eq(chartOfAccounts.organizationId, args.organizationId),
				eq(journalEntries.organizationId, args.organizationId),
				inArray(chartOfAccounts.accountType, [
					'accounts_payable',
					'credit_card',
					'other_current_liability',
					'long_term_liabilities',
				]),
				sql`${journalEntries.date} <= ${periodEnd}`,
				sql`${journalEntries.reversalOfId} IS NULL`,
			),
		)
		.groupBy(chartOfAccounts.id, chartOfAccounts.accountNumber, chartOfAccounts.accountName);

	const liabilityBalances: AnnualAccountingBalance[] = liabilityRows
		.map((r) => ({
			accountNumber: r.accountNumber ?? null,
			accountName: r.accountName,
			balanceCents: Math.round(Number(r.net ?? 0) * 100),
		}))
		.filter((b) => b.balanceCents !== 0)
		.sort((a, b) => (a.accountNumber ?? '').localeCompare(b.accountNumber ?? ''));

	// Receipts: credits in period to income accounts.
	const receiptRows = await db
		.select({
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
			creditTotal: sql<string>`sum(${journalEntryLines.credit})`,
		})
		.from(journalEntryLines)
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.where(
			and(
				eq(chartOfAccounts.organizationId, args.organizationId),
				eq(journalEntries.organizationId, args.organizationId),
				inArray(chartOfAccounts.accountType, ['income', 'other_income']),
				sql`${journalEntries.date} >= ${periodStart}`,
				sql`${journalEntries.date} <= ${periodEnd}`,
				sql`${journalEntries.reversalOfId} IS NULL`,
			),
		)
		.groupBy(chartOfAccounts.id, chartOfAccounts.accountNumber, chartOfAccounts.accountName);

	const receipts: AnnualAccountingActivity[] = receiptRows
		.map((r) => ({
			accountNumber: r.accountNumber ?? null,
			accountName: r.accountName,
			amountCents: Math.round(Number(r.creditTotal ?? 0) * 100),
		}))
		.filter((r) => r.amountCents > 0)
		.sort((a, b) => (a.accountNumber ?? '').localeCompare(b.accountNumber ?? ''));

	// Disbursements: debits in period to expense accounts EXCLUDING 310
	// distributions and 510 trustee compensation (broken out below).
	const disbursementRows = await db
		.select({
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
			detailType: chartOfAccounts.detailType,
			debitTotal: sql<string>`sum(${journalEntryLines.debit})`,
		})
		.from(journalEntryLines)
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.where(
			and(
				eq(chartOfAccounts.organizationId, args.organizationId),
				eq(journalEntries.organizationId, args.organizationId),
				inArray(chartOfAccounts.accountType, ['expenses', 'other_expense', 'cost_of_goods_sold']),
				sql`${journalEntries.date} >= ${periodStart}`,
				sql`${journalEntries.date} <= ${periodEnd}`,
				sql`${journalEntries.reversalOfId} IS NULL`,
			),
		)
		.groupBy(chartOfAccounts.id, chartOfAccounts.accountNumber, chartOfAccounts.accountName, chartOfAccounts.detailType);

	const disbursements: AnnualAccountingActivity[] = disbursementRows
		.filter((r) => r.detailType !== 'trust_trustee_compensation')
		.map((r) => ({
			accountNumber: r.accountNumber ?? null,
			accountName: r.accountName,
			amountCents: Math.round(Number(r.debitTotal ?? 0) * 100),
		}))
		.filter((d) => d.amountCents > 0)
		.sort((a, b) => (a.accountNumber ?? '').localeCompare(b.accountNumber ?? ''));

	const trusteeCompensationCents = Math.round(
		disbursementRows
			.filter((r) => r.detailType === 'trust_trustee_compensation')
			.reduce((acc, r) => acc + Number(r.debitTotal ?? 0), 0) * 100,
	);

	// Distributions: debits in period on 310 grouped by beneficiary
	// tag. We left-join trust_beneficiaries to resolve names.
	const distributionRows = await db
		.select({
			beneficiaryId: journalEntryLines.beneficiaryId,
			beneficiaryName: trustBeneficiaries.fullName,
			debitTotal: sql<string>`sum(${journalEntryLines.debit})`,
			lineCount: sql<number>`count(*)::int`,
		})
		.from(journalEntryLines)
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.leftJoin(trustBeneficiaries, eq(trustBeneficiaries.id, journalEntryLines.beneficiaryId))
		.where(
			and(
				eq(chartOfAccounts.organizationId, args.organizationId),
				eq(journalEntries.organizationId, args.organizationId),
				eq(chartOfAccounts.detailType, 'trust_distributions_to_beneficiaries'),
				sql`${journalEntries.date} >= ${periodStart}`,
				sql`${journalEntries.date} <= ${periodEnd}`,
				sql`${journalEntries.reversalOfId} IS NULL`,
			),
		)
		.groupBy(journalEntryLines.beneficiaryId, trustBeneficiaries.fullName);

	const distributions: AnnualAccountingDistribution[] = distributionRows
		.map((r) => ({
			beneficiaryName: r.beneficiaryName ?? 'Untagged distribution',
			amountCents: Math.round(Number(r.debitTotal ?? 0) * 100),
			distributionCount: Number(r.lineCount ?? 0),
		}))
		.filter((d) => d.amountCents > 0)
		.sort((a, b) => b.amountCents - a.amountCents);

	return {
		taxYear: args.taxYear,
		periodStartDate: periodStart,
		periodEndDate: periodEnd,
		assetBalances,
		liabilityBalances,
		receipts,
		disbursements,
		distributions,
		trusteeCompensationCents,
	};
}

export interface PromissoryNotePrefill {
	borrowerName: string;
	borrowerRelationship: 'trustee' | 'beneficiary' | 'related_party' | 'third_party';
	borrowerAddress: string | null;
	principalCents: number;
	annualRatePercent: number;
	afrConfirmed: 'yes' | 'no_below_afr' | 'na';
	noteDate: string;
	paymentSchedule: 'monthly' | 'quarterly' | 'semi_annual' | 'annual' | 'demand' | 'balloon';
	collateral: string | null;
	spendthriftAnalysis: string | null;
	sourceAccountLabel: string | null;
	purpose: string;
	sourceFindingId: string;
}

/**
 * Pull a TRUST_DEMAND_NOTE_MISSING_NOTE finding into Promissory Note
 * variables. This is the prefill that closes the most-active current
 * gap in audit defense — the warning fires whenever 250/260 demand-
 * note activity hits the GL without a backing note on file.
 *
 * What we prefill:
 *   - principalCents: net debit balance on the demand-note account
 *     today (advances minus repayments), so the note's principal
 *     matches the actual outstanding amount
 *   - borrowerRelationship: 'trustee' or 'beneficiary' from the
 *     account's detail_type
 *   - noteDate: today (no good signal in the GL — the trustee should
 *     pick the actual loan-formation date)
 *   - paymentSchedule: 'demand' (the matching default for demand-
 *     note accounting)
 *   - sourceAccountLabel: "{number} {name}" for the borrower's
 *     demand-note account
 *   - purpose: a sensible placeholder the user can refine
 *
 * What we don't prefill (judgment-call fields):
 *   - borrowerName: too risky to guess when the trust has multiple
 *     beneficiaries or trustees; user types it
 *   - annualRatePercent + afrConfirmed: tax-sensitive — leave blank
 *   - maturityDate: optional anyway; user fills if applicable
 *   - collateral, spendthriftAnalysis: trustee's words required
 *
 * Returns null when:
 *   - the finding doesn't exist or belongs to a different org
 *   - the code doesn't match TRUST_DEMAND_NOTE_MISSING_NOTE
 *   - the demand-note account has a zero or credit balance (no
 *     outstanding loan to memorialize)
 */
export async function prefillPromissoryNoteFromDemandFinding(args: {
	organizationId: string;
	findingId: string;
}): Promise<PromissoryNotePrefill | null> {
	const [finding] = await db
		.select({
			id: trustReviewFindings.id,
			code: trustReviewFindings.code,
			organizationId: trustReviewFindings.organizationId,
			metadata: trustReviewFindings.metadata,
		})
		.from(trustReviewFindings)
		.where(eq(trustReviewFindings.id, args.findingId))
		.limit(1);
	if (!finding) return null;
	if (finding.organizationId !== args.organizationId) return null;
	if (finding.code !== 'TRUST_DEMAND_NOTE_MISSING_NOTE') return null;

	const meta = (finding.metadata ?? {}) as {
		accountId?: string;
		accountNumber?: string;
		detailType?: string;
	};
	if (!meta.accountId) return null;

	const [acct] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
			detailType: chartOfAccounts.detailType,
		})
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.id, meta.accountId),
				eq(chartOfAccounts.organizationId, args.organizationId),
			),
		)
		.limit(1);
	if (!acct) return null;

	// Net debit balance on the account through today. A demand-note
	// receivable account is debit-normal; net debit = outstanding
	// loan principal.
	const [balRow] = await db
		.select({
			net: sql<string>`coalesce(sum(${journalEntryLines.debit} - ${journalEntryLines.credit}), 0)`,
		})
		.from(journalEntryLines)
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.where(
			and(
				eq(journalEntryLines.accountId, acct.id),
				eq(journalEntries.organizationId, args.organizationId),
				sql`${journalEntries.reversalOfId} IS NULL`,
			),
		);
	const principalCents = Math.round(Number(balRow?.net ?? 0) * 100);
	if (principalCents <= 0) return null;

	const detailType = acct.detailType ?? meta.detailType ?? '';
	const borrowerRelationship: PromissoryNotePrefill['borrowerRelationship'] =
		detailType === 'trust_trustee_demand_note' ? 'trustee'
		: detailType.startsWith('trust_beneficiary_demand_note') ? 'beneficiary'
		: 'related_party';

	const sourceAccountLabel = acct.accountNumber
		? `${acct.accountNumber} ${acct.accountName}`
		: acct.accountName;

	const today = new Date().toISOString().slice(0, 10);
	const purpose = borrowerRelationship === 'trustee'
		? 'Working capital advances from the Trust to the Trustee, repayable on demand'
		: borrowerRelationship === 'beneficiary'
			? 'Advances from the Trust to the Beneficiary, repayable on demand (not in lieu of distributions)'
			: 'Demand-note advances from the Trust to the Borrower';

	return {
		borrowerName: '',
		borrowerRelationship,
		borrowerAddress: null,
		principalCents,
		annualRatePercent: 0,
		afrConfirmed: 'na',
		noteDate: today,
		paymentSchedule: 'demand',
		collateral: null,
		spendthriftAnalysis: null,
		sourceAccountLabel,
		purpose,
		sourceFindingId: finding.id,
	};
}

export interface RealEstatePurchasePrefill {
	propertyAddress: string;
	legalDescription: string;
	propertyType: 'single_family_residential' | 'multifamily_residential' | 'commercial' | 'land' | 'mixed_use' | 'industrial' | 'other';
	intendedUse: 'rental_income' | 'beneficiary_residence' | 'long_term_appreciation' | 'business_operation' | 'mixed';
	purchasePriceCents: number;
	cashPortionCents: number;
	financedPortionCents: number;
	closingDate: string;
	sellerName: string;
	sellerIsRelatedParty: 'no' | 'yes';
	titleVesting: string;
	sourceOfFunds: string;
	valuationEvidence: string;
	prudentInvestorAnalysis: string;
	titleInsurance: string;
	propertyInsurance: string;
	recordingInstructions: string;
	fixedAssetId: string;
}

/**
 * Pull a purchased real-property fixed_assets row into Real Estate
 * Purchase variables. Only meaningful when acquisitionType='purchased'
 * AND the asset's category reads as real property (land, building,
 * real, property in the category name).
 *
 * Address vs legal description: the form's "address" field expects a
 * postal address while "legal description" wants the recorded
 * lot/block/sub or metes-and-bounds. The fixed_assets schema doesn't
 * cleanly distinguish — we put `location` into address and `notes`
 * into legal description. Trustee edits the labels as needed before
 * drafting.
 *
 * Seller is resolved from the source transaction's contact (if any).
 */
export async function prefillRealEstatePurchaseFromAsset(args: {
	organizationId: string;
	fixedAssetId: string;
}): Promise<RealEstatePurchasePrefill | null> {
	const [asset] = await db
		.select({
			id: fixedAssets.id,
			name: fixedAssets.name,
			location: fixedAssets.location,
			notes: fixedAssets.notes,
			costBasis: fixedAssets.costBasis,
			inServiceDate: fixedAssets.inServiceDate,
			acquisitionType: fixedAssets.acquisitionType,
			sourceTransactionId: fixedAssets.sourceTransactionId,
			categoryName: assetCategories.name,
			organizationId: fixedAssets.organizationId,
		})
		.from(fixedAssets)
		.innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
		.where(eq(fixedAssets.id, args.fixedAssetId))
		.limit(1);
	if (!asset) return null;
	if (asset.organizationId !== args.organizationId) return null;
	if (asset.acquisitionType !== 'purchased') return null;

	const cat = (asset.categoryName ?? '').toLowerCase();
	const isRealProperty = cat.includes('land')
		|| cat.includes('building')
		|| cat.includes('real')
		|| cat.includes('property');
	if (!isRealProperty) return null;

	const propertyType: RealEstatePurchasePrefill['propertyType'] =
		cat.includes('land') ? 'land'
		: cat.includes('commercial') || cat.includes('office') || cat.includes('retail') ? 'commercial'
		: cat.includes('multifamily') || cat.includes('apartment') ? 'multifamily_residential'
		: cat.includes('industrial') || cat.includes('warehouse') ? 'industrial'
		: cat.includes('mixed') ? 'mixed_use'
		: 'single_family_residential';

	let sellerName = '';
	if (asset.sourceTransactionId) {
		const [txn] = await db
			.select({ contactId: transactions.contactId })
			.from(transactions)
			.where(
				and(
					eq(transactions.id, asset.sourceTransactionId),
					eq(transactions.organizationId, args.organizationId),
				),
			)
			.limit(1);
		if (txn?.contactId) {
			const [c] = await db
				.select({ contactName: contacts.contactName })
				.from(contacts)
				.where(eq(contacts.id, txn.contactId))
				.limit(1);
			if (c) sellerName = c.contactName;
		}
	}

	const purchasePriceCents = Math.round(Number(asset.costBasis) * 100);

	return {
		propertyAddress: asset.location ?? '',
		legalDescription: asset.notes ?? '',
		propertyType,
		intendedUse: 'long_term_appreciation',
		purchasePriceCents,
		cashPortionCents: purchasePriceCents,
		financedPortionCents: 0,
		closingDate: asset.inServiceDate,
		sellerName,
		sellerIsRelatedParty: 'no',
		titleVesting: '',
		sourceOfFunds: '',
		valuationEvidence: '',
		prudentInvestorAnalysis: '',
		titleInsurance: '',
		propertyInsurance: '',
		recordingInstructions: '',
		fixedAssetId: asset.id,
	};
}

export interface RealEstateSalePrefill {
	propertyAddress: string;
	legalDescription: string;
	propertyType: 'single_family_residential' | 'multifamily_residential' | 'commercial' | 'land' | 'mixed_use' | 'industrial' | 'other';
	salePriceCents: number;
	sellingExpensesCents: number;
	adjustedBasisCents: number;
	accumulatedDepreciationCents: number;
	closingDate: string;
	acquisitionDate: string;
	buyerName: string;
	buyerIsRelatedParty: 'no' | 'yes';
	saleRationale: string;
	proceedsDisposition: string;
	titleTransferInstructions: string;
	section121Analysis: string | null;
	fixedAssetId: string;
}

/**
 * Pull a disposed real-property fixed_assets row into Real Estate
 * Sale variables. Reuses the disposition math from
 * prefillAssetDispositionFromAsset (sale price, basis, accumulated
 * depreciation, holding period) and adds RE-specific fields.
 *
 * Only meaningful when status='disposed' AND category reads as real
 * property. The template's PDF auto-computes the §1001 gain
 * calculation, the §1250 unrecaptured-gain split, and the §121
 * exclusion recital for residential property based on these values,
 * so the prefill just needs to seed the basis inputs accurately.
 */
export async function prefillRealEstateSaleFromAsset(args: {
	organizationId: string;
	fixedAssetId: string;
}): Promise<RealEstateSalePrefill | null> {
	const [asset] = await db
		.select({
			id: fixedAssets.id,
			name: fixedAssets.name,
			location: fixedAssets.location,
			notes: fixedAssets.notes,
			status: fixedAssets.status,
			acquisitionType: fixedAssets.acquisitionType,
			inServiceDate: fixedAssets.inServiceDate,
			costBasis: fixedAssets.costBasis,
			fmvAtDod: fixedAssets.fmvAtDod,
			disposedAt: fixedAssets.disposedAt,
			disposalProceeds: fixedAssets.disposalProceeds,
			disposalFees: fixedAssets.disposalFees,
			categoryName: assetCategories.name,
			organizationId: fixedAssets.organizationId,
		})
		.from(fixedAssets)
		.innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
		.where(eq(fixedAssets.id, args.fixedAssetId))
		.limit(1);
	if (!asset) return null;
	if (asset.organizationId !== args.organizationId) return null;
	if (asset.status !== 'disposed' || !asset.disposedAt) return null;

	const cat = (asset.categoryName ?? '').toLowerCase();
	const isRealProperty = cat.includes('land')
		|| cat.includes('building')
		|| cat.includes('real')
		|| cat.includes('property');
	if (!isRealProperty) return null;

	const propertyType: RealEstateSalePrefill['propertyType'] =
		cat.includes('land') ? 'land'
		: cat.includes('commercial') || cat.includes('office') || cat.includes('retail') ? 'commercial'
		: cat.includes('multifamily') || cat.includes('apartment') ? 'multifamily_residential'
		: cat.includes('industrial') || cat.includes('warehouse') ? 'industrial'
		: cat.includes('mixed') ? 'mixed_use'
		: 'single_family_residential';

	// Accumulated depreciation on the fiduciary book.
	const [book] = await db
		.select({ accumulated: assetBooks.accumulatedDepreciation })
		.from(assetBooks)
		.where(
			and(
				eq(assetBooks.assetId, asset.id),
				eq(assetBooks.bookType, 'fiduciary'),
			),
		)
		.limit(1);

	const recordedBasis = asset.acquisitionType === 'inherited' && asset.fmvAtDod
		? Number(asset.fmvAtDod)
		: Number(asset.costBasis);
	const accumulated = Number(book?.accumulated ?? 0);
	const proceeds = Number(asset.disposalProceeds ?? 0);
	const fees = Number(asset.disposalFees ?? 0);

	return {
		propertyAddress: asset.location ?? '',
		legalDescription: asset.notes ?? '',
		propertyType,
		salePriceCents: Math.round(proceeds * 100),
		sellingExpensesCents: Math.round(fees * 100),
		adjustedBasisCents: Math.round(recordedBasis * 100),
		accumulatedDepreciationCents: Math.round(accumulated * 100),
		closingDate: asset.disposedAt,
		acquisitionDate: asset.inServiceDate,
		buyerName: '',
		buyerIsRelatedParty: 'no',
		saleRationale: '',
		proceedsDisposition: '',
		titleTransferInstructions: '',
		section121Analysis: null,
		fixedAssetId: asset.id,
	};
}

export interface InsuranceAuthorizationPrefill {
	coverageType: 'property_hazard' | 'general_liability' | 'umbrella' | 'trustee_eo' | 'trustee_bond' | 'life_insurance' | 'valuable_items_fine_art' | 'cyber' | 'workers_comp' | 'other';
	insuredInterest: string;
	carrierName: string;
	policyNumber: string;
	effectiveDate: string;
	expirationDate: string;
	coverageLimitCents: number;
	deductibleCents: number;
	annualPremiumCents: number;
	premiumCadence: 'annual' | 'semi_annual' | 'quarterly' | 'monthly' | 'single_premium';
	namedInsured: string;
	upiaAllocation: 'income_only' | 'corpus_only' | 'split' | 'income_default_801';
	selectionRationale: string;
	fixedAssetId: string;
}

/**
 * Pull a fixed_assets row into Insurance Authorization variables. The
 * insurable interest is the asset itself; coverage type defaults to
 * property_hazard (the most common case for trust-owned physical
 * assets), and the named insured language is left empty so the
 * trustee can craft the exact dec-page text.
 *
 * Effective date defaults to today and expirationDate to one year
 * out — most P&C policies are 12-month terms. The user can shorten
 * for a partial-year binder.
 *
 * Coverage type heuristic from category name: 'auto' / 'vehicle' →
 * still property_hazard (the asset is the insured interest); 'fine
 * art' / 'valuable' → valuable_items_fine_art.
 */
export async function prefillInsuranceFromAsset(args: {
	organizationId: string;
	fixedAssetId: string;
}): Promise<InsuranceAuthorizationPrefill | null> {
	const [asset] = await db
		.select({
			id: fixedAssets.id,
			name: fixedAssets.name,
			location: fixedAssets.location,
			assetNumber: fixedAssets.assetNumber,
			serialNumber: fixedAssets.serialNumber,
			costBasis: fixedAssets.costBasis,
			categoryName: assetCategories.name,
			organizationId: fixedAssets.organizationId,
		})
		.from(fixedAssets)
		.innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
		.where(eq(fixedAssets.id, args.fixedAssetId))
		.limit(1);
	if (!asset) return null;
	if (asset.organizationId !== args.organizationId) return null;

	const cat = (asset.categoryName ?? '').toLowerCase();
	const coverageType: InsuranceAuthorizationPrefill['coverageType'] =
		cat.includes('fine art') || cat.includes('valuable') || cat.includes('jewelry') || cat.includes('collectible')
			? 'valuable_items_fine_art'
			: 'property_hazard';

	const insuredParts: string[] = [asset.name];
	if (asset.location) insuredParts.push(`Location: ${asset.location}`);
	if (asset.assetNumber) insuredParts.push(`Asset # ${asset.assetNumber}`);
	if (asset.serialNumber) insuredParts.push(`Serial / VIN: ${asset.serialNumber}`);
	const insuredInterest = insuredParts.join(' · ');

	const today = new Date();
	const effectiveDate = today.toISOString().slice(0, 10);
	const expirationDate = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate())
		.toISOString()
		.slice(0, 10);

	// Coverage-limit seed: 100% of cost basis. P&C policies normally
	// insure to replacement cost not basis, but basis is the only
	// dollar value we have — user adjusts before drafting.
	const coverageLimitCents = Math.round(Number(asset.costBasis) * 100);

	return {
		coverageType,
		insuredInterest,
		carrierName: '',
		policyNumber: '',
		effectiveDate,
		expirationDate,
		coverageLimitCents,
		deductibleCents: 0,
		annualPremiumCents: 0,
		premiumCadence: 'annual',
		namedInsured: '',
		upiaAllocation: 'income_default_801',
		selectionRationale: '',
		fixedAssetId: asset.id,
	};
}

export interface LeaseResolutionPrefill {
	propertyAddress: string;
	propertyDescription: string;
	tenantName: string;
	tenantIsRelatedParty: 'no' | 'yes_beneficiary' | 'yes_trustee' | 'yes_family';
	leaseType: 'residential' | 'commercial' | 'land_only' | 'mixed_use' | 'short_term_vacation';
	termStart: string;
	termEnd: string;
	isMonthToMonth: 'yes' | 'no';
	monthlyRentCents: number;
	securityDepositCents: number;
	lateFeePolicy: string | null;
	utilitiesArrangement: 'tenant_pays_all' | 'landlord_pays_all' | 'split' | 'tenant_pays_with_exceptions';
	utilitiesNarrative: string | null;
	marketRateEvidence: string;
	propertyManagerName: string | null;
	leaseDocumentReference: string;
	rentalPropertyId: string;
}

/**
 * Pull a rental_properties row into Lease Resolution variables. The
 * trust-side address + property identity are the only fields the
 * underlying record knows; everything tenant-facing (name, term,
 * rent, deposit, utilities, market-rate evidence) is the trustee's
 * judgment call and must come from the user.
 *
 * Defaults set on prefill:
 *   - termStart = today, isMonthToMonth = 'yes' (first review = 12mo)
 *     since most trust-owned rentals are MTM in practice
 *   - leaseType = 'residential' (override on the form when commercial /
 *     ground lease / etc.)
 *   - tenantIsRelatedParty = 'no' (override when beneficiary or other)
 *   - utilitiesArrangement = 'tenant_pays_all' (most common default)
 *
 * Address derivation: rental_properties.address is jsonb with shape
 * { line, city, state, zip }. We flatten into a single "Street,
 * City, ST Zip" string. The trustee can edit the labels on the
 * form before drafting.
 */
export async function prefillLeaseResolutionFromRentalProperty(args: {
	organizationId: string;
	rentalPropertyId: string;
}): Promise<LeaseResolutionPrefill | null> {
	const [property] = await db
		.select({
			id: rentalProperties.id,
			displayName: rentalProperties.displayName,
			address: rentalProperties.address,
			status: rentalProperties.status,
			organizationId: rentalProperties.organizationId,
		})
		.from(rentalProperties)
		.where(eq(rentalProperties.id, args.rentalPropertyId))
		.limit(1);
	if (!property) return null;
	if (property.organizationId !== args.organizationId) return null;
	if (property.status !== 'active') return null;

	const addr = (property.address ?? {}) as {
		line?: string | null;
		city?: string | null;
		state?: string | null;
		zip?: string | null;
	};
	const addressParts = [
		addr.line,
		[addr.city, addr.state].filter(Boolean).join(', '),
		addr.zip,
	].filter(Boolean);
	const propertyAddress = addressParts.length > 0 ? addressParts.join(', ') : property.displayName;

	const today = new Date();
	const termStart = today.toISOString().slice(0, 10);
	// Review date one year out (MTM "first review" anchor — the template
	// treats this as a review marker when isMonthToMonth='yes').
	const reviewDate = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate())
		.toISOString()
		.slice(0, 10);

	return {
		propertyAddress,
		propertyDescription: property.displayName,
		tenantName: '',
		tenantIsRelatedParty: 'no',
		leaseType: 'residential',
		termStart,
		termEnd: reviewDate,
		isMonthToMonth: 'yes',
		monthlyRentCents: 0,
		securityDepositCents: 0,
		lateFeePolicy: null,
		utilitiesArrangement: 'tenant_pays_all',
		utilitiesNarrative: null,
		marketRateEvidence: '',
		propertyManagerName: null,
		leaseDocumentReference: '',
		rentalPropertyId: property.id,
	};
}

export interface ExtraordinaryDividendLineItem {
	accountNumber: string | null;
	accountName: string;
	incomeCents: number;
	distributedCents: number;
	retainedCents: number;
}

export interface ExtraordinaryDividendPrefill {
	taxYear: number;
	periodEndDate: string;
	items: ExtraordinaryDividendLineItem[];
}

/**
 * Build the line-items array for an Extraordinary Dividend Declaration
 * by walking the trust's 4xx (income + other_income) accounts and
 * comparing per-account credit totals in the tax year against the
 * trust's distributions for the same period.
 *
 * Phase 1 simplification — we attribute distributions proportionally
 * across income accounts in proportion to their gross credits. Exact
 * income-by-character tracking (DNI tracing through K-1s) is a
 * Phase 2 refinement; for now this gives the trustee a reasonable
 * "what remained in corpus" snapshot to declare against.
 *
 *   incomeCents          = sum of 4xx credits in the period
 *   total distribution   = sum of 310 debits in the period
 *   per-account distributed = (account income / total income) * total distribution
 *   retainedCents        = max(0, incomeCents - distributedCents)
 *
 * The form lets the user edit the prefill before drafting so a
 * trustee with better books can override the proportional split.
 */
export async function prefillExtraordinaryDividendForYear(args: {
	organizationId: string;
	taxYear: number;
	periodEndDate?: string;
}): Promise<ExtraordinaryDividendPrefill> {
	const yearStart = `${args.taxYear}-01-01`;
	const yearEnd = args.periodEndDate ?? `${args.taxYear}-12-31`;

	// Income credits by 4xx account for the period.
	const incomeRows = await db
		.select({
			accountId: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
			accountType: chartOfAccounts.accountType,
			creditTotal: sql<string>`sum(${journalEntryLines.credit})`,
		})
		.from(journalEntryLines)
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.where(
			and(
				eq(chartOfAccounts.organizationId, args.organizationId),
				eq(journalEntries.organizationId, args.organizationId),
				inArray(chartOfAccounts.accountType, ['income', 'other_income']),
				sql`${journalEntries.date} >= ${yearStart}`,
				sql`${journalEntries.date} <= ${yearEnd}`,
				sql`${journalEntries.reversalOfId} IS NULL`,
			),
		)
		.groupBy(chartOfAccounts.id, chartOfAccounts.accountNumber, chartOfAccounts.accountName, chartOfAccounts.accountType);

	const incomeAccounts = incomeRows
		.map((r) => ({
			accountNumber: r.accountNumber ?? null,
			accountName: r.accountName,
			incomeCents: Math.round(Number(r.creditTotal ?? 0) * 100),
		}))
		.filter((a) => a.incomeCents > 0);

	const totalIncomeCents = incomeAccounts.reduce((acc, a) => acc + a.incomeCents, 0);

	// Total distributions (310 debits) in the period.
	const distributionRows = await db
		.select({
			debitTotal: sql<string>`sum(${journalEntryLines.debit})`,
		})
		.from(journalEntryLines)
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.where(
			and(
				eq(chartOfAccounts.organizationId, args.organizationId),
				eq(journalEntries.organizationId, args.organizationId),
				eq(chartOfAccounts.detailType, 'trust_distributions_to_beneficiaries'),
				sql`${journalEntries.date} >= ${yearStart}`,
				sql`${journalEntries.date} <= ${yearEnd}`,
				sql`${journalEntries.reversalOfId} IS NULL`,
			),
		);
	const totalDistributedCents = Math.round(Number(distributionRows[0]?.debitTotal ?? 0) * 100);

	// Proportional split across income accounts. When total income is
	// zero (no income to retain anyway), the items array stays empty.
	const items: ExtraordinaryDividendLineItem[] = incomeAccounts.map((a) => {
		const share = totalIncomeCents > 0 ? a.incomeCents / totalIncomeCents : 0;
		const distributedCents = Math.min(a.incomeCents, Math.round(totalDistributedCents * share));
		const retainedCents = Math.max(0, a.incomeCents - distributedCents);
		return {
			accountNumber: a.accountNumber,
			accountName: a.accountName,
			incomeCents: a.incomeCents,
			distributedCents,
			retainedCents,
		};
	});

	// Sort by retained amount desc — biggest retentions surface first
	// in the form so the trustee sees what matters most.
	items.sort((a, b) => b.retainedCents - a.retainedCents);

	return {
		taxYear: args.taxYear,
		periodEndDate: yearEnd,
		items,
	};
}
