'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { bulkLinkToProperty } from '../_actions/bulkLinkToProperty';
import { recategorizeFindingToAccount } from '../_actions/recategorizeFindingToAccount';
import type { AccountPick } from './RecategorizeNonTrustButton';
import type { RentalPropertyPick } from './LinkToPropertyButton';

interface Props {
	contactId?: string;
	contactName: string;
	findingIds: string[];
	rentalProperties: readonly RentalPropertyPick[];
	allAccounts: readonly AccountPick[];
	onPendingChange?: (pending: boolean) => void;
	muted?: boolean;
}

const ICON_BASE = 'inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const ORANGE_F = 'border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-800 dark:bg-orange-900/30 dark:text-orange-300 dark:hover:bg-orange-900/50';
const ORANGE_M = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 dark:border-zinc-700 dark:text-zinc-500';
const BLUE_F = 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50';
const BLUE_M = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 dark:border-zinc-700 dark:text-zinc-500';

/**
 * Per-contact actions for TRUST_DEFERRED_RENTAL_NET_NEEDED.
 *
 *   ⊘ Not Rental Income → Other → CoA picker
 *   🏠 Pick Property    → property dropdown + Link to /rental-properties
 *
 * Picking the property IS the commit (linkLineToProperty drops audit
 * and dismisses). No separate Approve.
 */
export function RentalPropertyContactActions({
	contactName, findingIds, rentalProperties, allAccounts, onPendingChange, muted = false,
}: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [notOpen, setNotOpen] = useState(false);
	const [otherCoaOpen, setOtherCoaOpen] = useState(false);
	const [pickOpen, setPickOpen] = useState(false);
	const notRef = useRef<HTMLDivElement>(null);
	const pickRef = useRef<HTMLDivElement>(null);

	useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);
	useEffect(() => {
		if (!notOpen && !pickOpen) return;
		const h = (e: MouseEvent) => {
			const t = e.target as Node | null;
			if (notOpen && notRef.current && t && !notRef.current.contains(t)) { setNotOpen(false); setOtherCoaOpen(false); }
			if (pickOpen && pickRef.current && t && !pickRef.current.contains(t)) setPickOpen(false);
		};
		window.addEventListener('mousedown', h);
		return () => window.removeEventListener('mousedown', h);
	}, [notOpen, pickOpen]);

	const disabled = pending || findingIds.length === 0;
	const runOther = (id: string) => {
		setError(null); setNotOpen(false); setOtherCoaOpen(false);
		startTransition(async () => {
			const r = await recategorizeFindingToAccount({
				findingIds, targetAccountId: id,
				applicableCodes: ['TRUST_DEFERRED_RENTAL_NET_NEEDED'],
				sourceLine: { kind: 'metadata_account_id' },
				auditVerb: 'rental income',
			});
			if (!r.ok) setError(r.error ?? `${r.processed} ok, ${r.failed.length} failed`);
		});
	};
	const runLink = (propertyId: string) => {
		setError(null); setPickOpen(false);
		startTransition(async () => {
			const r = await bulkLinkToProperty({ findingIds, rentalPropertyId: propertyId });
			if (!r.ok) setError(r.error ?? `${r.processed} ok, ${r.failed.length} failed`);
		});
	};

	return (
		<div className="flex items-center gap-2">
			<div ref={notRef} className="relative">
				<button type="button" onClick={() => { setNotOpen((v) => !v); setPickOpen(false); }} disabled={disabled}
					title={`Not rental income — recategorize all ${findingIds.length} for ${contactName}`}
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

			<div ref={pickRef} className="relative">
				<button type="button" onClick={() => { setPickOpen((v) => !v); setNotOpen(false); }} disabled={disabled || rentalProperties.length === 0}
					title={rentalProperties.length === 0 ? 'No rental properties on file' : 'Link rental income to a property'}
					className={`${ICON_BASE} ${muted ? BLUE_M : BLUE_F}`}>
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M3 12l9-9 9 9" /><path d="M5 10v10h14V10" />
					</svg>
				</button>
				{pickOpen && (
					<div className="absolute right-0 z-20 mt-1 w-72 rounded-md border border-zinc-200 bg-white p-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
						{rentalProperties.length === 0 && (
							<div className="px-3 py-2 text-xs text-zinc-500">
								No properties.{' '}
								<Link href="/rental-properties" className="text-blue-600 hover:underline">Add one →</Link>
							</div>
						)}
						{rentalProperties.map((p) => (
							<button key={p.id} type="button" onClick={() => runLink(p.id)}
								className="block w-full rounded-md px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800">
								<div className="font-medium">{p.displayName}</div>
							</button>
						))}
						<Link href="/rental-properties" className="block rounded-md border-t border-zinc-200 px-3 py-1.5 text-left text-xs text-blue-600 hover:bg-zinc-100 hover:underline dark:border-zinc-800 dark:hover:bg-zinc-800">
							+ Add new property
						</Link>
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
