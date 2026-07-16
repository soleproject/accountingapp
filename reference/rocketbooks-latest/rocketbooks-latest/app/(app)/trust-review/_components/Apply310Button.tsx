'use client';

import { useState, useTransition } from 'react';
import { apply310ToDemandNote } from '../_actions/apply310ToDemandNote';

interface Props {
	findingId: string;
}

/**
 * One-click "apply to demand note" for TRUST_310_DEMAND_NOTE_NOT_EXHAUSTED.
 * The action figures out the split (up to outstanding balance), reverses
 * + reposts. No picker needed — the rule already names the beneficiary.
 */
export function Apply310Button({ findingId }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const submit = () => {
		setError(null);
		startTransition(async () => {
			const r = await apply310ToDemandNote({ findingId });
			if (!r.ok) setError(r.error ?? 'Failed to apply');
		});
	};

	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				onClick={submit}
				disabled={pending}
				title="Credit the beneficiary's demand note for up to the outstanding balance; residual stays on 310"
				className="flex h-7 items-center justify-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
			>
				↪ Apply to demand note
			</button>
			{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
		</div>
	);
}
