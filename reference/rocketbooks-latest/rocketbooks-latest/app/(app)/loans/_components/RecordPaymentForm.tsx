'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { recordLoanPayment } from '../_actions/recordLoanPayment';

interface BankAccount {
	id: string;
	accountNumber: string | null;
	accountName: string;
}

interface Props {
	loanId: string;
	scheduleRowId: string;
	paymentNumber: number;
	dueDate: string;
	scheduledPrincipal: number;
	scheduledInterest: number;
	bankAccounts: BankAccount[];
	defaultPaymentDate: string;
}

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

const inputCls =
	'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-blue-500 dark:focus:ring-blue-900/50';
const labelCls = 'text-xs font-medium uppercase tracking-wide text-zinc-500';

export function RecordPaymentForm({
	loanId,
	scheduleRowId,
	paymentNumber,
	dueDate,
	scheduledPrincipal,
	scheduledInterest,
	bankAccounts,
	defaultPaymentDate,
}: Props) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [bankAccountId, setBankAccountId] = useState(bankAccounts[0]?.id ?? '');
	const [paymentDate, setPaymentDate] = useState(defaultPaymentDate);
	const total = scheduledPrincipal + scheduledInterest;

	if (bankAccounts.length === 0) {
		return (
			<div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
				No bank accounts on this org yet. Add one in{' '}
				<a className="underline" href="/chart-of-accounts">
					Chart of Accounts
				</a>{' '}
				before recording a payment.
			</div>
		);
	}

	const onSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		startTransition(async () => {
			const r = await recordLoanPayment({
				loanId,
				scheduleRowId,
				bankAccountId,
				paymentDate,
			});
			if (!r.ok) {
				setError(r.error ?? 'Failed to record payment');
				return;
			}
			router.refresh();
		});
	};

	return (
		<form
			onSubmit={onSubmit}
			className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
		>
			<div className="mb-3 text-sm text-zinc-700 dark:text-zinc-300">
				Payment <strong>#{paymentNumber}</strong> due <strong>{dueDate}</strong> —{' '}
				principal {CURRENCY_FMT.format(scheduledPrincipal)} + interest{' '}
				{CURRENCY_FMT.format(scheduledInterest)} ={' '}
				<strong className="tabular-nums">{CURRENCY_FMT.format(total)}</strong>
			</div>

			<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
				<label className="flex flex-col gap-1 sm:flex-1">
					<span className={labelCls}>Bank account</span>
					<select
						value={bankAccountId}
						onChange={(e) => setBankAccountId(e.target.value)}
						className={inputCls}
						required
					>
						{bankAccounts.map((b) => (
							<option key={b.id} value={b.id}>
								{b.accountNumber ? `${b.accountNumber} · ` : ''}
								{b.accountName}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1">
					<span className={labelCls}>Payment date</span>
					<input
						type="date"
						value={paymentDate}
						onChange={(e) => setPaymentDate(e.target.value)}
						className={inputCls}
						required
					/>
				</label>
				<button
					type="submit"
					disabled={pending || !bankAccountId}
					className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
				>
					{pending ? 'Posting…' : `Record ${CURRENCY_FMT.format(total)}`}
				</button>
			</div>

			{error && (
				<div className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</div>
			)}
		</form>
	);
}
