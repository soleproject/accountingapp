import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { assetBooks, assetCategories, chartOfAccounts, fixedAssets } from '@/db/schema/schema';
import { createJournalEntry, JournalEntryError } from '@/lib/accounting/posting';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AcquisitionType = 'purchased' | 'inherited' | 'exchanged_1031' | 'contributed';
export type DepreciationMethod = 'straight_line' | 'declining_balance_150' | 'declining_balance_200' | 'macrs_gds' | 'macrs_ads';
export type DepreciationConvention = 'half_year' | 'mid_month' | 'mid_quarter' | 'full_month';

export interface CreateFixedAssetInput {
	organizationId: string;
	categoryId: string;
	name: string;
	assetNumber?: string | null;
	serialNumber?: string | null;
	location?: string | null;
	notes?: string | null;
	acquisitionType: AcquisitionType;
	inServiceDate: string;
	costBasis: number;
	salvageValue?: number;
	fmvAtDod?: number;
	alternateValuationDate?: string | null;
	replacedAssetId?: string | null;
	carryoverBasis?: number;
	excessBasis?: number;
	parentAssetId?: string | null;
	usefulLifeMonths: number;
	method: DepreciationMethod;
	convention?: DepreciationConvention;
	autoDepreciate?: boolean;
	priorAccumulatedDepreciation?: number;
	priorAccumulatedThroughDate?: string | null;
	/** 'active' makes the asset eligible for depreciation runs; 'draft'
	 *  parks it for partial setup. */
	status?: 'active' | 'draft';
}

export interface CreateFixedAssetResult {
	assetId: string;
	/** The chart_of_accounts.id the asset's cost basis was posted against
	 *  (resolved from the category). Useful to callers that want to link
	 *  the asset to other tables by CoA account id. */
	assetAccountId: string;
}

/**
 * Insert a fixed_assets row + per-book schedules + the beginning-balance
 * JE that wires the asset into the GL. Same effect as the createAsset
 * server action but returns the assetId rather than redirecting — used
 * by flows that need to create OTHER rows referencing the asset (e.g.
 * rental_properties.fixed_asset_id) in the same transaction.
 *
 * Accepts an optional tx so the caller can compose this into a larger
 * transaction; otherwise opens its own.
 */
export async function createFixedAssetCore(
	input: CreateFixedAssetInput,
	tx?: Tx,
): Promise<CreateFixedAssetResult> {
	const exec = tx ?? db;

	const [category] = await exec
		.select({
			id: assetCategories.id,
			assetAccountId: assetCategories.assetAccountId,
			accumulatedDepAccountId: assetCategories.accumulatedDepAccountId,
		})
		.from(assetCategories)
		.where(
			and(
				eq(assetCategories.id, input.categoryId),
				eq(assetCategories.organizationId, input.organizationId),
			),
		)
		.limit(1);
	if (!category) throw new Error('Asset category not in this organization');

	const salvageValue = input.salvageValue ?? 0;
	const priorAccum = input.priorAccumulatedDepreciation ?? 0;
	const depreciableBasis =
		input.acquisitionType === 'inherited' && input.fmvAtDod ? input.fmvAtDod : input.costBasis;

	if (salvageValue >= depreciableBasis && depreciableBasis > 0) {
		throw new Error(
			`Salvage value (${salvageValue}) is greater than or equal to cost basis (${depreciableBasis}). The asset would never depreciate.`,
		);
	}

	const [equity] = await exec
		.select({ id: chartOfAccounts.id })
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.organizationId, input.organizationId),
				eq(chartOfAccounts.detailType, 'opening_balance_equity'),
			),
		)
		.limit(1);
	if (!equity) {
		throw new Error('No Trust Corpus / Opening Balance Equity account on this org');
	}

	const assetId = randomUUID();
	const status = input.status ?? 'active';

	const run = async (innerTx: Tx) => {
		await innerTx.insert(fixedAssets).values({
			id: assetId,
			organizationId: input.organizationId,
			categoryId: input.categoryId,
			name: input.name,
			assetNumber: input.assetNumber?.trim() || null,
			serialNumber: input.serialNumber?.trim() || null,
			location: input.location?.trim() || null,
			notes: input.notes?.trim() || null,
			status,
			acquisitionType: input.acquisitionType,
			inServiceDate: input.inServiceDate,
			costBasis: String(input.costBasis),
			fmvAtDod: input.fmvAtDod != null ? String(input.fmvAtDod) : null,
			alternateValuationDate: input.alternateValuationDate || null,
			replacedAssetId: input.replacedAssetId || null,
			carryoverBasis: input.carryoverBasis != null ? String(input.carryoverBasis) : null,
			excessBasis: input.excessBasis != null ? String(input.excessBasis) : null,
			parentAssetId: input.parentAssetId || null,
			salvageValue: String(salvageValue),
			autoDepreciate: input.autoDepreciate ?? false,
		});

		for (const bookType of ['fiduciary', 'tax'] as const) {
			await innerTx.insert(assetBooks).values({
				id: randomUUID(),
				organizationId: input.organizationId,
				assetId,
				bookType,
				method: input.method,
				usefulLifeMonths: input.usefulLifeMonths,
				convention: input.convention ?? 'half_year',
				accumulatedDepreciation: String(priorAccum),
				accumulatedThroughDate: input.priorAccumulatedThroughDate || null,
			});
		}

		if (depreciableBasis > 0) {
			const lines: Array<{
				accountId: string;
				debit: number;
				credit: number;
				contactId: string | null;
				memo: string | null;
			}> = [
				{
					accountId: category.assetAccountId,
					debit: depreciableBasis,
					credit: 0,
					contactId: null,
					memo: `Asset registered: ${input.name}`,
				},
				{
					accountId: equity.id,
					debit: 0,
					credit: depreciableBasis,
					contactId: null,
					memo: `Asset registered: ${input.name}`,
				},
			];
			if (priorAccum > 0) {
				lines.push(
					{
						accountId: equity.id,
						debit: priorAccum,
						credit: 0,
						contactId: null,
						memo: `Prior accumulated depreciation: ${input.name}`,
					},
					{
						accountId: category.accumulatedDepAccountId,
						debit: 0,
						credit: priorAccum,
						contactId: null,
						memo: `Prior accumulated depreciation: ${input.name}`,
					},
				);
			}
			try {
				await createJournalEntry(
					{
						organizationId: input.organizationId,
						date: input.inServiceDate,
						memo: `Asset registered: ${input.name}`,
						posted: true,
						sourceType: 'fixed_asset',
						sourceId: assetId,
						lines,
					},
					innerTx,
				);
			} catch (err) {
				if (err instanceof JournalEntryError) throw new Error(err.message);
				throw err;
			}
		}
	};

	if (tx) await run(tx);
	else await db.transaction(run);

	return { assetId, assetAccountId: category.assetAccountId };
}
