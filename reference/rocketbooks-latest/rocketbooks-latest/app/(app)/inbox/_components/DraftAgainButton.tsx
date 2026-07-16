'use client';

import { useTransition, useState } from 'react';
import { regenerateDraftAction } from '../_actions/regenerateDraft';

/**
 * "Draft a reply anyway" button surfaced on messages the noise
 * classifier skipped, or that failed earlier. Calls the same
 * regenerate action which will (a) re-run the AI and (b) flip
 * ai_status to 'drafted' on success.
 */
interface Props {
	messageId: string;
	label?: string;
}

export function DraftAgainButton({ messageId, label = 'Draft a reply anyway' }: Props) {
	const [isPending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const handle = () => {
		setError(null);
		startTransition(async () => {
			const r = await regenerateDraftAction({ messageId });
			if (!r.ok) setError(r.error ?? 'Failed');
		});
	};

	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				onClick={handle}
				disabled={isPending}
				className="self-start rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
			>
				{isPending ? 'Drafting…' : label}
			</button>
			{error && <div className="text-xs text-red-700 dark:text-red-400">{error}</div>}
		</div>
	);
}
