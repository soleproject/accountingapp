'use client';

import { useState, useTransition } from 'react';
import { recategorizeNonTrust } from '../_actions/recategorizeNonTrust';

export interface AccountPick {
	id: string;
	accountNumber: string | null;
	accountName: string;
	/** Account type so the picker can group / sort. */
	accountType: string | null;
}

interface Props {
	findingId: string;
	accounts: AccountPick[];
}

/**
 * Per-row picker for TRUST_NON_TRUST_CATEGORY_USED. User picks any
 * account in the org; we reverse + repost on that account preserving
 * debit/credit direction. The picker is unfiltered because non-trust
 * accounts can be replaced with ANY trust account depending on the
 * actual semantics of the txn (income, expense, asset, etc).
 */
export function RecategorizeNonTrustButton({ findingId, accounts }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [pickedId, setPickedId] = useState(accounts[0]?.id ?? '');

	if (accounts.length === 0) return null;

	const submit = () => {
		if (!pickedId) {
			setError('Pick an account');
			return;
		}
		setError(null);
		startTransition(async () => {
			const r = await recategorizeNonTrust({ findingId, targetAccountId: pickedId });
			if (!r.ok) setError(r.error ?? 'Failed to recategorize');
		});
	};

	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				onClick={() => setPickerOpen((v) => !v)}
				disabled={pending}
				title="Move this line to a beneficial-trust chart-of-accounts entry"
				className="flex h-7 items-center justify-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
			>
				🔄 Recategorize
			</button>
			{pickerOpen && (
				<div className="flex items-center gap-1 rounded-md border border-zinc-300 bg-white p-1 dark:border-zinc-700 dark:bg-zinc-900">
					<select
						value={pickedId}
						onChange={(e) => setPickedId(e.target.value)}
						disabled={pending}
						className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
					>
						{accounts.map((a) => (
							<option key={a.id} value={a.id}>
								{a.accountNumber ? `${a.accountNumber} · ` : ''}
								{a.accountName}
								{a.accountType ? ` (${a.accountType})` : ''}
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
