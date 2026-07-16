'use client';

import { useState, useTransition } from 'react';
import { queueK1Draft } from '../_actions/queueK1Draft';

interface Props {
	findingId: string;
	/** Whether the finding has a beneficiaryId in metadata. If not, the
	 *  user needs to tag the bene on the 310 line first (via the Linkage
	 *  picker on the parallel finding). Button is disabled in that case. */
	hasBeneficiary: boolean;
}

/**
 * One-click "queue K-1" for TRUST_310_FLAG_K1_ISSUANCE. Minimal MVP —
 * just emits a TRUST_310_K1_QUEUED audit so the CPA can pick it up at
 * year-end. Full K-1 wizard (pre-filled form, PDF generation, e-file
 * routing) is a separate slice.
 */
export function QueueK1Button({ findingId, hasBeneficiary }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const submit = () => {
		setError(null);
		startTransition(async () => {
			const r = await queueK1Draft({ findingId });
			if (!r.ok) setError(r.error ?? 'Failed to queue');
		});
	};

	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				onClick={submit}
				disabled={pending || !hasBeneficiary}
				title={hasBeneficiary
					? 'Queue this distribution for K-1 issuance at year-end'
					: 'Tag the beneficiary on the 310 line first (use the Linkage picker on the parallel finding)'}
				className="flex h-7 items-center justify-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
			>
				📄 Queue K-1
			</button>
			{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
		</div>
	);
}
