'use client';

import { useState, useTransition } from 'react';
import { classifyDeposit } from '../_actions/classifyDeposit';

export interface IncomeAccountPick {
	id: string;
	accountNumber: string | null;
	accountName: string;
}

interface Props {
	findingId: string;
	incomeAccounts: IncomeAccountPick[];
}

/**
 * Two icons per row on a DEPOSIT_NEEDS_CORPUS_OR_INCOME_CLASSIFICATION
 * finding: confirm-as-corpus and reclassify-as-income (opens an inline
 * 4xx account picker). Split handling is deferred — for mixed
 * principal+income deposits the user should reverse and post manually
 * for now.
 */
export function ClassifyDepositButtons({ findingId, incomeAccounts }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [pickedIncomeId, setPickedIncomeId] = useState(incomeAccounts[0]?.id ?? '');

	const confirmCorpus = () => {
		setError(null);
		startTransition(async () => {
			const r = await classifyDeposit({ findingId, decision: 'corpus' });
			if (!r.ok) setError(r.error ?? 'Failed to classify');
		});
	};

	const reclassifyIncome = () => {
		if (!pickedIncomeId) {
			setError('Pick an income account first');
			return;
		}
		setError(null);
		startTransition(async () => {
			const r = await classifyDeposit({
				findingId,
				decision: 'income',
				incomeAccountId: pickedIncomeId,
			});
			if (!r.ok) setError(r.error ?? 'Failed to classify');
		});
	};

	return (
		<div className="flex flex-col items-end gap-1">
			<div className="flex items-center gap-1">
				<IconButton
					onClick={confirmCorpus}
					disabled={pending}
					title="Confirm as corpus (principal — not distributable, no K-1)"
				>
					🏛
				</IconButton>
				<IconButton
					onClick={() => setPickerOpen((v) => !v)}
					disabled={pending}
					title="Reclassify as income (pick a 4xx account)"
				>
					💰
				</IconButton>
			</div>
			{pickerOpen && (
				<div className="flex items-center gap-1 rounded-md border border-zinc-300 bg-white p-1 dark:border-zinc-700 dark:bg-zinc-900">
					<select
						value={pickedIncomeId}
						onChange={(e) => setPickedIncomeId(e.target.value)}
						disabled={pending}
						className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
					>
						{incomeAccounts.map((a) => (
							<option key={a.id} value={a.id}>
								{a.accountNumber ? `${a.accountNumber} · ` : ''}
								{a.accountName}
							</option>
						))}
					</select>
					<button
						type="button"
						onClick={reclassifyIncome}
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

function IconButton({
	children,
	...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			type="button"
			{...rest}
			className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-300 bg-white text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
		>
			{children}
		</button>
	);
}
