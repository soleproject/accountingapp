'use client';

import { useEffect, useState, useTransition } from 'react';
import { bulkRecategorizeNonTrust } from '../_actions/bulkRecategorizeNonTrust';
import type { AccountPick } from './RecategorizeNonTrustButton';

interface Props {
	findingIds: string[];
	accounts: AccountPick[];
	onComplete?: (processed: number) => void;
	onPendingChange?: (pending: boolean) => void;
}

export function BulkRecategorizeNonTrustButton({ findingIds, accounts, onComplete, onPendingChange }: Props) {
	const [open, setOpen] = useState(false);
	const [pending, startTransition] = useTransition();
	const [pickedId, setPickedId] = useState(accounts[0]?.id ?? '');
	const [error, setError] = useState<string | null>(null);
	useEffect(() => onPendingChange?.(pending), [pending, onPendingChange]);

	const submit = () => {
		setError(null);
		startTransition(async () => {
			const r = await bulkRecategorizeNonTrust({ findingIds, targetAccountId: pickedId });
			if (!r.ok && r.failed.length === 0) {
				setError(r.error ?? 'Failed');
				return;
			}
			if (r.failed.length > 0) setError(`${r.processed} ok, ${r.failed.length} failed`);
			onComplete?.(r.processed);
			setOpen(false);
		});
	};

	if (accounts.length === 0) return null;

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				disabled={pending}
				className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
			>
				🔄 Recategorize {findingIds.length}
			</button>
			{open && (
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
						disabled={pending || !pickedId}
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
