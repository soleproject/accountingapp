'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { acknowledge455K1 } from '../_actions/acknowledge455K1';
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
const ORANGE_F = 'border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-800 dark:bg-orange-900/30 dark:text-orange-300 dark:hover:bg-orange-900/50';
const ORANGE_M = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 dark:border-zinc-700 dark:text-zinc-500';
const EMERALD_F = 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50';
const EMERALD_M = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 dark:border-zinc-700 dark:text-zinc-500';

/**
 * Per-contact actions for TRUST_455_FLAG_K1_ISSUANCE. Two-icon set —
 * there's no entity to pick (source K-1 forms aren't tracked yet), so
 * the warning is just "do you have the K-1 on file?":
 *
 *   ⊘ Not K-1 Income → Other → CoA picker
 *   ✓ Acknowledge   → drops TRUST_455_K1_ACKNOWLEDGED, dismisses
 */
export function K1Income455ContactActions({
	contactName, findingIds, allAccounts, onPendingChange, muted = false,
}: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [notOpen, setNotOpen] = useState(false);
	const [otherCoaOpen, setOtherCoaOpen] = useState(false);
	const notRef = useRef<HTMLDivElement>(null);

	useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);
	useEffect(() => {
		if (!notOpen) return;
		const h = (e: MouseEvent) => {
			const t = e.target as Node | null;
			if (notRef.current && t && !notRef.current.contains(t)) { setNotOpen(false); setOtherCoaOpen(false); }
		};
		window.addEventListener('mousedown', h);
		return () => window.removeEventListener('mousedown', h);
	}, [notOpen]);

	const disabled = pending || findingIds.length === 0;
	const runOther = (id: string) => {
		setError(null); setNotOpen(false); setOtherCoaOpen(false);
		startTransition(async () => {
			const r = await recategorizeFindingToAccount({
				findingIds, targetAccountId: id,
				applicableCodes: ['TRUST_455_FLAG_K1_ISSUANCE'],
				sourceLine: { kind: 'metadata_account_id' },
				auditVerb: 'K-1 income',
			});
			if (!r.ok) setError(r.error ?? `${r.processed} ok, ${r.failed.length} failed`);
		});
	};
	const runAck = () => {
		setError(null);
		startTransition(async () => {
			const r = await acknowledge455K1({ findingIds });
			if (!r.ok) setError(r.error ?? `${r.processed} ok, ${r.failed.length} failed`);
		});
	};

	return (
		<div className="flex items-center gap-2">
			<div ref={notRef} className="relative">
				<button type="button" onClick={() => setNotOpen((v) => !v)} disabled={disabled}
					title={`Not K-1 income — recategorize all ${findingIds.length} for ${contactName}`}
					className={`${ICON_BASE} ${muted ? ORANGE_M : ORANGE_F}`}>
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

			<button type="button" onClick={runAck} disabled={disabled}
				title={`Acknowledge K-1 source on file for all ${findingIds.length}`}
				className={`${ICON_BASE} ${muted ? EMERALD_M : EMERALD_F}`}>
				{pending ? (
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin" aria-hidden="true">
						<path d="M21 12a9 9 0 11-6.219-8.56" />
					</svg>
				) : (
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<polyline points="20 6 9 17 4 12" />
					</svg>
				)}
			</button>

			{error && <span className="text-xs text-red-600" title={error}>{error.length > 40 ? error.slice(0, 40) + '…' : error}</span>}
		</div>
	);
}
