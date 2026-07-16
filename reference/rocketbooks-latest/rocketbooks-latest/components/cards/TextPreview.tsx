'use client';

import Link from 'next/link';

export interface TextDraftView {
	id: string;
	contactId: string;
	contactName: string;
	contactPhone: string;
	fromPhone?: string | null;
	body: string;
	status: 'sent' | 'failed' | 'skipped' | string;
	segments?: number | null;
	sentAt: string;
	error?: string | null;
}

export function TextPreview({ draft, onClose }: { draft: TextDraftView; onClose?: () => void }) {
	const sent = draft.status === 'sent';
	const failed = draft.status === 'failed';
	const skipped = draft.status === 'skipped';

	const headerLabel = sent
		? '✓ Text sent'
		: failed
			? '✗ Send failed'
			: skipped
				? '◇ Not sent — Twilio off'
				: '◇ Text';

	const frameClass = sent
		? 'border-emerald-400 dark:border-emerald-700'
		: failed
			? 'border-rose-400 dark:border-rose-700'
			: 'border-amber-300 dark:border-amber-800';

	const headerBg = sent
		? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30'
		: failed
			? 'border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30'
			: 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30';

	return (
		<div className={`relative overflow-hidden rounded-lg border bg-white shadow-sm dark:bg-zinc-950 ${frameClass}`}>
			<div className={`flex items-center justify-between border-b px-5 py-3 ${headerBg}`}>
				<div>
					<div className="text-xs font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
						{headerLabel}
					</div>
					<div className="text-lg font-semibold">
						To {draft.contactName}
					</div>
				</div>
				<div className="flex items-start gap-3">
					<div className="text-right text-sm">
						<div className="text-zinc-500">Sent</div>
						<div className="tabular-nums">
							{new Date(draft.sentAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
						</div>
					</div>
					{onClose && <CloseButton onClose={onClose} />}
				</div>
			</div>

			<div className="border-b border-zinc-100 px-5 py-3 text-xs text-zinc-500 dark:border-zinc-800">
				<span className="tabular-nums">{draft.contactPhone}</span>
				{draft.segments && draft.segments > 1 ? (
					<span className="ml-3">· {draft.segments} segments</span>
				) : null}
			</div>

			<div className="px-5 py-4">
				<div className="flex justify-end">
					<div className="max-w-[80%] rounded-2xl bg-sky-600 px-3 py-2 text-sm text-white whitespace-pre-wrap">
						{draft.body}
					</div>
				</div>
			</div>

			{draft.error && (
				<div className="border-t border-rose-100 bg-rose-50/60 px-5 py-2 text-xs text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300">
					{draft.error}
				</div>
			)}

			<div className="flex items-center justify-end border-t border-zinc-100 bg-zinc-50/50 px-5 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-900/30">
				<Link
					href="/organizer/texts"
					className="font-medium text-sky-700 hover:text-sky-800 dark:text-sky-400 dark:hover:text-sky-300"
				>
					Open thread →
				</Link>
			</div>
		</div>
	);
}

function CloseButton({ onClose }: { onClose: () => void }) {
	return (
		<button
			type="button"
			onClick={onClose}
			aria-label="Dismiss"
			className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
		>
			<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
				<line x1="18" y1="6" x2="6" y2="18" />
				<line x1="6" y1="6" x2="18" y2="18" />
			</svg>
		</button>
	);
}
