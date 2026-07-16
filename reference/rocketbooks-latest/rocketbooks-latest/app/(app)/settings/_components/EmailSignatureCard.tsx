'use client';

import { useState, useTransition } from 'react';
import { setEmailSignatureAction } from '../_actions/emailSignature';

const MAX_CHARS = 1000;

const PLACEHOLDER = `Jane Doe
Managing Member, RocketBooks
(555) 123-4567`;

/**
 * Per-user email signature appended to the bottom of every email reply sent
 * from the Inbox. Explicit Save button (not live-saved) — same pattern as the
 * AI voice card; free text shouldn't write on every keystroke.
 */
interface Props {
	initial: string | null;
}

export function EmailSignatureCard({ initial }: Props) {
	const [value, setValue] = useState<string>(initial ?? '');
	const [savedValue, setSavedValue] = useState<string>(initial ?? '');
	const [error, setError] = useState<string | null>(null);
	const [okFlash, setOkFlash] = useState<boolean>(false);
	const [isPending, startTransition] = useTransition();

	const len = value.length;
	const overCap = len > MAX_CHARS;
	const dirty = value !== savedValue;

	const handleSave = () => {
		setError(null);
		setOkFlash(false);
		if (overCap) {
			setError(`Signature is too long (${len} / ${MAX_CHARS})`);
			return;
		}
		startTransition(async () => {
			const r = await setEmailSignatureAction({ value });
			if (!r.ok) {
				setError(r.error ?? 'Save failed');
				return;
			}
			setSavedValue(value);
			setOkFlash(true);
			setTimeout(() => setOkFlash(false), 1500);
		});
	};

	return (
		<section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
			<header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
				<h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Email signature</h2>
			</header>
			<div className="flex flex-col gap-3 px-4 py-3 text-sm">
				<div className="text-xs text-zinc-500">
					Added to the bottom of every email reply you send from the Inbox. Leave blank for none.
				</div>
				<textarea
					value={value}
					onChange={(e) => setValue(e.target.value)}
					rows={5}
					placeholder={PLACEHOLDER}
					disabled={isPending}
					className="w-full resize-y rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm leading-relaxed focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950"
				/>
				<div className="flex items-center justify-between text-xs">
					<span className={overCap ? 'text-red-600 dark:text-red-400' : 'text-zinc-500'}>
						{len} / {MAX_CHARS}
					</span>
					<div className="flex items-center gap-2">
						{okFlash && <span className="text-emerald-600 dark:text-emerald-400">Saved</span>}
						<button
							type="button"
							onClick={handleSave}
							disabled={isPending || !dirty || overCap}
							className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{isPending ? 'Saving…' : 'Save'}
						</button>
					</div>
				</div>
				{error && (
					<div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
						{error}
					</div>
				)}
			</div>
		</section>
	);
}
