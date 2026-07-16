'use client';

import { useRef, useState, useTransition } from 'react';
import { manualLinkReceiptToTransaction } from '@/app/(app)/receipts/_actions/manualLinkReceiptToTransaction';

interface Props {
	/** Source transaction the receipt should link to. Null when the JE
	 *  isn't transaction-sourced (e.g. manual JE); button still renders
	 *  but is disabled with a tooltip explanation. */
	transactionId: string | null;
}

/**
 * Inline "Add Receipt" affordance for the TRUST_NO_RECEIPT_POSSIBLE_
 * DISTRIBUTION finding. Picks a file from disk, uploads via the existing
 * /api/receipts/upload route, then auto-links the resulting receipt to
 * this transaction via manualLinkReceiptToTransaction. The link triggers
 * a path revalidate so the finding clears on the next render.
 *
 * Single-file flow; for multi-file or batch the user should use the
 * full receipts page.
 */
export function AddReceiptButton({ transactionId }: Props) {
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);

	const onClick = () => {
		if (!transactionId) return;
		setError(null);
		setSuccess(false);
		inputRef.current?.click();
	};

	const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		// Clear the input value so picking the same file twice re-fires.
		if (inputRef.current) inputRef.current.value = '';
		if (!file || !transactionId) return;

		startTransition(async () => {
			try {
				const form = new FormData();
				form.set('file', file);
				const res = await fetch('/api/receipts/upload', {
					method: 'POST',
					body: form,
				});
				const json = (await res.json()) as { receiptId?: string; error?: string };
				if (!res.ok || !json.receiptId) {
					setError(json.error ?? `Upload failed (${res.status})`);
					return;
				}
				const linkResult = await manualLinkReceiptToTransaction(
					json.receiptId,
					transactionId,
				);
				if (linkResult?.error) {
					setError(linkResult.error);
					return;
				}
				setSuccess(true);
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Unexpected error');
			}
		});
	};

	const disabled = !transactionId || pending;
	const title = pending
		? 'Uploading receipt…'
		: success
			? 'Receipt added'
			: !transactionId
				? "This JE isn't from a Plaid/manual transaction — open the JE to attach a receipt there."
				: 'Add receipt';

	// Sky blue normally, emerald on success, dimmed when disabled. Hover
	// fills the icon background.
	const colorCls = success
		? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50'
		: 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-900/30 dark:text-sky-300 dark:hover:bg-sky-900/50';

	return (
		<>
			<button
				type="button"
				onClick={onClick}
				disabled={disabled}
				title={title}
				aria-label={title}
				className={`inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${colorCls}`}
			>
				{pending ? (
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin" aria-hidden="true">
						<path d="M21 12a9 9 0 11-6.219-8.56" />
					</svg>
				) : success ? (
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<polyline points="20 6 9 17 4 12" />
					</svg>
				) : (
					// Paperclip — "attach a receipt"
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
					</svg>
				)}
			</button>
			<input
				ref={inputRef}
				type="file"
				accept="image/*,application/pdf"
				className="hidden"
				onChange={onFileChange}
			/>
			{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
		</>
	);
}
