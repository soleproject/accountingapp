'use client';

import { useState, useTransition } from 'react';
import {
	classifyCapitalGain,
	type CapitalGainClassification,
} from '../_actions/classifyCapitalGain';

interface Props {
	findingId: string;
	/** True iff this org has a corpus equity account configured — gates the
	 *  long-term-corpus option since some orgs don't have the trust
	 *  instrument routing long-term gains to principal. */
	corpusAvailable: boolean;
}

/**
 * Three buttons per row on a CAPITAL_GAIN_NEEDS_HOLDING_PERIOD finding:
 *   ST  → confirm short-term (420)
 *   LT  → confirm long-term, distributable income (425)
 *   ↪ Corpus → reroute long-term to corpus equity per trust instrument
 */
export function ClassifyCapitalGainButtons({ findingId, corpusAvailable }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const submit = (decision: CapitalGainClassification) => {
		setError(null);
		startTransition(async () => {
			const r = await classifyCapitalGain({ findingId, decision });
			if (!r.ok) setError(r.error ?? 'Failed to classify');
		});
	};

	return (
		<div className="flex flex-col items-end gap-1">
			<div className="flex items-center gap-1">
				<TextButton
					onClick={() => submit('short_term')}
					disabled={pending}
					title="Short-term: held ≤ 1 year. Posts on 420; treated as ordinary income for DNI."
				>
					ST
				</TextButton>
				<TextButton
					onClick={() => submit('long_term_income')}
					disabled={pending}
					title="Long-term, income: held > 1 year, distributable. Posts on 425."
				>
					LT
				</TextButton>
				{corpusAvailable && (
					<TextButton
						onClick={() => submit('long_term_corpus')}
						disabled={pending}
						title="Long-term, to corpus: routes long-term gain to corpus equity per trust instrument."
					>
						↪ Corpus
					</TextButton>
				)}
			</div>
			{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
		</div>
	);
}

function TextButton({
	children,
	...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			type="button"
			{...rest}
			className="rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
		>
			{children}
		</button>
	);
}
