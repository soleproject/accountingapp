'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { deleteRentalProperty } from '../_actions/deleteRentalProperty';

interface Props {
	propertyId: string;
	propertyName: string;
	hasLinkedAsset: boolean;
}

/**
 * Confirm-then-delete for a rental property. The linked building asset
 * survives — surface that in the confirm copy so the user isn't
 * surprised when /assets still shows the building.
 */
export function DeleteRentalPropertyButton({ propertyId, propertyName, hasLinkedAsset }: Props) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const onClick = () => {
		const tail = hasLinkedAsset
			? ' The linked building asset will remain on the Assets page — dispose it separately if you no longer own it.'
			: '';
		const ok = window.confirm(`Delete "${propertyName}"?${tail} This cannot be undone.`);
		if (!ok) return;
		setError(null);
		startTransition(async () => {
			const r = await deleteRentalProperty({ propertyId });
			if (!r.ok) {
				setError(r.error ?? 'Delete failed');
				return;
			}
			router.refresh();
		});
	};

	return (
		<>
			<button
				type="button"
				onClick={onClick}
				disabled={pending}
				className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-950/30"
			>
				{pending ? 'Deleting…' : 'Delete'}
			</button>
			{error && <span className="ml-2 text-xs text-red-600 dark:text-red-400">{error}</span>}
		</>
	);
}
