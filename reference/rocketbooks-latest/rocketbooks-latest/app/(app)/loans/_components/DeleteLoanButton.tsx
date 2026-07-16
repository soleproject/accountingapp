'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { deleteLoan } from '../_actions/deleteLoan';

interface Props {
	loanId: string;
	loanName: string;
}

/**
 * Confirm-then-delete button for the loan detail page header. Only
 * rendered when postedCount === 0 (the server action also enforces
 * that — this is a UX guard, not a security one).
 */
export function DeleteLoanButton({ loanId, loanName }: Props) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const onClick = () => {
		const ok = window.confirm(
			`Delete "${loanName}"? Its amortization schedule will also be deleted. This cannot be undone.`,
		);
		if (!ok) return;
		setError(null);
		startTransition(async () => {
			const r = await deleteLoan({ loanId });
			if (!r.ok) {
				setError(r.error ?? 'Delete failed');
				return;
			}
			router.push('/loans');
		});
	};

	return (
		<>
			<button
				type="button"
				onClick={onClick}
				disabled={pending}
				className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-950/30"
			>
				{pending ? 'Deleting…' : 'Delete'}
			</button>
			{error && (
				<span className="text-xs text-red-600 dark:text-red-400">{error}</span>
			)}
		</>
	);
}
