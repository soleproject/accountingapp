'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { applyRebuild, type RebuildAction } from '../_actions/applyRebuild';

export interface ReviewRow {
	rowId: string;
	paymentNumber: number;
	dueDate: string;
	postedDate: string | null;
	scheduledPrincipal: number;
	scheduledInterest: number;
	scheduledTotal: number;
	actualPrincipal: number;
	actualInterest: number;
	actualTotal: number;
	/** Per-component variances. A row is a real "match" only when both
	 *  are within rounding — totals matching with split drift still
	 *  counts as a variance worth deciding on. */
	principalDelta: number;
	interestDelta: number;
	delta: number;
	journalEntryId: string | null;
}

function isRowMatch(r: ReviewRow): boolean {
	return Math.abs(r.principalDelta) < 0.005 && Math.abs(r.interestDelta) < 0.005;
}

interface Props {
	loanId: string;
	rows: ReviewRow[];
}

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const SIGNED_FMT = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	signDisplay: 'exceptZero',
});

type DecisionMap = Record<string, RebuildAction | undefined>;

/**
 * Per-row + bulk decision UI for the post-edit rebuild flow. Matches
 * (delta = $0) default to "accept" so the user can one-click commit if
 * nothing's really off. Variances need an explicit decision before
 * Commit is enabled.
 */
export function RebuildReview({ loanId, rows }: Props) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const initialDecisions: DecisionMap = useMemo(() => {
		const m: DecisionMap = {};
		for (const r of rows) {
			if (isRowMatch(r)) m[r.rowId] = 'accept';
		}
		return m;
	}, [rows]);
	const [decisions, setDecisions] = useState<DecisionMap>(initialDecisions);

	const matches = rows.filter(isRowMatch);
	const variances = rows.filter((r) => !isRowMatch(r));
	const decidedCount = rows.filter((r) => decisions[r.rowId]).length;
	const allDecided = decidedCount === rows.length;

	const setOne = (rowId: string, action: RebuildAction | undefined) => {
		setDecisions((prev) => ({ ...prev, [rowId]: action }));
	};

	const bulkApply = (predicate: (r: ReviewRow) => boolean, action: RebuildAction) => {
		setDecisions((prev) => {
			const next = { ...prev };
			for (const r of rows) {
				if (predicate(r)) next[r.rowId] = action;
			}
			return next;
		});
	};

	const onCommit = () => {
		setError(null);
		const payload = rows.map((r) => ({
			scheduleRowId: r.rowId,
			action: decisions[r.rowId]!,
		}));
		startTransition(async () => {
			const r = await applyRebuild({ loanId, decisions: payload });
			if (!r.ok) {
				setError(r.error ?? 'Rebuild apply failed');
				return;
			}
			router.push(`/loans/${loanId}`);
		});
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
				Pick a decision per row, then commit. Bulk shortcuts:
				<div className="mt-2 flex flex-wrap gap-2">
					<BulkButton onClick={() => bulkApply(isRowMatch, 'accept')} disabled={matches.length === 0}>
						Accept all {matches.length} match{matches.length === 1 ? '' : 'es'}
					</BulkButton>
					<BulkButton onClick={() => bulkApply((r) => !isRowMatch(r), 'redo')} disabled={variances.length === 0}>
						Re-record all {variances.length} variance{variances.length === 1 ? '' : 's'} at new amount
					</BulkButton>
					<BulkButton onClick={() => bulkApply((r) => !isRowMatch(r), 'accept')} disabled={variances.length === 0}>
						Accept all variances as posted
					</BulkButton>
					<BulkButton onClick={() => bulkApply(() => true, 'reverse')} disabled={rows.length === 0}>
						Reverse everything
					</BulkButton>
				</div>
			</div>

			<div className="overflow-hidden rounded-lg border border-zinc-400 bg-amber-50 shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 dark:border-zinc-500 dark:bg-amber-950/20 dark:shadow-black/60 dark:ring-white/10">
				<table className="w-full text-sm">
					<thead className="bg-amber-100/60 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-amber-900/30">
						<tr>
							<th className="px-3 py-2 font-medium">#</th>
							<th className="px-3 py-2 font-medium">Due (new)</th>
							<th className="px-3 py-2 text-right font-medium">Scheduled</th>
							<th className="px-3 py-2 text-right font-medium">Actual posted</th>
							<th className="px-3 py-2 text-right font-medium">Δ</th>
							<th className="px-3 py-2 font-medium">Decision</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => {
							const matched = isRowMatch(r);
							const totalsMatch = Math.abs(r.delta) < 0.005;
							const splitShifted = totalsMatch && !matched;
							const decision = decisions[r.rowId];
							return (
								<tr key={r.rowId} className="border-t border-zinc-100 dark:border-zinc-800">
									<td className="px-3 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">
										{r.paymentNumber}
									</td>
									<td className="px-3 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">
										{r.dueDate}
										{r.postedDate && r.postedDate !== r.dueDate && (
											<div className="text-xs text-zinc-500">posted {r.postedDate}</div>
										)}
									</td>
									<td className="px-3 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
										{CURRENCY_FMT.format(r.scheduledTotal)}
										<div className="text-xs text-zinc-500">
											P {CURRENCY_FMT.format(r.scheduledPrincipal)} / I {CURRENCY_FMT.format(r.scheduledInterest)}
										</div>
									</td>
									<td className="px-3 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
										{r.journalEntryId ? (
											<Link
												href={`/journal-entries/${r.journalEntryId}`}
												className="text-blue-600 hover:underline dark:text-blue-400"
											>
												{CURRENCY_FMT.format(r.actualTotal)}
											</Link>
										) : (
											CURRENCY_FMT.format(r.actualTotal)
										)}
										<div className="text-xs text-zinc-500">
											P {CURRENCY_FMT.format(r.actualPrincipal)} / I {CURRENCY_FMT.format(r.actualInterest)}
										</div>
									</td>
									<td className="px-3 py-2 text-right tabular-nums">
										{matched ? (
											<span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
												match
											</span>
										) : splitShifted ? (
											<>
												<span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
													split shift
												</span>
												<div className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">
													P {SIGNED_FMT.format(r.principalDelta)}
													{' / '}
													I {SIGNED_FMT.format(r.interestDelta)}
												</div>
											</>
										) : (
											<>
												<span className="font-medium text-amber-700 dark:text-amber-300">
													{SIGNED_FMT.format(r.delta)}
												</span>
												<div className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">
													P {SIGNED_FMT.format(r.principalDelta)}
													{' / '}
													I {SIGNED_FMT.format(r.interestDelta)}
												</div>
											</>
										)}
									</td>
									<td className="px-3 py-2">
										<DecisionRadio
											rowId={r.rowId}
											value={decision}
											onChange={(a) => setOne(r.rowId, a)}
										/>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			{error && (
				<div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950/30 dark:text-red-200">
					{error}
				</div>
			)}

			<div className="flex items-center justify-between gap-3">
				<div className="text-sm text-zinc-600 dark:text-zinc-400">
					{decidedCount} of {rows.length} rows have a decision
				</div>
				<div className="flex items-center gap-3">
					<Link
						href={`/loans/${loanId}`}
						className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
					>
						Cancel
					</Link>
					<button
						type="button"
						onClick={onCommit}
						disabled={!allDecided || pending}
						className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
					>
						{pending ? 'Committing…' : 'Commit changes'}
					</button>
				</div>
			</div>
		</div>
	);
}

function BulkButton({
	onClick,
	disabled,
	children,
}: {
	onClick: () => void;
	disabled?: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
		>
			{children}
		</button>
	);
}

function DecisionRadio({
	rowId,
	value,
	onChange,
}: {
	rowId: string;
	value: RebuildAction | undefined;
	onChange: (action: RebuildAction) => void;
}) {
	const options: Array<{ key: RebuildAction; label: string; title: string }> = [
		{
			key: 'accept',
			label: 'Accept',
			title: 'Keep the JE as posted. The schedule row updates to reflect what was really paid.',
		},
		{
			key: 'redo',
			label: 'Re-record',
			title: 'Reverse the existing JE and post a fresh one at the new scheduled amount.',
		},
		{
			key: 'reverse',
			label: 'Reverse',
			title: 'Reverse the JE; the row goes back to scheduled. Principal returns to current balance.',
		},
	];
	return (
		<div className="flex flex-wrap gap-1">
			{options.map((o) => (
				<label
					key={o.key}
					title={o.title}
					className={`inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
						value === o.key
							? 'border-blue-500 bg-blue-50 text-blue-800 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-200'
							: 'border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900'
					}`}
				>
					<input
						type="radio"
						name={`decision-${rowId}`}
						value={o.key}
						checked={value === o.key}
						onChange={() => onChange(o.key)}
						className="sr-only"
					/>
					{o.label}
				</label>
			))}
		</div>
	);
}
