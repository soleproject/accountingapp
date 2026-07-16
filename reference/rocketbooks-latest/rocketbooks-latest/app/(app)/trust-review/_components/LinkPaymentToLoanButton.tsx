'use client';

import { useState, useTransition } from 'react';
import { linkPaymentToLoan } from '../_actions/linkPaymentToLoan';

export interface LoanPick {
	id: string;
	displayName: string;
	/** Next unposted schedule row preview — shown in the picker label so
	 *  the user knows which payment they're auto-applying to. Null when
	 *  the loan has no unposted rows (we still allow picking — action
	 *  will error and surface the message). */
	nextPaymentNumber: number | null;
	nextDueDate: string | null;
	nextTotal: number | null;
}

interface Props {
	findingId: string;
	loans: LoanPick[];
}

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/**
 * Per-row picker for TRUST_DEFERRED_LOAN_SPLIT_NEEDED. User picks the
 * loan; we auto-link to its next-unposted schedule row. The action
 * reverses the undifferentiated 250 JE and reposts with the proper
 * P/I/bank split.
 */
export function LinkPaymentToLoanButton({ findingId, loans }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [pickedLoanId, setPickedLoanId] = useState(loans[0]?.id ?? '');

	if (loans.length === 0) {
		return (
			<span className="text-xs text-zinc-500" title="Add a loan in /loans first">
				No loans
			</span>
		);
	}

	const submit = () => {
		if (!pickedLoanId) {
			setError('Pick a loan first');
			return;
		}
		setError(null);
		startTransition(async () => {
			const r = await linkPaymentToLoan({ findingId, loanId: pickedLoanId });
			if (!r.ok) setError(r.error ?? 'Failed to link');
		});
	};

	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				onClick={() => setPickerOpen((v) => !v)}
				disabled={pending}
				title="Link this payment to a loan + amortization schedule row"
				className="flex h-7 items-center justify-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
			>
				🏦 Link to loan
			</button>
			{pickerOpen && (
				<div className="flex items-center gap-1 rounded-md border border-zinc-300 bg-white p-1 dark:border-zinc-700 dark:bg-zinc-900">
					<select
						value={pickedLoanId}
						onChange={(e) => setPickedLoanId(e.target.value)}
						disabled={pending}
						className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
					>
						{loans.map((l) => (
							<option key={l.id} value={l.id}>
								{l.displayName}
								{l.nextPaymentNumber !== null && l.nextDueDate
									? ` — #${l.nextPaymentNumber} ${l.nextDueDate}${l.nextTotal !== null ? ' · ' + CURRENCY_FMT.format(l.nextTotal) : ''}`
									: ' — (no unposted)'}
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
