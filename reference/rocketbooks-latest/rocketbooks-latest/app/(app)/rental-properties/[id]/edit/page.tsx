import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { rentalProperties } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import {
	RentalPropertyForm,
	type RentalPropertyInitial,
} from '../../_components/RentalPropertyForm';

interface PageProps {
	params: Promise<{ id: string }>;
}

interface AddressShape {
	line?: string | null;
	city?: string | null;
	state?: string | null;
	zip?: string | null;
}

export default async function EditRentalPropertyPage({ params }: PageProps) {
	const { id } = await params;
	const orgId = await getCurrentOrgId();

	const [row] = await db
		.select({
			id: rentalProperties.id,
			displayName: rentalProperties.displayName,
			address: rentalProperties.address,
			acquiredOn: rentalProperties.acquiredOn,
			fixedAssetId: rentalProperties.fixedAssetId,
		})
		.from(rentalProperties)
		.where(and(eq(rentalProperties.id, id), eq(rentalProperties.organizationId, orgId)))
		.limit(1);
	if (!row) notFound();

	const addr = (row.address ?? {}) as AddressShape;
	const initial: RentalPropertyInitial = {
		id: row.id,
		displayName: row.displayName,
		addressLine: addr.line ?? null,
		city: addr.city ?? null,
		state: addr.state ?? null,
		zip: addr.zip ?? null,
		acquiredOn: row.acquiredOn ?? null,
		fixedAssetId: row.fixedAssetId,
	};

	return (
		<div className="flex flex-col gap-4">
			<header>
				<h1 className="text-2xl font-semibold">Edit rental property</h1>
				<p className="text-sm text-zinc-500 dark:text-zinc-400">{row.displayName}</p>
			</header>
			<RentalPropertyForm initial={initial} />
		</div>
	);
}
