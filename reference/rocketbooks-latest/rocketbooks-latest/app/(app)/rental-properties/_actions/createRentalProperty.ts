'use server';

import { randomUUID } from 'crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db/client';
import { rentalProperties } from '@/db/schema/schema';
import { createFixedAssetCore } from '@/lib/assets/create-asset-core';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { draftResolution } from '../../trust-documents/_actions/draftResolution';
import { prefillLeaseResolutionFromRentalProperty } from '@/lib/resolutions/from-finding';

const Schema = z.object({
	displayName: z.string().min(1).max(160),
	addressLine: z.string().max(300).optional().or(z.literal('')),
	city: z.string().max(120).optional().or(z.literal('')),
	state: z.string().max(40).optional().or(z.literal('')),
	zip: z.string().max(20).optional().or(z.literal('')),
	acquiredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
	// Building-asset fields. The building is mandatory in the v1 flow —
	// every rental property gets a paired fixed_assets row so it lands on
	// the balance sheet and the /assets page.
	categoryId: z.string().min(1),
	acquisitionType: z.enum(['purchased', 'inherited', 'contributed']),
	inServiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	costBasis: z.coerce.number().nonnegative(),
	salvageValue: z.coerce.number().nonnegative().default(0),
	usefulLifeMonths: z.coerce.number().int().positive(),
	method: z.enum(['straight_line', 'declining_balance_150', 'declining_balance_200', 'macrs_gds', 'macrs_ads']),
	convention: z.enum(['mid_month', 'half_year', 'mid_quarter', 'full_month']).default('mid_month'),
});

export interface CreateRentalPropertyState {
	error?: string;
}

/**
 * Create a rental property + its underlying building (fixed_assets row)
 * in one transaction. The building's asset account becomes the property's
 * linked CoA account, and rental_properties.fixed_asset_id points at the
 * new asset so the list page can surface book value without a join hack.
 *
 * The beginning-balance JE (debit asset / credit Trust Corpus) is posted
 * by createFixedAssetCore inside the same transaction — either everything
 * succeeds or nothing does.
 */
export async function createRentalProperty(
	_prev: CreateRentalPropertyState | undefined,
	formData: FormData,
): Promise<CreateRentalPropertyState | undefined> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const parsed = Schema.safeParse({
		displayName: formData.get('displayName'),
		addressLine: formData.get('addressLine') || '',
		city: formData.get('city') || '',
		state: formData.get('state') || '',
		zip: formData.get('zip') || '',
		acquiredOn: formData.get('acquiredOn') || '',
		categoryId: formData.get('categoryId'),
		acquisitionType: formData.get('acquisitionType') || 'purchased',
		inServiceDate: formData.get('inServiceDate'),
		costBasis: formData.get('costBasis'),
		salvageValue: formData.get('salvageValue') || 0,
		usefulLifeMonths: formData.get('usefulLifeMonths'),
		method: formData.get('method') || 'straight_line',
		convention: formData.get('convention') || 'mid_month',
	});
	if (!parsed.success) {
		return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
	}
	const data = parsed.data;

	const address =
		data.addressLine || data.city || data.state || data.zip
			? {
					line: data.addressLine || null,
					city: data.city || null,
					state: data.state || null,
					zip: data.zip || null,
				}
			: null;

	const id = randomUUID();
	try {
		await db.transaction(async (tx) => {
			const { assetId, assetAccountId } = await createFixedAssetCore(
				{
					organizationId: orgId,
					categoryId: data.categoryId,
					name: data.displayName.trim(),
					location: data.addressLine || null,
					acquisitionType: data.acquisitionType,
					inServiceDate: data.inServiceDate,
					costBasis: data.costBasis,
					salvageValue: data.salvageValue,
					usefulLifeMonths: data.usefulLifeMonths,
					method: data.method,
					convention: data.convention,
					status: 'active',
				},
				tx,
			);

			await tx.insert(rentalProperties).values({
				id,
				organizationId: orgId,
				displayName: data.displayName.trim(),
				address,
				assetAccountId,
				fixedAssetId: assetId,
				acquiredOn: data.acquiredOn || data.inServiceDate,
				status: 'active',
			});
		});
	} catch (err) {
		return { error: err instanceof Error ? err.message : 'Failed to create property' };
	}

	// Auto-draft a Lease Resolution for the new property — the
	// per-property authority artifact that backs every lease the
	// trust signs. Idempotency: draftResolution dedupes on
	// (org, rental_property, id) so a form resubmit can't spawn
	// two. Non-fatal — the property is committed and the trustee
	// can always draft manually from the property detail page.
	try {
		const prefill = await prefillLeaseResolutionFromRentalProperty({
			organizationId: orgId,
			rentalPropertyId: id,
		});
		if (prefill) {
			const r = await draftResolution({
				templateId: 'lease-resolution',
				variables: prefill as unknown as Record<string, unknown>,
				source: { kind: 'rental_property', id },
			});
			if (!r.ok && !r.needsTrustState) {
				logger.warn(
					{ rentalPropertyId: id, err: r.error },
					'auto-draft lease resolution failed (non-fatal)',
				);
			}
		}
	} catch (err) {
		logger.warn(
			{ rentalPropertyId: id, err: err instanceof Error ? err.message : err },
			'auto-draft lease resolution threw (non-fatal)',
		);
	}

	revalidatePath('/rental-properties');
	revalidatePath('/assets');
	revalidatePath('/trust-review');
	revalidatePath('/trust-documents');
	redirect('/rental-properties');
}
