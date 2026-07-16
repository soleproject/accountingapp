'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { approveDebriefAction } from '../_actions/approveDebrief';

export interface DebriefItem {
	id: string;
	description: string;
	ownerLabel: string;
	dueHint: string | null;
	status: string;
	resultTaskId: string | null;
}

interface Props {
	appointmentId: string;
	state: string;
	notesSource: string | null;
	hasRecording: boolean;
	items: DebriefItem[];
}

const STATUS_TONE: Record<string, string> = {
	executed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
	skipped: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
	failed: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
};
const STATUS_LABEL: Record<string, string> = {
	executed: 'Tracked',
	skipped: 'Skipped',
	failed: 'Failed',
	proposed: 'Pending',
	approved: 'Pending',
};

export function DebriefReview({ appointmentId, state, notesSource, hasRecording, items }: Props) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	// Editable working copy (only used while debrief_pending).
	const [draft, setDraft] = useState(
		items.map((it) => ({ id: it.id, include: it.status !== 'skipped', description: it.description })),
	);

	const editable = state === 'debrief_pending';
	const includedCount = draft.filter((d) => d.include).length;

	const submit = () => {
		setError(null);
		startTransition(async () => {
			const r = await approveDebriefAction({
				appointmentId,
				items: draft.map((d) => ({ id: d.id, include: d.include, description: d.description })),
			});
			if (!r.ok) {
				setError(r.error ?? 'Something went wrong.');
				return;
			}
			router.refresh();
		});
	};

	// --- Completed / read-only ledger -------------------------------------------
	if (!editable) {
		return (
			<section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
				<header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
					<h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Action items</h2>
					{state === 'completed' && (
						<span className="text-xs text-emerald-600 dark:text-emerald-400">Debrief complete</span>
					)}
				</header>
				{items.length === 0 ? (
					<p className="px-4 py-3 text-sm text-zinc-500">No action items were recorded for this meeting.</p>
				) : (
					<ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
						{items.map((it) => (
							<li key={it.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
								<div className="min-w-0">
									<div className="text-zinc-700 dark:text-zinc-300">{it.description}</div>
									<div className="mt-0.5 text-xs text-zinc-500">
										{it.ownerLabel}
										{it.dueHint ? ` · ${it.dueHint}` : ''}
									</div>
								</div>
								<div className="flex shrink-0 items-center gap-2">
									{it.status === 'executed' && it.resultTaskId && (
										<Link
											href={`/organizer/tasks/${it.resultTaskId}/workspace`}
											className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
										>
											Open task
										</Link>
									)}
									<span
										className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
											STATUS_TONE[it.status] ?? STATUS_TONE.skipped
										}`}
									>
										{STATUS_LABEL[it.status] ?? it.status}
									</span>
								</div>
							</li>
						))}
					</ul>
				)}
			</section>
		);
	}

	// --- Editable review --------------------------------------------------------
	return (
		<section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
			<header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
				<h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Review action items</h2>
			</header>

			{draft.length === 0 ? (
				<p className="px-4 py-3 text-sm text-zinc-500">
					{hasRecording
						? 'No action items were detected in the transcript.'
						: notesSource === 'manual'
							? 'Notes came in but were not auto-analyzed. Review them and approve to close out this debrief.'
							: 'No action items to review.'}
				</p>
			) : (
				<ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
					{draft.map((d, i) => {
						const meta = items[i];
						return (
							<li key={d.id} className="flex items-start gap-3 px-4 py-3 text-sm">
								<input
									type="checkbox"
									checked={d.include}
									onChange={(e) =>
										setDraft((prev) => prev.map((p) => (p.id === d.id ? { ...p, include: e.target.checked } : p)))
									}
									disabled={isPending}
									className="mt-1.5 h-4 w-4 shrink-0"
									aria-label="Include this action item"
								/>
								<div className="min-w-0 flex-1">
									<textarea
										value={d.description}
										onChange={(e) =>
											setDraft((prev) => prev.map((p) => (p.id === d.id ? { ...p, description: e.target.value } : p)))
										}
										disabled={isPending || !d.include}
										rows={2}
										maxLength={1000}
										className="w-full resize-y rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm leading-relaxed focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950"
									/>
									<div className="mt-0.5 text-xs text-zinc-500">
										{meta.ownerLabel}
										{meta.dueHint ? ` · ${meta.dueHint}` : ''}
									</div>
								</div>
							</li>
						);
					})}
				</ul>
			)}

			<div className="flex flex-col gap-2 border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
				<p className="text-xs text-zinc-500">
					Approving creates one tracking task per included item. RocketSuite will not email or text anyone on
					your behalf.
				</p>
				{error && (
					<div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
						{error}
					</div>
				)}
				<div className="flex items-center justify-end">
					<button
						type="button"
						onClick={submit}
						disabled={isPending}
						className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
					>
						{isPending
							? 'Working…'
							: draft.length === 0
								? 'Mark reviewed'
								: `Approve & run ${includedCount} item${includedCount === 1 ? '' : 's'}`}
					</button>
				</div>
			</div>
		</section>
	);
}
