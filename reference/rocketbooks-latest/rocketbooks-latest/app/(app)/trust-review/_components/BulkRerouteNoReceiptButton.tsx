'use client';

import { useEffect, useState, useTransition } from 'react';
import { bulkRerouteNoReceipt } from '../_actions/bulkRerouteNoReceipt';

interface BeneficiaryPick {
	id: string;
	fullName: string;
	ageNote: string;
}

interface Props {
	findingIds: string[];
	beneficiaries: BeneficiaryPick[];
	onComplete?: (processed: number) => void;
	onPendingChange?: (pending: boolean) => void;
}

export function BulkRerouteNoReceiptButton({ findingIds, beneficiaries, onComplete, onPendingChange }: Props) {
	const [open, setOpen] = useState(false);
	const [pending, startTransition] = useTransition();
	const [pickedBeneId, setPickedBeneId] = useState(beneficiaries[0]?.id ?? '');
	const [error, setError] = useState<string | null>(null);
	useEffect(() => onPendingChange?.(pending), [pending, onPendingChange]);

	const submit = () => {
		setError(null);
		startTransition(async () => {
			const r = await bulkRerouteNoReceipt({ findingIds, beneficiaryId: pickedBeneId });
			if (!r.ok && r.failed.length === 0) {
				setError(r.error ?? 'Failed');
				return;
			}
			if (r.failed.length > 0) setError(`${r.processed} ok, ${r.failed.length} failed`);
			onComplete?.(r.processed);
			setOpen(false);
		});
	};

	if (beneficiaries.length === 0) return null;

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				disabled={pending}
				className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
			>
				↪ Reroute {findingIds.length} to demand note
			</button>
			{open && (
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
						disabled={pending || !pickedBeneId}
						className="rounded-md bg-zinc-900 px-2 py-0.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
					>
						{pending ? '…' : 'Apply'}
					</button>
				</div>
			)}
			{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
		</>
	);
}
