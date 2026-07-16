'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { runDepreciation, type RunDepreciationResult } from '../_actions/runDepreciation';

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

interface Props {
	defaultPeriodEnd?: string;
}

function lastDayOfMonth(yyyyMm: string): string {
	// yyyyMm = '2026-05' → '2026-05-31'
	const [yStr, mStr] = yyyyMm.split('-');
	const y = Number(yStr);
	const m = Number(mStr);
	if (!Number.isFinite(y) || !Number.isFinite(m)) return '';
	const last = new Date(Date.UTC(y, m, 0));
	return last.toISOString().slice(0, 10);
}

function defaultMonth(): string {
	const d = new Date();
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, '0');
	return `${y}-${m}`;
}

/**
 * Opens a small dialog with a month picker + a Run button. Posts the
 * batched depreciation JE and reports the totals. Defaults to the
 * current calendar month — most users just confirm.
 */
export function RunDepreciationButton({ defaultPeriodEnd }: Props) {
	const [open, setOpen] = useState(false);
	const [pending, startTransition] = useTransition();
	const [month, setMonth] = useState(() => {
		if (defaultPeriodEnd && /^\d{4}-\d{2}-\d{2}$/.test(defaultPeriodEnd)) {
			return defaultPeriodEnd.slice(0, 7);
		}
		return defaultMonth();
	});
	const [result, setResult] = useState<RunDepreciationResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const router = useRouter();

	const onRun = () => {
		const periodEndDate = lastDayOfMonth(month);
		if (!periodEndDate) {
			setError('Pick a valid month');
			return;
		}
		setError(null);
		setResult(null);
		startTransition(async () => {
			const r = await runDepreciation({ periodEndDate });
			if (!r.ok) {
				setError(r.error ?? 'Failed to run');
				return;
			}
			setResult(r);
			router.refresh();
		});
	};

	const onClose = () => {
		setOpen(false);
		setResult(null);
		setError(null);
	};

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
			>
				Run depreciation
			</button>

			{open && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
					<div className="w-full max-w-md rounded-lg border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
						<div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
							<h2 className="text-base font-semibold">Run depreciation</h2>
							<p className="text-xs text-zinc-500 dark:text-zinc-400">
								Posts a batched fiduciary-book depreciation JE for every active
								asset that&rsquo;s not already current through the end of the
								picked month.
							</p>
						</div>

						<div className="space-y-3 px-5 py-4 text-sm">
							<label className="flex flex-col gap-1">
								<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
									Period (month)
								</span>
								<input
									type="month"
									value={month}
									onChange={(e) => setMonth(e.target.value)}
									disabled={pending || !!result}
									className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
								/>
								<span className="text-[10px] text-zinc-500">
									Period ends {lastDayOfMonth(month) || '—'}
								</span>
							</label>

							{error && (
								<div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">
									{error}
								</div>
							)}

							{result && result.ok && (
								<div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">
									{result.assetsIncluded === 0 ? (
										<>No depreciation posted — every active asset is already current.</>
									) : (
										<>
											Posted {CURRENCY_FMT.format(result.totalExpense ?? 0)} of
											depreciation across{' '}
											<strong>{result.assetsIncluded}</strong> asset
											{result.assetsIncluded === 1 ? '' : 's'}.
											{result.journalEntryId && (
												<>
													{' '}
													JE{' '}
													<a
														href={`/journal-entries/${result.journalEntryId}`}
														className="font-mono underline"
													>
														{result.journalEntryId.slice(0, 8)}
													</a>
													.
												</>
											)}
										</>
									)}
									{result.skipped && result.skipped.length > 0 && (
										<details className="mt-2">
											<summary className="cursor-pointer">
												{result.skipped.length} skipped — show why
											</summary>
											<ul className="mt-1 list-disc pl-5">
												{result.skipped.slice(0, 10).map((s) => (
													<li key={s.assetId}>
														{s.assetName}: {s.reason}
													</li>
												))}
												{result.skipped.length > 10 && (
													<li>+ {result.skipped.length - 10} more…</li>
												)}
											</ul>
										</details>
									)}
								</div>
							)}
						</div>

						<div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
							<button
								type="button"
								onClick={onClose}
								disabled={pending}
								className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
							>
								{result ? 'Close' : 'Cancel'}
							</button>
							{!result && (
								<button
									type="button"
									onClick={onRun}
									disabled={pending}
									className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
								>
									{pending ? 'Running…' : 'Run'}
								</button>
							)}
						</div>
					</div>
				</div>
			)}
		</>
	);
}
