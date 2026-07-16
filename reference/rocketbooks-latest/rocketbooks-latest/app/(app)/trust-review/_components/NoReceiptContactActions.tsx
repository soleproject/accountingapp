'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { bulkRerouteNoReceipt } from '../_actions/bulkRerouteNoReceipt';
import { recategorizeFindingToAccount } from '../_actions/recategorizeFindingToAccount';
import type { AccountPick } from './RecategorizeNonTrustButton';
import type { BeneficiaryPick } from './AssignBeneficiaryButton';

interface Props {
	contactId?: string;
	contactName: string;
	findingIds: string[];
	beneficiaries: readonly BeneficiaryPick[];
	allAccounts: readonly AccountPick[];
	/** Per-row only: the source-transaction id, needed to wire "Add
	 *  Receipt" into the existing upload modal. Null in bulk mode. */
	transactionId?: string | null;
	onPendingChange?: (pending: boolean) => void;
	muted?: boolean;
}

const ICON_BASE = 'inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const ORANGE_F = 'border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-800 dark:bg-orange-900/30 dark:text-orange-300 dark:hover:bg-orange-900/50';
const ORANGE_M = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 dark:border-zinc-700 dark:text-zinc-500';
const SKY_F = 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-900/30 dark:text-sky-300 dark:hover:bg-sky-900/50';
const SKY_M = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700 dark:border-zinc-700 dark:text-zinc-500';
const VIOLET_F = 'border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-900/30 dark:text-violet-300 dark:hover:bg-violet-900/50';
const VIOLET_M = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700 dark:border-zinc-700 dark:text-zinc-500';

/**
 * Per-contact actions for TRUST_NO_RECEIPT_POSSIBLE_DISTRIBUTION.
 *
 *   ⊘ Not a Distribution    → Other → CoA picker
 *   📎 Add Receipt          → per-row only: Link to /transactions/[id]/edit
 *                              (the existing receipt-upload flow)
 *   💸 Reroute to Demand Note → bene picker → bulkRerouteNoReceipt
 *
 * Both 📎 and 💸 are self-completing commits; no separate Approve.
 */
export function NoReceiptContactActions({
	contactName, findingIds, beneficiaries, allAccounts, transactionId,
	onPendingChange, muted = false,
}: Props) {
	const [pickedBeneId, setPickedBeneId] = useState<string>('');
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
				applicableCodes: ['TRUST_NO_RECEIPT_POSSIBLE_DISTRIBUTION'],
				sourceLine: { kind: 'metadata_account_id' },
				auditVerb: 'a withdrawal',
			});
			if (!r.ok) setError(r.error ?? `${r.processed} ok, ${r.failed.length} failed`);
		});
	};
	const runReroute = (beneId: string) => {
		setError(null); setPickOpen(false);
		startTransition(async () => {
			const r = await bulkRerouteNoReceipt({ findingIds, beneficiaryId: beneId });
			if (!r.ok) setError(r.error ?? `${r.processed} ok, ${r.failed.length} failed`);
		});
	};

	return (
		<div className="flex items-center gap-2">
			<div ref={notRef} className="relative">
				<button type="button" onClick={() => { setNotOpen((v) => !v); setPickOpen(false); }} disabled={disabled}
					title={`Not a distribution — recategorize all ${findingIds.length} for ${contactName}`}
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

			{transactionId && findingIds.length === 1 && (
				<Link href={`/transactions/${transactionId}`}
					title="Open transaction to attach a receipt"
					className={`${ICON_BASE} ${muted ? SKY_M : SKY_F}`}>
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
					</svg>
				</Link>
			)}

			<div ref={pickRef} className="relative">
				<button type="button" onClick={() => { setPickOpen((v) => !v); setNotOpen(false); }} disabled={disabled || beneficiaries.length === 0}
					title={beneficiaries.length === 0 ? 'No beneficiaries on file' : 'Reroute to a beneficiary\'s demand note'}
					className={`${ICON_BASE} ${muted ? VIOLET_M : VIOLET_F}`}>
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<rect x="2" y="6" width="20" height="12" rx="2" /><line x1="2" y1="10" x2="22" y2="10" />
					</svg>
				</button>
				{pickOpen && (
					<div className="absolute right-0 z-20 mt-1 w-72 max-h-72 overflow-y-auto rounded-md border border-zinc-200 bg-white p-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
						{beneficiaries.map((b) => (
							<button key={b.id} type="button" onClick={() => { setPickedBeneId(b.id); runReroute(b.id); }}
								className={`block w-full rounded-md px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 ${b.id === pickedBeneId ? 'bg-violet-50' : ''}`}>
								<div className="font-medium">{b.fullName}</div>
								<div className="text-xs text-zinc-500">{b.ageNote}</div>
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
