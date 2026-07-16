'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { updateAssetSettings } from '../_actions/updateAssetSettings';

interface Props {
	initial: {
		cronEnabled: boolean;
		defaultAutoDepreciate: boolean;
	};
}

/**
 * Per-org Assets settings card. Two toggles:
 *
 *   Auto-depreciate cron — when on, the monthly Inngest cron posts
 *                          depreciation for this org against assets
 *                          flagged auto_depreciate. Off by default.
 *   Default new assets to auto — convenience initial value for the
 *                                per-asset toggle on create.
 *
 * Saves on click for each toggle so there's no Save-button friction —
 * the values are advisory + per-asset toggles still win at run time.
 */
export function AssetSettingsCard({ initial }: Props) {
	const [cronEnabled, setCronEnabled] = useState(initial.cronEnabled);
	const [defaultAutoDepreciate, setDefaultAutoDepreciate] = useState(initial.defaultAutoDepreciate);
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const router = useRouter();

	const save = (next: { cronEnabled: boolean; defaultAutoDepreciate: boolean }) => {
		setError(null);
		startTransition(async () => {
			const r = await updateAssetSettings(next);
			if (!r.ok) {
				setError(r.error ?? 'Failed to save');
				// Roll back optimistic UI on failure.
				setCronEnabled(initial.cronEnabled);
				setDefaultAutoDepreciate(initial.defaultAutoDepreciate);
				return;
			}
			router.refresh();
		});
	};

	const onCronChange = (v: boolean) => {
		setCronEnabled(v);
		save({ cronEnabled: v, defaultAutoDepreciate });
	};
	const onDefaultChange = (v: boolean) => {
		setDefaultAutoDepreciate(v);
		save({ cronEnabled, defaultAutoDepreciate: v });
	};

	return (
		<div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
			<div className="mb-3 flex items-center justify-between">
				<div className="text-sm font-medium uppercase tracking-wide text-zinc-500">
					Depreciation settings
				</div>
				{pending && <span className="text-xs text-zinc-400">Saving…</span>}
			</div>
			<div className="flex flex-col gap-2 text-sm">
				<label className="flex cursor-pointer items-start gap-2">
					<input
						type="checkbox"
						checked={cronEnabled}
						onChange={(e) => onCronChange(e.currentTarget.checked)}
						disabled={pending}
						className="mt-1"
					/>
					<div>
						<div className="font-medium text-zinc-800 dark:text-zinc-200">
							Run depreciation automatically each month
						</div>
						<div className="text-xs text-zinc-500">
							Posts on the 1st of each month for the prior calendar month.
							Only touches assets flagged Auto-depreciate.
						</div>
					</div>
				</label>
				<label className="flex cursor-pointer items-start gap-2">
					<input
						type="checkbox"
						checked={defaultAutoDepreciate}
						onChange={(e) => onDefaultChange(e.currentTarget.checked)}
						disabled={pending}
						className="mt-1"
					/>
					<div>
						<div className="font-medium text-zinc-800 dark:text-zinc-200">
							Auto-flag new assets
						</div>
						<div className="text-xs text-zinc-500">
							Default the per-asset Auto-depreciate toggle to on for new
							assets you register. Per-asset toggle still wins.
						</div>
					</div>
				</label>
			</div>
			{error && (
				<div className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</div>
			)}
		</div>
	);
}
