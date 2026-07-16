'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { createFixedAssetCore } from '@/lib/assets/create-asset-core';
import { draftResolution } from '../../trust-documents/_actions/draftResolution';
import { prefillBillOfSaleFromAsset, prefillRealEstatePurchaseFromAsset } from '@/lib/resolutions/from-finding';
import { logger } from '@/lib/logger';

const Schema = z.object({
	categoryId: z.string().min(1),
	name: z.string().min(1).max(200),
	assetNumber: z.string().max(50).optional().or(z.literal('')),
	serialNumber: z.string().max(100).optional().or(z.literal('')),
	location: z.string().max(200).optional().or(z.literal('')),
	notes: z.string().max(2000).optional().or(z.literal('')),
	acquisitionType: z.enum(['purchased', 'inherited', 'exchanged_1031', 'contributed']),
	inServiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	costBasis: z.coerce.number().nonnegative(),
	salvageValue: z.coerce.number().nonnegative().default(0),
	fmvAtDod: z.coerce.number().optional(),
	alternateValuationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
	replacedAssetId: z.string().optional().or(z.literal('')),
	carryoverBasis: z.coerce.number().optional(),
	excessBasis: z.coerce.number().optional(),
	parentAssetId: z.string().optional().or(z.literal('')),
	usefulLifeMonths: z.coerce.number().int().positive(),
	method: z.enum(['straight_line', 'declining_balance_150', 'declining_balance_200', 'macrs_gds', 'macrs_ads']),
	convention: z.enum(['half_year', 'mid_month', 'mid_quarter', 'full_month']).default('half_year'),
	autoDepreciate: z.boolean().default(false),
	// Prior accumulated depreciation when migrating an in-flight asset from
	// another system. Posts an additional pair of JE lines to plug the
	// register into the GL at the correct net book value.
	priorAccumulatedDepreciation: z.coerce.number().nonnegative().default(0),
	priorAccumulatedThroughDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
	// 'draft' lets the user save partial work; 'active' makes the asset
	// eligible for depreciation runs.
	activate: z.boolean().default(true),
});

export interface CreateAssetState {
	error?: string;
}

/**
 * Insert a fixed asset + its per-book depreciation schedules, then post
 * the beginning-balance journal entry that wires the asset into the GL:
 *
 *   Dr  Asset account             cost_basis (or fmv_at_dod for inherited)
 *   Cr  Trust Corpus              same amount
 *
 *   if prior_accumulated_depreciation > 0:
 *   Dr  Trust Corpus              prior_accum
 *   Cr  Accumulated Depreciation  prior_accum
 *
 * Net effect: the asset account holds full historical cost; the contra
 * holds prior depreciation; book value lands at the migrated remaining
 * basis. Trust Corpus is debited by the prior depreciation so the equity
 * side reflects the net contribution.
 *
 * For acquisition_type='purchased' tied to a Plaid txn, the txn JE
 * already debited the asset account — caller should skip this action and
 * use the asset-from-transaction flow instead (deferred to Phase 4).
 */
export async function createAsset(
	_prev: CreateAssetState | undefined,
	formData: FormData,
): Promise<CreateAssetState | undefined> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const parsed = Schema.safeParse({
		categoryId: formData.get('categoryId'),
		name: formData.get('name'),
		assetNumber: formData.get('assetNumber') || '',
		serialNumber: formData.get('serialNumber') || '',
		location: formData.get('location') || '',
		notes: formData.get('notes') || '',
		acquisitionType: formData.get('acquisitionType') || 'purchased',
		inServiceDate: formData.get('inServiceDate'),
		costBasis: formData.get('costBasis'),
		salvageValue: formData.get('salvageValue') || 0,
		fmvAtDod: formData.get('fmvAtDod') || undefined,
		alternateValuationDate: formData.get('alternateValuationDate') || '',
		replacedAssetId: formData.get('replacedAssetId') || '',
		carryoverBasis: formData.get('carryoverBasis') || undefined,
		excessBasis: formData.get('excessBasis') || undefined,
		parentAssetId: formData.get('parentAssetId') || '',
		usefulLifeMonths: formData.get('usefulLifeMonths'),
		method: formData.get('method') || 'straight_line',
		convention: formData.get('convention') || 'half_year',
		autoDepreciate: formData.get('autoDepreciate') === 'on',
		priorAccumulatedDepreciation: formData.get('priorAccumulatedDepreciation') || 0,
		priorAccumulatedThroughDate: formData.get('priorAccumulatedThroughDate') || '',
		activate: formData.get('activate') !== 'off',
	});
	if (!parsed.success) {
		return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
	}

	let assetId: string;
	try {
		const r = await createFixedAssetCore({
			organizationId: orgId,
			categoryId: parsed.data.categoryId,
			name: parsed.data.name,
			assetNumber: parsed.data.assetNumber || null,
			serialNumber: parsed.data.serialNumber || null,
			location: parsed.data.location || null,
			notes: parsed.data.notes || null,
			acquisitionType: parsed.data.acquisitionType,
			inServiceDate: parsed.data.inServiceDate,
			costBasis: parsed.data.costBasis,
			salvageValue: parsed.data.salvageValue,
			fmvAtDod: parsed.data.fmvAtDod,
			alternateValuationDate: parsed.data.alternateValuationDate || null,
			replacedAssetId: parsed.data.replacedAssetId || null,
			carryoverBasis: parsed.data.carryoverBasis,
			excessBasis: parsed.data.excessBasis,
			parentAssetId: parsed.data.parentAssetId || null,
			usefulLifeMonths: parsed.data.usefulLifeMonths,
			method: parsed.data.method,
			convention: parsed.data.convention,
			autoDepreciate: parsed.data.autoDepreciate,
			priorAccumulatedDepreciation: parsed.data.priorAccumulatedDepreciation,
			priorAccumulatedThroughDate: parsed.data.priorAccumulatedThroughDate || null,
			status: parsed.data.activate ? 'active' : 'draft',
		});
		assetId = r.assetId;
	} catch (err) {
		return { error: err instanceof Error ? err.message : 'Failed to create asset' };
	}

	// Auto-draft a Bill of Sale for contributed / inherited assets —
	// the per-event corpus documentation. Idempotency in
	// draftResolution prevents duplicates on a retry. Non-fatal — the
	// asset row is already saved and the user can always draft
	// manually from the asset detail page.
	if (
		parsed.data.acquisitionType === 'contributed'
		|| parsed.data.acquisitionType === 'inherited'
	) {
		try {
			const prefill = await prefillBillOfSaleFromAsset({
				organizationId: orgId,
				fixedAssetId: assetId,
			});
			if (prefill) {
				const r = await draftResolution({
					templateId: 'bill-of-sale',
					variables: prefill as unknown as Record<string, unknown>,
					source: { kind: 'fixed_asset', id: assetId },
				});
				if (!r.ok && !r.needsTrustState) {
					logger.warn(
						{ assetId, err: r.error },
						'auto-draft bill of sale failed (non-fatal)',
					);
				}
			}
		} catch (err) {
			logger.warn(
				{ assetId, err: err instanceof Error ? err.message : err },
				'auto-draft bill of sale threw (non-fatal)',
			);
		}
	}

	// Auto-draft a Real Estate Purchase Resolution when the asset is
	// purchased AND its category reads as real property. The prefill
	// helper enforces both gates and returns null otherwise — saves us
	// the category lookup here. Same non-fatal pattern as the Bill of
	// Sale auto-draft; the unique index on (org, sourceKind, sourceId,
	// templateId) WHERE status<>'voided' prevents duplicates across the
	// two auto-drafts since they share sourceId=assetId but use
	// different templateIds.
	if (parsed.data.acquisitionType === 'purchased') {
		try {
			const prefill = await prefillRealEstatePurchaseFromAsset({
				organizationId: orgId,
				fixedAssetId: assetId,
			});
			if (prefill) {
				const r = await draftResolution({
					templateId: 'real-estate-purchase',
					variables: prefill as unknown as Record<string, unknown>,
					source: { kind: 'fixed_asset', id: assetId },
				});
				if (!r.ok && !r.needsTrustState) {
					logger.warn(
						{ assetId, err: r.error },
						'auto-draft RE purchase resolution failed (non-fatal)',
					);
				}
			}
		} catch (err) {
			logger.warn(
				{ assetId, err: err instanceof Error ? err.message : err },
				'auto-draft RE purchase resolution threw (non-fatal)',
			);
		}
	}

	revalidatePath('/assets');
	revalidatePath('/trust-documents');
	redirect(`/assets/${assetId}`);
}
