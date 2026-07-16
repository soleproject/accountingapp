'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { bulkReclassifyAsset } from '../_actions/bulkReclassifyAsset';
import { confirmFindingAsIs } from '../_actions/confirmFindingAsIs';
import type { AccountPick } from './RecategorizeNonTrustButton';
import type { ExpenseAccountPick } from './ReclassifyAssetButton';

interface Props {
	contactId?: string;
	contactName: string;
	findingIds: string[];
	expenseAccounts: readonly ExpenseAccountPick[];
	allAccounts: readonly AccountPick[];
	onPendingChange?: (pending: boolean) => void;
	muted?: boolean;
}

const ICON_BASE = 'inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const ZINC_F = 'border-zinc-400 bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700';
const ZINC_M = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-500';
const AMBER_F = 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300 dark:hover:bg-amber-900/50';
const AMBER_M = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700 dark:border-zinc-700 dark:text-zinc-500';

/**
 * Per-contact actions for TRUST_ASSET_REPOST_REVIEW.
 *
 *   🛡️ Confirm Genuine Purchase → audit + dismiss (no GL)
 *   🛠️ Pick & Reclassify       → opens expense-account picker, on pick
 *                                  loops bulkReclassifyAsset
 */
export function AssetRepostContactActions({
	contactName, findingIds, expenseAccounts, onPendingChange, muted = false,
}: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const pickRef = useRef<HTMLDivElement>(null);

	useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);
	useEffect(() => {
		if (!pickerOpen) return;
		const h = (e: MouseEvent) => {
			const t = e.target as Node | null;
			if (pickRef.current && t && !pickRef.current.contains(t)) setPickerOpen(false);
		};
		window.addEventListener('mousedown', h);
		return () => window.removeEventListener('mousedown', h);
	}, [pickerOpen]);

	const disabled = pending || findingIds.length === 0;
	const runConfirm = () => {
		setError(null);
		startTransition(async () => {
			const r = await confirmFindingAsIs({
				findingIds,
				applicableCodes: ['TRUST_ASSET_REPOST_REVIEW'],
				auditCode: 'TRUST_ASSET_PURCHASE_CONFIRMED',
				auditMessage: 'Confirmed as a genuine asset purchase (not maintenance / repairs).',
			});
			if (!r.ok) setError(r.error ?? `${r.processed} ok, ${r.failed.length} failed`);
		});
	};
	const runReclassify = (expenseAccountId: string) => {
		setError(null); setPickerOpen(false);
		startTransition(async () => {
			const r = await bulkReclassifyAsset({ findingIds, expenseAccountId });
			if (!r.ok) setError(r.error ?? `${r.processed} ok, ${r.failed.length} failed`);
		});
	};

	return (
		<div className="flex items-center gap-2">
			<button type="button" onClick={runConfirm} disabled={disabled}
				title={`Confirm all ${findingIds.length} as genuine asset purchases for ${contactName}`}
				className={`${ICON_BASE} ${muted ? ZINC_M : ZINC_F}`}>
				<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
				</svg>
			</button>

			<div ref={pickRef} className="relative">
				<button type="button" onClick={() => setPickerOpen((v) => !v)} disabled={disabled}
					title={`Reclassify all ${findingIds.length} off the asset account to an expense account`}
					className={`${ICON_BASE} ${muted ? AMBER_M : AMBER_F}`}>
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
					</svg>
				</button>
				{pickerOpen && (
					<div className="absolute right-0 z-20 mt-1 w-64 max-h-72 overflow-y-auto rounded-md border border-zinc-200 bg-white p-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
						{expenseAccounts.map((a) => (
							<button key={a.id} type="button" onClick={() => runReclassify(a.id)} className="block w-full px-3 py-1 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">
								{a.accountNumber && <span className="font-mono">{a.accountNumber} </span>}{a.accountName}
							</button>
						))}
					</div>
				)}
			</div>

			{pending && (
				<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin text-zinc-500" aria-hidden="true">
					<path d="M21 12a9 9 0 11-6.219-8.56" />
				</svg>
			)}
			{error && <span className="text-xs text-red-600" title={error}>{error.length > 40 ? error.slice(0, 40) + '…' : error}</span>}
		</div>
	);
}
