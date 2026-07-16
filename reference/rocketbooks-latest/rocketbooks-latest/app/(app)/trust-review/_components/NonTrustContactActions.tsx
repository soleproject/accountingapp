'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { bulkRecategorizeNonTrust } from '../_actions/bulkRecategorizeNonTrust';
import { confirmFindingAsIs } from '../_actions/confirmFindingAsIs';
import type { AccountPick } from './RecategorizeNonTrustButton';

interface Props {
	contactId?: string;
	contactName: string;
	findingIds: string[];
	allAccounts: readonly AccountPick[];
	onPendingChange?: (pending: boolean) => void;
	muted?: boolean;
}

const ICON_BASE = 'inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const ZINC_F = 'border-zinc-400 bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700';
const ZINC_M = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-500';
const INDIGO_F = 'border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300 dark:hover:bg-indigo-900/50';
const INDIGO_M = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 dark:border-zinc-700 dark:text-zinc-500';

/**
 * Per-contact actions for TRUST_NON_TRUST_CATEGORY_USED.
 *
 *   🛡️ Keep on Non-Trust  → drops TRUST_NON_TRUST_KEPT + dismisses (no GL)
 *   🏛️ Pick Trust CoA     → opens picker, on pick runs bulkRecategorizeNonTrust
 */
export function NonTrustContactActions({
	contactName, findingIds, allAccounts, onPendingChange, muted = false,
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
	const runKeep = () => {
		setError(null);
		startTransition(async () => {
			const r = await confirmFindingAsIs({
				findingIds,
				applicableCodes: ['TRUST_NON_TRUST_CATEGORY_USED'],
				auditCode: 'TRUST_NON_TRUST_KEPT',
				auditMessage: `Non-trust account confirmed appropriate for ${contactName} — no reclassification.`,
			});
			if (!r.ok) setError(r.error ?? `${r.processed} ok, ${r.failed.length} failed`);
		});
	};
	const runReclassify = (id: string) => {
		setError(null); setPickerOpen(false);
		startTransition(async () => {
			const r = await bulkRecategorizeNonTrust({ findingIds, targetAccountId: id });
			if (!r.ok) setError(r.error ?? `${r.processed} ok, ${r.failed.length} failed`);
		});
	};

	return (
		<div className="flex items-center gap-2">
			<button type="button" onClick={runKeep} disabled={disabled}
				title={`Keep all ${findingIds.length} on the non-trust account (no change)`}
				className={`${ICON_BASE} ${muted ? ZINC_M : ZINC_F}`}>
				<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
				</svg>
			</button>

			<div ref={pickRef} className="relative">
				<button type="button" onClick={() => setPickerOpen((v) => !v)} disabled={disabled}
					title={`Reclassify all ${findingIds.length} to a trust account`}
					className={`${ICON_BASE} ${muted ? INDIGO_M : INDIGO_F}`}>
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M3 21h18" /><path d="M5 21V8l7-5 7 5v13" /><path d="M9 21v-6h6v6" />
					</svg>
				</button>
				{pickerOpen && (
					<div className="absolute right-0 z-20 mt-1 w-64 max-h-72 overflow-y-auto rounded-md border border-zinc-200 bg-white p-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
						{allAccounts.map((a) => (
							<button key={a.id} type="button" onClick={() => runReclassify(a.id)} className="block w-full px-3 py-1 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">
								<span className="font-mono">{a.accountNumber}</span> {a.accountName}
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
