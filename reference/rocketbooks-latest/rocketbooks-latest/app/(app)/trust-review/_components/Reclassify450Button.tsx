'use client';

import { useState, useTransition } from 'react';
import { reclassify450To455 } from '../_actions/reclassify450To455';

interface Props {
	findingId: string;
}

/**
 * One-click reclassify-to-455 for TRUST_450_BUSINESS_INCOME_BLOCKED.
 * (450 is rule-blocked at posting time so this normally won't appear in
 * the queue; the action covers legacy postings + audit closure.)
 */
export function Reclassify450Button({ findingId }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const submit = () => {
		setError(null);
		startTransition(async () => {
			const r = await reclassify450To455({ findingId });
			if (!r.ok) setError(r.error ?? 'Failed to reclassify');
		});
	};

	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				onClick={submit}
				disabled={pending}
				title="Reclassify business income to 455 K-1 (routes through an external LLC/S-Corp)"
				className="flex h-7 items-center justify-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
			>
				→ 455 K-1
			</button>
			{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
		</div>
	);
}
