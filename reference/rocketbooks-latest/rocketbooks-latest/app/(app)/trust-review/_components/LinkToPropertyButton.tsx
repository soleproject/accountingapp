'use client';

import { useState, useTransition } from 'react';
import { linkLineToProperty } from '../_actions/linkLineToProperty';

export interface RentalPropertyPick {
	id: string;
	displayName: string;
}

interface Props {
	findingId: string;
	properties: RentalPropertyPick[];
}

/**
 * Per-row picker for TRUST_DEFERRED_RENTAL_NET_NEEDED. User picks the
 * rental property this 430 line belongs to; we tag the line with
 * rental_property_id and drop a TRUST_RENTAL_LINKED_TO_PROPERTY audit.
 * No JE reversal — the spec wants the line to stay on 430 (as net),
 * just with the property tag enabling the sub-ledger roll-up.
 *
 * Empty-state: when the org has no properties, shows a deep link to
 * /rental-properties/new so the user can create one first.
 */
export function LinkToPropertyButton({ findingId, properties }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [pickedId, setPickedId] = useState(properties[0]?.id ?? '');

	if (properties.length === 0) {
		return (
			<a
				href="/rental-properties/new"
				className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
				title="Create a rental property first"
			>
				🏠 + property
			</a>
		);
	}

	const submit = () => {
		if (!pickedId) {
			setError('Pick a property');
			return;
		}
		setError(null);
		startTransition(async () => {
			const r = await linkLineToProperty({ findingId, rentalPropertyId: pickedId });
			if (!r.ok) setError(r.error ?? 'Failed to link');
		});
	};

	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				onClick={() => setPickerOpen((v) => !v)}
				disabled={pending}
				title="Link this 430 line to a rental property's sub-ledger"
				className="flex h-7 items-center justify-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
			>
				🏠 Link to property
			</button>
			{pickerOpen && (
				<div className="flex items-center gap-1 rounded-md border border-zinc-300 bg-white p-1 dark:border-zinc-700 dark:bg-zinc-900">
					<select
						value={pickedId}
						onChange={(e) => setPickedId(e.target.value)}
						disabled={pending}
						className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
					>
						{properties.map((p) => (
							<option key={p.id} value={p.id}>
								{p.displayName}
							</option>
						))}
					</select>
					<button
						type="button"
						onClick={submit}
						disabled={pending}
						className="rounded-md bg-zinc-900 px-2 py-0.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
					>
						{pending ? '…' : 'Apply'}
					</button>
				</div>
			)}
			{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
		</div>
	);
}
