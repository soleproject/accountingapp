'use client';

import { useEffect, useState, useTransition } from 'react';
import { bulkRecategorizeTaxes } from '../_actions/bulkRecategorizeTaxes';
import type { TaxTarget } from '../_actions/recategorizeTaxes';

interface Props {
	findingIds: string[];
	onComplete?: (processed: number) => void;
	onPendingChange?: (pending: boolean) => void;
}

export function BulkRecategorizeTaxesButton({ findingIds, onComplete, onPendingChange }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	useEffect(() => onPendingChange?.(pending), [pending, onPendingChange]);

	const submit = (target: TaxTarget) => {
		setError(null);
		startTransition(async () => {
			const r = await bulkRecategorizeTaxes({ findingIds, target });
			if (!r.ok && r.failed.length === 0) {
				setError(r.error ?? 'Failed');
				return;
			}
			if (r.failed.length > 0) setError(`${r.processed} ok, ${r.failed.length} failed`);
			onComplete?.(r.processed);
		});
	};

	return (
		<>
			<button
				type="button"
				onClick={() => submit('property')}
				disabled={pending}
				className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
			>
				→ 505 ({findingIds.length})
			</button>
			<button
				type="button"
				onClick={() => submit('non_property')}
				disabled={pending}
				className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
			>
				→ 705 ({findingIds.length})
			</button>
			{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
		</>
	);
}
