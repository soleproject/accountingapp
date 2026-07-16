'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
	getDobCorrectionJobStatus,
	type DobCorrectionJobStatus,
} from '../_actions/getDobCorrectionJobStatus';

interface Props {
	beneficiaryId: string;
	/** Server-rendered initial snapshot — keeps the pill from flashing
	 *  "no job" on first paint while the first poll resolves. */
	initialJob: DobCorrectionJobStatus | null;
}

const POLL_MS = 2500;
const FINISHED_AUTOHIDE_MS = 8000;

/**
 * Floating bottom-right pill that mirrors the active (or recently-
 * completed) DOB-correction job for a beneficiary. Survives page
 * navigations within the app because the job state lives in the DB,
 * not in component state — close the tab and reopen, the pill
 * reconnects via getDobCorrectionJobStatus.
 *
 * Lifecycle:
 *   - queued / running → poll every POLL_MS, show progress bar
 *   - completed         → show success summary for FINISHED_AUTOHIDE_MS, then hide
 *   - failed            → show error, manual dismiss
 *   - no job            → render nothing
 */
export function DobCorrectionProgressPill({ beneficiaryId, initialJob }: Props) {
	const [job, setJob] = useState<DobCorrectionJobStatus | null>(initialJob);
	const [dismissed, setDismissed] = useState(false);
	const router = useRouter();

	const isActive = job?.status === 'queued' || job?.status === 'running';
	const isCompleted = job?.status === 'completed';

	useEffect(() => {
		if (!isActive) return;
		let cancelled = false;
		const tick = async () => {
			const r = await getDobCorrectionJobStatus({ beneficiaryId });
			if (cancelled) return;
			if (r.ok) {
				setJob(r.job);
				// When the job flips to completed, kick a refresh so
				// the page picks up the new GL state without a manual
				// reload. The Inngest worker also calls revalidatePath
				// but a client router.refresh() avoids the user staring
				// at stale numbers between the revalidate hitting the
				// cache and their next navigation.
				if (r.job?.status === 'completed' || r.job?.status === 'failed') {
					router.refresh();
				}
			}
		};
		const i = setInterval(tick, POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(i);
		};
	}, [beneficiaryId, isActive, router]);

	// Auto-hide a completed pill after a few seconds so it doesn't
	// linger forever.
	useEffect(() => {
		if (!isCompleted || dismissed) return;
		const t = setTimeout(() => setDismissed(true), FINISHED_AUTOHIDE_MS);
		return () => clearTimeout(t);
	}, [isCompleted, dismissed]);

	if (!job) return null;
	if (dismissed) return null;
	if (job.status === 'completed' && job.repostedCount === 0 && job.failedCount === 0) {
		// Nothing actually moved — don't bother surfacing.
		return null;
	}

	const done = job.repostedCount + job.failedCount;
	const pct = job.totalCount > 0 ? Math.min(100, Math.round((done * 100) / job.totalCount)) : 0;

	const isFailed = job.status === 'failed';
	const headline = isActive
		? `Reposting ${job.totalCount} JE${job.totalCount === 1 ? '' : 's'}…`
		: isCompleted
			? job.failedCount > 0
				? `Reposted ${job.repostedCount}, ${job.failedCount} failed`
				: `Reposted ${job.repostedCount} JE${job.repostedCount === 1 ? '' : 's'}`
			: isFailed
				? 'DOB correction failed'
				: '';

	return (
		<div className="fixed bottom-4 right-4 z-50 w-80 rounded-xl border border-zinc-300 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
			<div className="flex items-start gap-3 px-4 py-3">
				{isActive ? (
					<svg
						viewBox="0 0 24 24"
						width="18"
						height="18"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						className="mt-0.5 shrink-0 animate-spin text-blue-600 dark:text-blue-400"
						aria-hidden="true"
					>
						<path d="M21 12a9 9 0 11-6.219-8.56" />
					</svg>
				) : isCompleted ? (
					<svg
						viewBox="0 0 24 24"
						width="18"
						height="18"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
						aria-hidden="true"
					>
						<polyline points="20 6 9 17 4 12" />
					</svg>
				) : (
					<svg
						viewBox="0 0 24 24"
						width="18"
						height="18"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						className="mt-0.5 shrink-0 text-red-600 dark:text-red-400"
						aria-hidden="true"
					>
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				)}
				<div className="flex-1 text-sm">
					<div className="font-medium text-zinc-900 dark:text-zinc-100">{headline}</div>
					<div className="text-xs text-zinc-500 dark:text-zinc-400">
						DOB → {job.newDob}
						{isActive && (
							<>
								{' · '}
								{done} / {job.totalCount}
							</>
						)}
					</div>
					{isFailed && job.errorMessage && (
						<div className="mt-1 text-xs text-red-600 dark:text-red-400">
							{job.errorMessage}
						</div>
					)}
				</div>
				{!isActive && (
					<button
						type="button"
						onClick={() => setDismissed(true)}
						aria-label="Dismiss"
						className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
					>
						<svg
							viewBox="0 0 24 24"
							width="14"
							height="14"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.5"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				)}
			</div>
			{isActive && (
				<div className="h-1 w-full overflow-hidden rounded-b-xl bg-zinc-100 dark:bg-zinc-800">
					<div
						className="h-full bg-blue-500 transition-all duration-500 dark:bg-blue-400"
						style={{ width: `${pct}%` }}
					/>
				</div>
			)}
		</div>
	);
}
