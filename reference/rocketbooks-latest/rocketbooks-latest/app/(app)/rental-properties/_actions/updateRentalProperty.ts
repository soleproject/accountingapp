'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db/client';
import { rentalProperties } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';

const Schema = z.object({
	propertyId: z.string().min(1),
	displayName: z.string().min(1).max(160),
	addressLine: z.string().max(300).optional().or(z.literal('')),
	city: z.string().max(120).optional().or(z.literal('')),
	state: z.string().max(40).optional().or(z.literal('')),
	zip: z.string().max(20).optional().or(z.literal('')),
	acquiredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
});

export interface UpdateRentalPropertyState {
	error?: string;
}

/**
 * Identity-only edit: name, address parts, acquired_on. Cost basis,
 * depreciation, and the linked asset itself are managed on the asset
 * detail page (/assets/[id]) so the GL stays consistent — changing
 * cost basis here would need a corrective JE that the property form
 * doesn't model.
 */
export async function updateRentalProperty(
	_prev: UpdateRentalPropertyState | undefined,
	formData: FormData,
): Promise<UpdateRentalPropertyState | undefined> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const parsed = Schema.safeParse({
		propertyId: formData.get('propertyId'),
		displayName: formData.get('displayName'),
		addressLine: formData.get('addressLine') || '',
		city: formData.get('city') || '',
		state: formData.get('state') || '',
		zip: formData.get('zip') || '',
		acquiredOn: formData.get('acquiredOn') || '',
	});
	if (!parsed.success) {
		return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
	}
	const data = parsed.data;

	const [existing] = await db
		.select({ id: rentalProperties.id })
		.from(rentalProperties)
		.where(
			and(
				eq(rentalProperties.id, data.propertyId),
				eq(rentalProperties.organizationId, orgId),
			),
		)
		.limit(1);
	if (!existing) return { error: 'Property not found' };

	const address =
		data.addressLine || data.city || data.state || data.zip
			? {
					line: data.addressLine || null,
					city: data.city || null,
					state: data.state || null,
					zip: data.zip || null,
				}
			: null;

	await db
		.update(rentalProperties)
		.set({
			displayName: data.displayName.trim(),
			address,
			acquiredOn: data.acquiredOn || null,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(rentalProperties.id, data.propertyId));

	revalidatePath('/rental-properties');
	redirect('/rental-properties');
}
