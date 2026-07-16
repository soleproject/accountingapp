'use client';

import { useTransition } from 'react';
import { markStatusAction } from '../_actions/markStatus';

/**
 * Inline triage controls on the detail view header. Two buttons (Mark
 * triaged / Archive) that disappear contextually based on current
 * status. After flipping, server revalidate causes the page to re-render
 * with the new badge.
 */
interface Props {
	messageId: string;
	currentStatus: string;
}

export function StatusButtons({ messageId, currentStatus }: Props) {
	const [isPending, startTransition] = useTransition();

	const set = (status: 'open' | 'triaged' | 'archived') => {
		startTransition(async () => {
			await markStatusAction({ messageId, status });
		});
	};

	return (
		<div className="flex items-center gap-2">
			{currentStatus !== 'triaged' && (
				<button
					type="button"
					onClick={() => set('triaged')}
					disabled={isPending}
					className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
				>
					Mark triaged
				</button>
			)}
			{currentStatus !== 'archived' ? (
				<button
					type="button"
					onClick={() => set('archived')}
					disabled={isPending}
					className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
				>
					Archive
				</button>
			) : (
				<button
					type="button"
					onClick={() => set('open')}
					disabled={isPending}
					className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
				>
					Unarchive
				</button>
			)}
		</div>
	);
}
