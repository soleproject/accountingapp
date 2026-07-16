'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { bulkReclassify450 } from '../_actions/bulkReclassify450';
import { recategorizeFindingToAccount } from '../_actions/recategorizeFindingToAccount';
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
const ICON_ORANGE_FULL = 'border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-800 dark:bg-orange-900/30 dark:text-orange-300 dark:hover:bg-orange-900/50';
const ICON_ORANGE_MUTED = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 dark:border-zinc-700 dark:text-zinc-500';
const ICON_BLUE_FULL = 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50';
const ICON_BLUE_MUTED = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 dark:border-zinc-700 dark:text-zinc-500';

/**
 * Per-contact actions for TRUST_450_BUSINESS_INCOME_BLOCKED.
 *
 *   ⊘ Not Business Income — Other → CoA picker
 *   📋 Reclassify to 455   — one-click reverse + repost on 455 K-1
 *
 * No separate Approve; no Pick (no entity to choose) — the reclassify
 * destination is fixed at 455.
 */
export function BusinessIncomeContactActions({
	contactName,
	findingIds,
	allAccounts,
	onPendingChange,
	muted = false,
}: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [notOpen, setNotOpen] = useState(false);
	const [otherCoaOpen, setOtherCoaOpen] = useState(false);
	const notRef = useRef<HTMLDivElement>(null);

	useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);

	useEffect(() => {
		if (!notOpen) return;
		const handler = (e: MouseEvent) => {
			const t = e.target as Node | null;
			if (notRef.current && t && !notRef.current.contains(t)) {
				setNotOpen(false); setOtherCoaOpen(false);
			}
		};
		window.addEventListener('mousedown', handler);
		return () => window.removeEventListener('mousedown', handler);
	}, [notOpen]);

	const disabled = pending || findingIds.length === 0;

	const runOther = (targetAccountId: string) => {
		setError(null); setNotOpen(false); setOtherCoaOpen(false);
		startTransition(async () => {
			const r = await recategorizeFindingToAccount({
				findingIds,
				targetAccountId,
				applicableCodes: ['TRUST_450_BUSINESS_INCOME_BLOCKED'],
				sourceLine: { kind: 'metadata_account_id' },
				auditVerb: 'business income',
			});
			if (!r.ok) setError(r.error ?? `${r.processed} ok, ${r.failed.length} failed`);
		});
	};

	const runReclassify = () => {
		setError(null);
		startTransition(async () => {
			const r = await bulkReclassify450({ findingIds });
			if (!r.ok) setError(r.error ?? `${r.processed} ok, ${r.failed.length} failed`);
		});
	};

	return (
		<div className="flex items-center gap-2">
			<div ref={notRef} className="relative">
				<button type="button" onClick={() => setNotOpen((v) => !v)} disabled={disabled}
					title={`Not business income — recategorize all ${findingIds.length} for ${contactName}`}
					className={`${ICON_BASE} ${muted ? ICON_ORANGE_MUTED : ICON_ORANGE_FULL}`}>
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
					</svg>
				</button>
				{notOpen && (
					<div className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-zinc-200 bg-white p-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
						<div className="flex items-center gap-1 rounded-md px-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
							<button type="button" onClick={() => setOtherCoaOpen((v) => !v)} className="flex flex-1 items-center gap-1 px-2 py-1.5 text-left">
								<span>Other</span><span className="text-zinc-400">→</span>
							</button>
							<Link href="/chart-of-accounts/new" className="inline-flex h-6 w-6 items-center justify-center rounded border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
								<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
									<line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
								</svg>
							</Link>
						</div>
						{otherCoaOpen && (
							<div className="mt-1 max-h-72 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-800">
								{allAccounts.map((a) => (
									<button key={a.id} type="button" onClick={() => runOther(a.id)} className="block w-full px-3 py-1 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">
										<span className="font-mono">{a.accountNumber}</span> {a.accountName}
									</button>
								))}
							</div>
						)}
						<button type="button" onClick={() => { setNotOpen(false); setOtherCoaOpen(false); }} className="mt-1 block w-full rounded-md border-t border-zinc-200 px-3 py-1.5 text-left text-xs text-zinc-500 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800">
							✕ Close
						</button>
					</div>
				)}
			</div>

			<button type="button" onClick={runReclassify} disabled={disabled}
				title={`Reclassify all ${findingIds.length} to 455 K-1 income`}
				className={`${ICON_BASE} ${muted ? ICON_BLUE_MUTED : ICON_BLUE_FULL}`}>
				<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<rect x="4" y="3" width="16" height="18" rx="2" /><line x1="8" y1="9" x2="16" y2="9" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="12" y2="17" />
				</svg>
			</button>

			{pending && (
				<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin text-zinc-500" aria-hidden="true">
					<path d="M21 12a9 9 0 11-6.219-8.56" />
				</svg>
			)}
			{error && <span className="text-xs text-red-600" title={error}>{error.length > 40 ? error.slice(0, 40) + '…' : error}</span>}
		</div>
	);
}
