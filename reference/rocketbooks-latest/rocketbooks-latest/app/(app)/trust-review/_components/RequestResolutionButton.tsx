'use client';

import { useState, useTransition } from 'react';
import {
	requestTrusteeResolution,
	type TrustDocumentType,
} from '../_actions/requestTrusteeResolution';

interface Props {
	findingId: string;
	documentType: TrustDocumentType;
	label?: string;
}

/**
 * Hand-off button — moves a Trust Review finding into the Trust
 * Documentation queue. The trust-docs module's worker (Phase 1+) picks
 * up TRUST_DOCUMENTATION_REQUESTED rows and generates the template.
 *
 * Used on findings where the resolution requires a document that
 * trust-docs is responsible for (Personal-Use Lease Agreement, mileage
 * log, etc.). The button just enqueues — actual doc generation happens
 * out of band.
 */
export function RequestResolutionButton({ findingId, documentType, label }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const submit = () => {
		setError(null);
		startTransition(async () => {
			const r = await requestTrusteeResolution({ findingId, documentType });
			if (!r.ok) setError(r.error ?? 'Failed to request');
		});
	};

	const buttonLabel = label ?? '📄 Request resolution';

	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				onClick={submit}
				disabled={pending}
				title="Send this to Trust Documentation to generate the required resolution / template"
				className="flex h-7 items-center justify-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
			>
				{pending ? '…' : buttonLabel}
			</button>
			{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
		</div>
	);
}
