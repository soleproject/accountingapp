'use client';

import { useState, useTransition } from 'react';

export interface PickerOption {
	id: string;
	label: string;
	sublabel?: string;
}

type Mode = 'beneficiary' | 'trustee';

interface Props {
	mode: Mode;
	options: readonly PickerOption[];
	/** Called with a single id when "Assign one" is picked. */
	onAssignOne: (id: string) => Promise<{ ok: boolean; error?: string }>;
	/** Called with all ids when "Split evenly" is picked. */
	onSplitAll: (ids: string[]) => Promise<{ ok: boolean; error?: string }>;
	onClose: () => void;
	/** When false, the "split evenly across all" checkbox is hidden — the
	 *  modal becomes a single-pick chooser. Defaults to true (710 family). */
	supportsSplit?: boolean;
}

/**
 * Shared assign-or-split modal for the 710 (Meals & Entertainment) per-row
 * actions. Two modes (beneficiary | trustee) — same UI shape, only labels
 * change. When opened with N options, the user can either pick exactly
 * one (which fires onAssignOne) or split the line evenly across every
 * option (onSplitAll). Submits route through the parent button so it can
 * own the network/transition state and the icon-button animation.
 */
export function Assign710Modal({
	mode,
	options,
	onAssignOne,
	onSplitAll,
	onClose,
	supportsSplit = true,
}: Props) {
	const [picked, setPicked] = useState<string>(options[0]?.id ?? '');
	const [splitting, setSplitting] = useState(false);
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const titleWord = mode === 'beneficiary' ? 'beneficiary' : 'trustee';
	const splitWord = mode === 'beneficiary' ? 'beneficiaries' : 'trustees';

	const submit = () => {
		setError(null);
		if (splitting) {
			startTransition(async () => {
				const r = await onSplitAll(options.map((o) => o.id));
				if (!r.ok) setError(r.error ?? `Failed to split across ${splitWord}`);
				else onClose();
			});
			return;
		}
		if (!picked) {
			setError(`Pick a ${titleWord} first`);
			return;
		}
		startTransition(async () => {
			const r = await onAssignOne(picked);
			if (!r.ok) setError(r.error ?? `Failed to assign ${titleWord}`);
			else onClose();
		});
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
			<div className="w-full max-w-md rounded-lg border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
				<div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
					<h2 className="text-base font-semibold">
						Assign {titleWord}
					</h2>
					<p className="text-xs text-zinc-500 dark:text-zinc-400">
						This trust has multiple {splitWord} on file — assign one or split
						evenly across all of them.
					</p>
				</div>

				<div className="space-y-3 px-5 py-4 text-sm">
					<fieldset className="space-y-2" disabled={splitting || pending}>
						<legend className="sr-only">Choose one {titleWord}</legend>
						{options.map((o) => (
							<label
								key={o.id}
								className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 ${
									!splitting && picked === o.id
										? 'border-blue-400 bg-blue-50 dark:border-blue-600 dark:bg-blue-900/30'
										: 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800'
								} ${splitting ? 'opacity-50' : ''}`}
							>
								<input
									type="radio"
									name="picked"
									value={o.id}
									checked={picked === o.id}
									onChange={() => setPicked(o.id)}
								/>
								<div>
									<div className="font-medium text-zinc-800 dark:text-zinc-200">
										{o.label}
									</div>
									{o.sublabel && (
										<div className="text-xs text-zinc-500">{o.sublabel}</div>
									)}
								</div>
							</label>
						))}
					</fieldset>

					{supportsSplit && (
						<label
							className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 ${
								splitting
									? 'border-blue-400 bg-blue-50 dark:border-blue-600 dark:bg-blue-900/30'
									: 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800'
							}`}
						>
							<input
								type="checkbox"
								checked={splitting}
								onChange={(e) => setSplitting(e.currentTarget.checked)}
								disabled={pending}
							/>
							<div>
								<div className="font-medium text-zinc-800 dark:text-zinc-200">
									Split evenly across all {options.length} {splitWord}
								</div>
								<div className="text-xs text-zinc-500">
									Reverses the existing JE and reposts it with one 710 line per{' '}
									{titleWord}.
								</div>
							</div>
						</label>
					)}

					{error && (
						<div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">
							{error}
						</div>
					)}
				</div>

				<div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
					<button
						type="button"
						onClick={onClose}
						disabled={pending}
						className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={submit}
						disabled={pending}
						className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
					>
						{pending
							? 'Applying…'
							: splitting
								? `Split across ${options.length}`
								: `Assign ${titleWord}`}
					</button>
				</div>
			</div>
		</div>
	);
}
