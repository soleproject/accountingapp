'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { disposeAsset, type DisposeAssetResult } from '../../_actions/disposeAsset';

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

interface Props {
	assetId: string;
	assetName: string;
	bookValue: number;
	/** Bank/cash accounts to credit the proceeds to. id + label. */
	bankAccounts: Array<{ id: string; label: string }>;
}

export function DisposeAssetButton({ assetId, assetName, bookValue, bankAccounts }: Props) {
	const [open, setOpen] = useState(false);
	const [pending, startTransition] = useTransition();
	const today = new Date().toISOString().slice(0, 10);
	const [disposalDate, setDisposalDate] = useState(today);
	const [proceeds, setProceeds] = useState('0');
	const [fees, setFees] = useState('0');
	const [bankAccountId, setBankAccountId] = useState(bankAccounts[0]?.id ?? '');
	const [notes, setNotes] = useState('');
	const [result, setResult] = useState<DisposeAssetResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loanAck, setLoanAck] = useState<DisposeAssetResult['requiresLoanAck'] | null>(null);
	const router = useRouter();

	const netProceeds = Math.max(0, Number(proceeds) - Number(fees));
	const projectedGainLoss = netProceeds - bookValue;

	const onConfirm = (ackLoan: boolean = false) => {
		setError(null);
		setResult(null);
		startTransition(async () => {
			const r = await disposeAsset({
				assetId,
				disposalDate,
				proceeds: Number(proceeds),
				fees: Number(fees),
				bankAccountId: netProceeds > 0 ? bankAccountId : undefined,
				notes: notes.trim() || undefined,
				acknowledgeOutstandingLoan: ackLoan,
			});
			if (!r.ok) {
				if (r.requiresLoanAck) {
					setLoanAck(r.requiresLoanAck);
					setError(null);
					return;
				}
				setError(r.error ?? 'Failed to dispose');
				return;
			}
			setLoanAck(null);
			setResult(r);
			router.refresh();
		});
	};

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="rounded-md border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-900/30 dark:text-rose-300 dark:hover:bg-rose-900/50"
			>
				Dispose
			</button>

			{open && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
					<div className="w-full max-w-md rounded-lg border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
						<div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
							<h2 className="text-base font-semibold">Dispose of {assetName}</h2>
							<p className="text-xs text-zinc-500 dark:text-zinc-400">
								Posts a JE that clears the asset + accumulated depreciation,
								books the proceeds, and plugs gain or loss to balance.
							</p>
						</div>

						<div className="space-y-3 px-5 py-4 text-sm">
							<Field label="Disposal date">
								<input
									type="date"
									value={disposalDate}
									onChange={(e) => setDisposalDate(e.target.value)}
									disabled={pending || !!result}
									className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
								/>
							</Field>
							<div className="grid grid-cols-2 gap-3">
								<Field label="Proceeds">
									<input
										type="number"
										min="0"
										step="0.01"
										value={proceeds}
										onChange={(e) => setProceeds(e.target.value)}
										disabled={pending || !!result}
										className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-right tabular-nums text-sm dark:border-zinc-700 dark:bg-zinc-950"
									/>
								</Field>
								<Field label="Fees">
									<input
										type="number"
										min="0"
										step="0.01"
										value={fees}
										onChange={(e) => setFees(e.target.value)}
										disabled={pending || !!result}
										className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-right tabular-nums text-sm dark:border-zinc-700 dark:bg-zinc-950"
									/>
								</Field>
							</div>
							{netProceeds > 0 && (
								<Field label="Cash account">
									<select
										value={bankAccountId}
										onChange={(e) => setBankAccountId(e.target.value)}
										disabled={pending || !!result}
										className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
									>
										{bankAccounts.length === 0 && (
											<option value="">— no bank accounts on file —</option>
										)}
										{bankAccounts.map((b) => (
											<option key={b.id} value={b.id}>
												{b.label}
											</option>
										))}
									</select>
								</Field>
							)}
							<Field label="Notes (optional)">
								<textarea
									rows={2}
									maxLength={2000}
									value={notes}
									onChange={(e) => setNotes(e.target.value)}
									disabled={pending || !!result}
									className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
								/>
							</Field>

							<div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
								<div className="flex justify-between">
									<span className="text-zinc-500">Book value</span>
									<span className="tabular-nums">{CURRENCY_FMT.format(bookValue)}</span>
								</div>
								<div className="flex justify-between">
									<span className="text-zinc-500">Net proceeds</span>
									<span className="tabular-nums">{CURRENCY_FMT.format(netProceeds)}</span>
								</div>
								<div className="mt-1 flex justify-between border-t border-zinc-200 pt-1 font-medium dark:border-zinc-800">
									<span>
										{projectedGainLoss > 0 ? 'Projected gain' : projectedGainLoss < 0 ? 'Projected loss' : 'Break even'}
									</span>
									<span
										className={`tabular-nums ${
											projectedGainLoss > 0
												? 'text-emerald-700 dark:text-emerald-400'
												: projectedGainLoss < 0
													? 'text-rose-700 dark:text-rose-400'
													: ''
										}`}
									>
										{CURRENCY_FMT.format(projectedGainLoss)}
									</span>
								</div>
							</div>

							{loanAck && (
								<div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
									<div className="font-semibold mb-1">
										{loanAck.loans.length} outstanding loan{loanAck.loans.length === 1 ? '' : 's'} against this asset · {CURRENCY_FMT.format(loanAck.totalLoanBalance)}
									</div>
									<ul className="list-disc pl-5">
										{loanAck.loans.map((l) => (
											<li key={l.id}>
												{l.displayName} — {CURRENCY_FMT.format(l.currentPrincipal)}
											</li>
										))}
									</ul>
									<div className="mt-2">
										Disposal won&rsquo;t pay off the loan(s) automatically — you&rsquo;ll
										still owe the balance. Pay them off / transfer them first, or
										confirm to dispose anyway.
									</div>
								</div>
							)}
							{error && (
								<div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">
									{error}
								</div>
							)}
							{result?.ok && (
								<div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">
									Disposed.{' '}
									{result.gain != null && <>Gain {CURRENCY_FMT.format(result.gain)}. </>}
									{result.loss != null && <>Loss {CURRENCY_FMT.format(result.loss)}. </>}
									{result.journalEntryId && (
										<a
											href={`/journal-entries/${result.journalEntryId}`}
											className="font-mono underline"
										>
											JE {result.journalEntryId.slice(0, 8)}
										</a>
									)}
								</div>
							)}
						</div>

						<div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
							<button
								type="button"
								onClick={() => {
									setOpen(false);
									setResult(null);
									setError(null);
								}}
								disabled={pending}
								className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
							>
								{result ? 'Close' : 'Cancel'}
							</button>
							{!result && (
								<button
									type="button"
									onClick={() => onConfirm(loanAck !== null)}
									disabled={pending}
									className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
								>
									{pending
										? 'Disposing…'
										: loanAck
											? 'Dispose anyway'
											: 'Confirm dispose'}
								</button>
							)}
						</div>
					</div>
				</div>
			)}
		</>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<label className="flex flex-col gap-1">
			<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
				{label}
			</span>
			{children}
		</label>
	);
}
