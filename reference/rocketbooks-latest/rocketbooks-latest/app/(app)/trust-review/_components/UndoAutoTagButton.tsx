'use client';

import { useState, useTransition } from 'react';
import { undoAutoTag } from '../_actions/undoAutoTag';

interface Props {
	findingId: string;
}

/**
 * Reverse a TRUST_TAG_AUTO_APPLIED audit. Clears the dimensions the
 * audit applied, dismisses this audit row, and re-runs the auto-tag
 * gate so the user gets re-prompted with an UNTAGGED finding if the
 * line is still on a property-relevant account.
 */
export function UndoAutoTagButton({ findingId }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const onClick = () => {
		const ok = window.confirm(
			'Reverse this auto-tag? The line will be untagged and you\'ll see the original prompt to pick again.',
		);
		if (!ok) return;
		setError(null);
		startTransition(async () => {
			const r = await undoAutoTag({ findingId });
			if (!r.ok) setError(r.error ?? 'Undo failed');
		});
	};

	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				onClick={onClick}
				disabled={pending}
				title="Reverse this auto-tag"
				className="flex h-7 items-center gap-1 rounded-md border border-red-300 bg-white px-2 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:bg-zinc-950 dark:text-red-300 dark:hover:bg-red-950/30"
			>
				{pending ? '…' : '↶ Undo'}
			</button>
			{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
		</div>
	);
}
