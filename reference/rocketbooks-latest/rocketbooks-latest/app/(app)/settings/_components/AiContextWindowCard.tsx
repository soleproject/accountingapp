'use client';

import { useState, useTransition } from 'react';
import { setAiContextWindowAction } from '../_actions/aiContextWindow';

interface Props {
	initial: number | null;
}

const OPTIONS: Array<{ value: number; label: string; hint?: string }> = [
	{ value: 3, label: '3 prior messages', hint: 'Tightest context, cheapest, fastest' },
	{ value: 5, label: '5 prior messages', hint: 'Default — covers most threads' },
	{ value: 10, label: '10 prior messages', hint: 'Wider window for complex discussions' },
	{ value: 0, label: 'Full thread', hint: 'No cap — token cost grows with thread length' },
];

/**
 * Card on /settings letting the user pick how much prior thread context
 * the inbox AI draft job feeds to the model. The cron and on-demand
 * regenerate actions both read this at draft time so a change applies
 * to the very next draft.
 */
export function AiContextWindowCard({ initial }: Props) {
	const [value, setValue] = useState<number>(initial ?? 5);
	const [savedValue, setSavedValue] = useState<number>(initial ?? 5);
	const [error, setError] = useState<string | null>(null);
	const [isPending, startTransition] = useTransition();

	const handleChange = (next: number) => {
		setValue(next);
		setError(null);
		startTransition(async () => {
			const r = await setAiContextWindowAction({ value: next });
			if (!r.ok) {
				setError(r.error ?? 'Save failed');
				setValue(savedValue);
				return;
			}
			setSavedValue(next);
		});
	};

	return (
		<section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
			<header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
				<h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">AI Inbox</h2>
			</header>
			<div className="flex flex-col gap-3 px-4 py-3 text-sm">
				<label className="flex flex-col gap-1.5">
					<span className="font-medium text-zinc-700 dark:text-zinc-300">Thread context</span>
					<span className="text-xs text-zinc-500">
						How many prior messages in the thread should the AI see when drafting a reply?
					</span>
					<select
						value={value}
						onChange={(e) => handleChange(parseInt(e.target.value, 10))}
						disabled={isPending}
						className="mt-1 max-w-xs rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950"
					>
						{OPTIONS.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
					<span className="text-xs text-zinc-500">
						{OPTIONS.find((o) => o.value === value)?.hint}
					</span>
				</label>
				{error && (
					<div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
						{error}
					</div>
				)}
				{isPending && <div className="text-xs text-zinc-500">Saving…</div>}
			</div>
		</section>
	);
}
