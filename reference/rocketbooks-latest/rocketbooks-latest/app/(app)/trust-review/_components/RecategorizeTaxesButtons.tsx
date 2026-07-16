'use client';

import { useState, useTransition } from 'react';
import { recategorizeTaxes, type TaxTarget } from '../_actions/recategorizeTaxes';

interface Props {
	findingId: string;
	/** Detail type currently on the line, so we can show only the OTHER
	 *  destination as an actionable button (one-click flip). When unknown
	 *  (older metadata), show both. */
	currentDetailType?: string | null;
}

/**
 * One-click flip button(s) for TRUST_505_705_LIKELY_MISROUTED. Shows
 * only the button that represents the OTHER tax account so the action
 * is unambiguous; if we can't tell the current direction, shows both.
 */
export function RecategorizeTaxesButtons({ findingId, currentDetailType }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const submit = (target: TaxTarget) => {
		setError(null);
		startTransition(async () => {
			const r = await recategorizeTaxes({ findingId, target });
			if (!r.ok) setError(r.error ?? 'Failed to recategorize');
		});
	};

	const showFlipToNonProperty = currentDetailType !== 'trust_non_property_taxes';
	const showFlipToProperty = currentDetailType !== 'trust_property_taxes';

	return (
		<div className="flex flex-col items-end gap-1">
			<div className="flex items-center gap-1">
				{showFlipToProperty && (
					<TextButton
						onClick={() => submit('property')}
						disabled={pending}
						title="Move to 505 Property Taxes (real estate, parcel, land/building)"
					>
						→ 505
					</TextButton>
				)}
				{showFlipToNonProperty && (
					<TextButton
						onClick={() => submit('non_property')}
						disabled={pending}
						title="Move to 705 Non-Property Taxes (vehicle, sales, use, income)"
					>
						→ 705
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
