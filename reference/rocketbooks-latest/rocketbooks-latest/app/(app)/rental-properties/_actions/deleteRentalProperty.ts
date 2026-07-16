'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { rentalProperties } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';

export interface DeleteRentalPropertyResult {
	ok: boolean;
	error?: string;
}

/**
 * Delete a rental property row. The linked building (fixed_assets) is
 * intentionally left in place — assets carry their own GL ties (the
 * beginning-balance JE, depreciation entries, loan collateral links)
 * and aren't safe to silently delete here. The user can dispose the
 * asset separately from /assets/[id] if they no longer own the
 * building.
 *
 * The fixed_assets row keeps no FK back to rental_properties, so
 * deleting the property doesn't orphan the asset — it just removes
 * the property-side link.
 */
export async function deleteRentalProperty(args: {
	propertyId: string;
}): Promise<DeleteRentalPropertyResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	if (!args.propertyId) return { ok: false, error: 'Missing propertyId' };

	const [existing] = await db
		.select({ id: rentalProperties.id })
		.from(rentalProperties)
		.where(
			and(
				eq(rentalProperties.id, args.propertyId),
				eq(rentalProperties.organizationId, orgId),
			),
		)
		.limit(1);
	if (!existing) return { ok: false, error: 'Property not found' };

	await db.delete(rentalProperties).where(eq(rentalProperties.id, args.propertyId));

	revalidatePath('/rental-properties');
	revalidatePath('/trust-review');
	return { ok: true };
}
