'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { deleteDocument } from '../../_actions/deleteDocument';

interface Props {
	documentRecordId: string;
	/** True if any signer has signed. Drives whether the Edit affordance
	 *  is offered — signed docs can't be edited (would invalidate the
	 *  audit trail); the user has to delete + redraft. */
	canEdit: boolean;
	/** Surfaced on the delete confirm to make the consequences obvious
	 *  when a signed doc is being torn down. */
	signedCount: number;
}

/**
 * Header-row affordances for a document detail page: jump to the
 * edit form (when allowed) and delete (always, with a confirm whose
 * copy escalates when signatures exist).
 */
export function DocumentActions({ documentRecordId, canEdit, signedCount }: Props) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const onDelete = () => {
		const message = signedCount > 0
			? `Delete this document? ${signedCount} signature${signedCount === 1 ? '' : 's'} on file will be permanently removed along with the PDF and audit trail. This cannot be undone.`
			: 'Delete this draft? The PDF, version history, and audit trail will be permanently removed.';
		if (!confirm(message)) return;
		setError(null);
		startTransition(async () => {
			const r = await deleteDocument({ documentRecordId });
			if (!r.ok) {
				setError(r.error ?? 'Delete failed');
				return;
			}
			router.push('/trust-documents');
		});
	};

	return (
		<div className="flex items-center gap-2">
			{canEdit && (
				<Link
					href={`/trust-documents/${documentRecordId}/edit`}
					className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
				>
					Edit
				</Link>
			)}
			<button
				type="button"
				onClick={onDelete}
				disabled={pending}
				className="rounded-md border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800 dark:bg-rose-900/30 dark:text-rose-300 dark:hover:bg-rose-900/50"
			>
				{pending ? 'Deleting…' : 'Delete'}
			</button>
			{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
		</div>
	);
}
