'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { deleteDocument } from '../_actions/deleteDocument';

interface Props {
	documentRecordId: string;
	signedCount: number;
}

/**
 * Small "Delete" link for the documents-index table row, next to the
 * Open button. Same confirm semantics as DocumentActions on the
 * detail page.
 */
export function InlineDeleteButton({ documentRecordId, signedCount }: Props) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const onDelete = () => {
		const message = signedCount > 0
			? `Delete this document? ${signedCount} signature${signedCount === 1 ? '' : 's'} on file will be permanently removed along with the PDF and audit trail.`
			: 'Delete this draft? PDF + audit trail will be permanently removed.';
		if (!confirm(message)) return;
		setError(null);
		startTransition(async () => {
			const r = await deleteDocument({ documentRecordId });
			if (!r.ok) {
				setError(r.error ?? 'Delete failed');
				return;
			}
			router.refresh();
		});
	};

	return (
		<>
			<button
				type="button"
				onClick={onDelete}
				disabled={pending}
				className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-xs text-rose-700 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800 dark:bg-rose-900/30 dark:text-rose-300 dark:hover:bg-rose-900/50"
			>
				{pending ? 'Deleting…' : 'Delete'}
			</button>
			{error && <span className="ml-2 text-xs text-red-600 dark:text-red-400">{error}</span>}
		</>
	);
}
