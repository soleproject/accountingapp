'use client';

import { useEffect, useState, useTransition } from 'react';
import { confirmFindingAsIs } from '../_actions/confirmFindingAsIs';
import type { TrustFindingCode } from '@/lib/accounting/rules/beneficial-trust/types';

interface Props {
	contactId?: string;
	contactName: string;
	findingIds: string[];
	onPendingChange?: (pending: boolean) => void;
	muted?: boolean;
}

const ICON_BASE = 'inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const ZINC_F = 'border-zinc-400 bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700';
const ZINC_M = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-500';
const SKY_F = 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-900/30 dark:text-sky-300 dark:hover:bg-sky-900/50';
const SKY_M = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700 dark:border-zinc-700 dark:text-zinc-500';
const INDIGO_F = 'border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300 dark:hover:bg-indigo-900/50';
const INDIGO_M = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 dark:border-zinc-700 dark:text-zinc-500';

/**
 * Per-contact actions for TRUST_DISPOSAL_WITH_OUTSTANDING_LOAN. Three
 * one-click resolutions, all of which record the external resolution
 * via audit + dismiss. The actual loan management happens on /loans.
 *
 *   🏦 Buyer Assumed     → TRUST_DISPOSAL_LOAN_ASSUMED_BY_BUYER
 *   💰 Paid from Proceeds → TRUST_DISPOSAL_LOAN_PAID_FROM_PROCEEDS
 *   🔄 Loan Reassigned    → TRUST_DISPOSAL_LOAN_REASSIGNED
 */
export function DisposalLoanContactActions({
	contactName, findingIds, onPendingChange, muted = false,
}: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);

	const disabled = pending || findingIds.length === 0;
	const runConfirm = (auditCode: TrustFindingCode, msg: string) => {
		setError(null);
		startTransition(async () => {
			const r = await confirmFindingAsIs({
				findingIds,
				applicableCodes: ['TRUST_DISPOSAL_WITH_OUTSTANDING_LOAN'],
				auditCode,
				auditMessage: msg,
			});
			if (!r.ok) setError(r.error ?? `${r.processed} ok, ${r.failed.length} failed`);
		});
	};

	return (
		<div className="flex items-center gap-2">
			<button type="button" disabled={disabled}
				onClick={() => runConfirm('TRUST_DISPOSAL_LOAN_ASSUMED_BY_BUYER', `Buyer assumed the outstanding loan on disposal for ${contactName}.`)}
				title="Buyer assumed the outstanding loan"
				className={`${ICON_BASE} ${muted ? ZINC_M : ZINC_F}`}>
				<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<path d="M3 21h18" /><path d="M3 10h18" /><path d="M5 10v11" /><path d="M19 10v11" /><path d="M12 3L3 10h18l-9-7z" />
				</svg>
			</button>

			<button type="button" disabled={disabled}
				onClick={() => runConfirm('TRUST_DISPOSAL_LOAN_PAID_FROM_PROCEEDS', `Loan paid off from disposal proceeds for ${contactName}.`)}
				title="Loan paid off from disposal proceeds"
				className={`${ICON_BASE} ${muted ? SKY_M : SKY_F}`}>
				<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
				</svg>
			</button>

			<button type="button" disabled={disabled}
				onClick={() => runConfirm('TRUST_DISPOSAL_LOAN_REASSIGNED', `Loan reassigned to a different fixed asset for ${contactName}.`)}
				title="Loan reassigned to a different fixed asset"
				className={`${ICON_BASE} ${muted ? INDIGO_M : INDIGO_F}`}>
				<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
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
