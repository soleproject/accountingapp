'use client';

import { useState, useTransition } from 'react';
import {
	dismissTrustReviewFinding,
	undismissTrustReviewFinding,
} from '../_actions/dismissFinding';

interface Props {
	findingId: string;
	dismissed: boolean;
	/** When true, render grey-at-rest with rose only on hover — used in
	 *  per-row mounts under loan-payment so the row doesn't shout a red X
	 *  by default. No effect when `dismissed` is true (the re-open button
	 *  is already zinc). */
	muted?: boolean;
}

export function DismissButton({ findingId, dismissed, muted = false }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const onClick = () => {
		setError(null);
		startTransition(async () => {
			const result = dismissed
				? await undismissTrustReviewFinding(findingId)
				: await dismissTrustReviewFinding({ findingId });
			if (!result.ok) setError(result.error ?? 'Failed');
		});
	};

	// Red icon (X) for dismiss → "remove from queue" affordance.
	// Zinc icon (rotate-undo) for re-open → "bring it back" affordance.
	// Muted dismiss → grey-at-rest with rose only on hover.
	const colorCls = dismissed
		? 'border-zinc-300 bg-zinc-50 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
		: muted
			? 'border-zinc-200 bg-transparent text-zinc-400 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-rose-800 dark:hover:bg-rose-900/30 dark:hover:text-rose-300'
			: 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-900/30 dark:text-rose-300 dark:hover:bg-rose-900/50';

	const title = pending
		? (dismissed ? 'Re-opening…' : 'Dismissing…')
		: dismissed
			? 'Re-open finding'
			: 'Dismiss finding';

	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				onClick={onClick}
				disabled={pending}
				title={title}
				aria-label={title}
				className={`inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${colorCls}`}
			>
				{pending ? (
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin" aria-hidden="true">
						<path d="M21 12a9 9 0 11-6.219-8.56" />
					</svg>
				) : dismissed ? (
					// Rotate-counter-clockwise — "bring this back"
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<polyline points="1 4 1 10 7 10" />
						<path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
					</svg>
				) : (
					// X mark — "dismiss"
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				)}
			</button>
			{error && <span className="text-xs text-red-600">{error}</span>}
		</div>
	);
}
