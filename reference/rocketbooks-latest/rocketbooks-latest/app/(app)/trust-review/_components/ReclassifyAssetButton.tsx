'use client';

import { useState, useTransition } from 'react';
import { reclassifyAssetToExpense } from '../_actions/reclassifyAssetToExpense';

export interface ExpenseAccountPick {
	id: string;
	accountNumber: string | null;
	accountName: string;
}

interface Props {
	findingId: string;
	expenseAccounts: ExpenseAccountPick[];
}

/**
 * Per-row picker for TRUST_ASSET_REPOST_REVIEW. User picks the destination
 * expense account; action reverses the asset-account JE and reposts
 * there. "Add to asset basis" branch is deferred — for capital
 * improvements the user dismisses this finding and updates
 * fixed_assets.cost_basis manually.
 */
export function ReclassifyAssetButton({ findingId, expenseAccounts }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [pickedId, setPickedId] = useState(expenseAccounts[0]?.id ?? '');

	if (expenseAccounts.length === 0) {
		return (
			<span className="text-xs text-zinc-500">No expense accounts</span>
		);
	}

	const submit = () => {
		if (!pickedId) {
			setError('Pick an expense account');
			return;
		}
		setError(null);
		startTransition(async () => {
			const r = await reclassifyAssetToExpense({ findingId, expenseAccountId: pickedId });
			if (!r.ok) setError(r.error ?? 'Failed to reclassify');
		});
	};

	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				onClick={() => setPickerOpen((v) => !v)}
				disabled={pending}
				title="Move this posting off the asset account to an expense account (repair/insurance/etc)"
				className="flex h-7 items-center justify-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
			>
				↪ Move to expense
			</button>
			{pickerOpen && (
				<div className="flex items-center gap-1 rounded-md border border-zinc-300 bg-white p-1 dark:border-zinc-700 dark:bg-zinc-900">
					<select
						value={pickedId}
						onChange={(e) => setPickedId(e.target.value)}
						disabled={pending}
						className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
					>
						{expenseAccounts.map((a) => (
							<option key={a.id} value={a.id}>
								{a.accountNumber ? `${a.accountNumber} · ` : ''}
								{a.accountName}
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
