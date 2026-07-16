'use client';

import { useState, useTransition } from 'react';
import { rerouteNoReceiptToDemandNote } from '../_actions/rerouteNoReceiptToDemandNote';

interface BeneficiaryPick {
	id: string;
	fullName: string;
	ageNote: string;
}

interface Props {
	findingId: string;
	beneficiaries: BeneficiaryPick[];
}

/**
 * Companion to the AddReceipt button on TRUST_NO_RECEIPT_POSSIBLE_DISTRIBUTION
 * rows. When no receipt is obtainable, the bookkeeper picks the responsible
 * beneficiary and the line moves to their 26x demand note as a personal
 * advance.
 */
export function RerouteNoReceiptButton({ findingId, beneficiaries }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [pickedBeneId, setPickedBeneId] = useState(beneficiaries[0]?.id ?? '');

	const submit = () => {
		if (!pickedBeneId) {
			setError('Pick a beneficiary first');
			return;
		}
		setError(null);
		startTransition(async () => {
			const r = await rerouteNoReceiptToDemandNote({ findingId, beneficiaryId: pickedBeneId });
			if (!r.ok) setError(r.error ?? 'Failed to reroute');
		});
	};

	if (beneficiaries.length === 0) return null;

	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				onClick={() => setPickerOpen((v) => !v)}
				disabled={pending}
				title="No receipt obtainable — reroute to a beneficiary's demand note"
				className="flex h-7 items-center justify-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
			>
				↪ No receipt
			</button>
			{pickerOpen && (
				<div className="flex items-center gap-1 rounded-md border border-zinc-300 bg-white p-1 dark:border-zinc-700 dark:bg-zinc-900">
					<select
						value={pickedBeneId}
						onChange={(e) => setPickedBeneId(e.target.value)}
						disabled={pending}
						className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
					>
						{beneficiaries.map((b) => (
							<option key={b.id} value={b.id}>
								{b.fullName} · {b.ageNote}
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
