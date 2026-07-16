'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createDimension } from '../_actions/dimensionActions';

const inputCls =
	'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-blue-500 dark:focus:ring-blue-900/50';

/**
 * Create a new user-defined dimension. Slug is auto-derived from
 * label on the server (lowercase, _-separated) unless the user
 * overrides; the override field is collapsed by default to keep the
 * common case one-input fast.
 */
export function NewDimensionForm() {
	const router = useRouter();
	const [label, setLabel] = useState('');
	const [emoji, setEmoji] = useState('🏷');
	const [slug, setSlug] = useState('');
	const [showSlug, setShowSlug] = useState(false);
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const submit = () => {
		if (!label.trim()) {
			setError('Label is required');
			return;
		}
		setError(null);
		startTransition(async () => {
			const r = await createDimension({
				label,
				emoji,
				slug: showSlug && slug.trim() ? slug.trim() : undefined,
			});
			if (!r.ok) {
				setError(r.error ?? 'Failed');
				return;
			}
			setLabel('');
			setSlug('');
			setEmoji('🏷');
			setShowSlug(false);
			router.refresh();
		});
	};

	return (
		<div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
			<div className="flex flex-wrap items-end gap-2">
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Emoji</span>
					<input
						type="text"
						value={emoji}
						onChange={(e) => setEmoji(e.target.value.slice(0, 4))}
						maxLength={4}
						className={`${inputCls} w-16 text-center`}
					/>
				</label>
				<label className="flex flex-1 flex-col gap-1 min-w-[14rem]">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Label</span>
					<input
						type="text"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						placeholder="Class, Location, Department, …"
						className={inputCls}
					/>
				</label>
				{showSlug && (
					<label className="flex flex-col gap-1">
						<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
							Slug
						</span>
						<input
							type="text"
							value={slug}
							onChange={(e) => setSlug(e.target.value)}
							placeholder="auto"
							className={`${inputCls} font-mono`}
						/>
					</label>
				)}
				<button
					type="button"
					onClick={submit}
					disabled={pending || !label.trim()}
					className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
				>
					{pending ? 'Creating…' : '+ Create dimension'}
				</button>
				<button
					type="button"
					onClick={() => setShowSlug((v) => !v)}
					className="text-xs text-zinc-500 underline-offset-2 hover:underline"
				>
					{showSlug ? 'auto slug' : 'custom slug'}
				</button>
			</div>
			{error && <div className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
		</div>
	);
}
