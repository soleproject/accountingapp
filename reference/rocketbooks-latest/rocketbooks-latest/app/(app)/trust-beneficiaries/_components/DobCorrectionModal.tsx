'use client';

import { useState, useTransition } from 'react';
import { queueBeneficiaryDobChange } from '../_actions/queueBeneficiaryDobChange';
import type {
	DobCorrectionDiff,
	DobCorrectionItem,
} from '@/lib/accounting/trust-dob-correction';

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

interface Props {
	diff: DobCorrectionDiff;
	onCancel: () => void;
	/** Fired with applied=true on a successful save so the row knows to
	 *  refresh / drop edit mode. */
	onApplied: () => void;
}

/**
 * Preview-and-confirm dialog rendered when a beneficiary's DOB save
 * would require reposting historical JEs. Lists the rerouteOut +
 * rerouteIn diffs with totals, shows which JEs we can auto-repost and
 * which require manual fix-up, and gates the actual writes behind an
 * explicit confirm button.
 */
export function DobCorrectionModal({ diff, onCancel, onApplied }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const autoOut = diff.rerouteOut.filter((i) => i.canAutoRepost);
	const autoIn = diff.rerouteIn.filter((i) => i.canAutoRepost);
	const manualOut = diff.rerouteOut.filter((i) => !i.canAutoRepost);
	const manualIn = diff.rerouteIn.filter((i) => !i.canAutoRepost);
	const allManual = [...manualOut, ...manualIn, ...diff.manualReview];

	const autoCount = autoOut.length + autoIn.length;
	const sumOut = autoOut.reduce((a, i) => a + i.amount, 0);
	const sumIn = autoIn.reduce((a, i) => a + i.amount, 0);

	const onConfirm = () => {
		const jeIdsToRepost = [...autoOut, ...autoIn].map((i) => i.jeId);
		setError(null);
		startTransition(async () => {
			const r = await queueBeneficiaryDobChange({
				beneficiaryId: diff.beneficiaryId,
				newDob: diff.newDob,
				jeIdsToRepost,
			});
			if (!r.ok) {
				setError(r.error ?? 'Failed to queue');
				return;
			}
			// Job is now running in the background — bubble up so the
			// row can drop edit mode. The DobCorrectionProgressPill on
			// the bene detail page picks up the job and shows progress
			// even if the user navigates away.
			onApplied();
		});
	};

	// While the queue server-action is in flight, downsize the modal to a
	// brief non-blocking toast. This pending state is sub-second (the
	// action only snapshots the diff into a job row and fires an Inngest
	// event); the long-running repost work runs in the background worker
	// and surfaces via DobCorrectionProgressPill.
	if (pending) {
		return (
			<div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-zinc-300 bg-white px-4 py-3 text-sm shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
				<div className="flex items-center gap-3">
					<svg
						viewBox="0 0 24 24"
						width="18"
						height="18"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						className="shrink-0 animate-spin text-blue-600 dark:text-blue-400"
						aria-hidden="true"
					>
						<path d="M21 12a9 9 0 11-6.219-8.56" />
					</svg>
					<div className="flex-1">
						<div className="font-medium text-zinc-900 dark:text-zinc-100">
							Queueing {autoCount} JE{autoCount === 1 ? '' : 's'}…
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
			<div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
				<div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
					<h2 className="text-lg font-semibold">DOB correction preview</h2>
					<p className="text-sm text-zinc-500 dark:text-zinc-400">
						{diff.beneficiaryName} · {diff.oldDob ?? 'no DOB on file'} → {diff.newDob}
					</p>
				</div>

				<div className="space-y-5 px-5 py-4 text-sm">
					{autoCount === 0 && allManual.length === 0 && (
						<div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">
							No historical postings need to change. The new DOB will save without reposts.
						</div>
					)}

					{autoOut.length > 0 && (
						<DiffSection
							title="815/820 → demand note"
							subtitle={`${autoOut.length} JE${autoOut.length === 1 ? '' : 's'} · ${CURRENCY_FMT.format(sumOut)}`}
							items={autoOut}
							explanation="Was qualifying with the old DOB but isn't with the new one. Each will be reversed and reposted to the beneficiary's demand note."
						/>
					)}

					{autoIn.length > 0 && (
						<DiffSection
							title="demand note → 815/820"
							subtitle={`${autoIn.length} JE${autoIn.length === 1 ? '' : 's'} · ${CURRENCY_FMT.format(sumIn)}`}
							items={autoIn}
							explanation="Was rerouted to the demand note because the old DOB said the beneficiary didn't qualify. The new DOB now qualifies — each will be reversed and reposted to the original 815/820 account."
						/>
					)}

					{allManual.length > 0 && (
						<div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/30">
							<div className="mb-1 font-medium text-amber-900 dark:text-amber-200">
								{allManual.length} JE{allManual.length === 1 ? '' : 's'} need manual fix-up
							</div>
							<div className="text-xs text-amber-900 dark:text-amber-300">
								These aren't transaction-sourced (manual journal entries), so the
								auto-repost can't run. Open each JE and adjust by hand.
							</div>
							<ul className="mt-2 list-disc pl-5 text-xs">
								{allManual.slice(0, 8).map((i) => (
									<li key={i.jeId}>
										{i.jeDate} · {CURRENCY_FMT.format(i.amount)} · {i.fromAccountNumber} {i.fromAccountName} → {i.toAccountNumber} {i.toAccountName}
									</li>
								))}
								{allManual.length > 8 && (
									<li>+ {allManual.length - 8} more…</li>
								)}
							</ul>
						</div>
					)}

					{error && (
						<div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">
							{error}
						</div>
					)}
				</div>

				<div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
					<button
						type="button"
						onClick={onCancel}
						disabled={pending}
						className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
					>
						Cancel (don't save DOB)
					</button>
					<button
						type="button"
						onClick={onConfirm}
						disabled={pending}
						className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
					>
						{pending
							? 'Queueing…'
							: autoCount === 0
								? 'Save DOB'
								: `Save DOB & repost ${autoCount} JE${autoCount === 1 ? '' : 's'}`}
					</button>
				</div>
			</div>
		</div>
	);
}

function DiffSection({
	title,
	subtitle,
	items,
	explanation,
}: {
	title: string;
	subtitle: string;
	items: DobCorrectionItem[];
	explanation: string;
}) {
	return (
		<section>
			<div className="mb-1 flex items-baseline justify-between">
				<div className="font-medium text-zinc-900 dark:text-zinc-100">{title}</div>
				<div className="text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</div>
			</div>
			<p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">{explanation}</p>
			<div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
				<table className="w-full text-xs">
					<thead className="bg-zinc-50 text-left uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
						<tr>
							<th className="px-3 py-1.5 font-medium">Date</th>
							<th className="px-3 py-1.5 font-medium">From</th>
							<th className="px-3 py-1.5 font-medium">To</th>
							<th className="px-3 py-1.5 text-right font-medium">Amount</th>
						</tr>
					</thead>
					<tbody>
						{items.slice(0, 25).map((i) => (
							<tr key={i.jeId} className="border-t border-zinc-100 dark:border-zinc-800">
								<td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">{i.jeDate}</td>
								<td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">
									<span className="font-mono text-[10px] text-zinc-500">
										{i.fromAccountNumber ?? '—'}
									</span>{' '}
									{i.fromAccountName}
								</td>
								<td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">
									<span className="font-mono text-[10px] text-zinc-500">
										{i.toAccountNumber ?? '—'}
									</span>{' '}
									{i.toAccountName}
								</td>
								<td className="px-3 py-1.5 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
									{CURRENCY_FMT.format(i.amount)}
								</td>
							</tr>
						))}
						{items.length > 25 && (
							<tr>
								<td colSpan={4} className="px-3 py-1.5 text-center text-zinc-500">
									+ {items.length - 25} more (all will be reposted)
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
		</section>
	);
}
