'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import {
	classifyContactNotLoan,
	type NotLoanClassification,
} from '../_actions/classifyContactNotLoan';
import { approveContactLoanPayment } from '../_actions/approveContactLoanPayment';
import { createContactCreditCardSubAccount } from '../_actions/createContactCreditCardSubAccount';
import { createContactLeaseSubAccount } from '../_actions/createContactLeaseSubAccount';
import type { LoanPick } from './LinkPaymentToLoanButton';
import type { AccountPick } from './RecategorizeNonTrustButton';

export interface ContactLoanInfo {
	id: string;
	displayName: string;
}

interface Props {
	/** Source contact when scoped to a single sub-group / row. Omitted
	 *  when mounted in the selection toolbar (cross-contact). In bulk
	 *  mode the CC/Lease + Add-new-sub-account buttons hide (sub-account
	 *  names need a single contact); eye dropdowns still browse existing
	 *  accounts. */
	contactId?: string;
	contactName: string;
	/** Every open finding for this contact in the loan-payment group, OR
	 *  every selected finding when mounted in the toolbar. */
	findingIds: string[];
	/** All active loans on the org — drives the Yes-Loan picker. */
	allLoans: readonly LoanPick[];
	/** Loans already bound to this contact (lender_contact_id match).
	 *  Pre-selected in the picker when exactly one exists. */
	contactLoans: readonly ContactLoanInfo[];
	/** All CC-payable accounts on this org. The eye icon next to "Credit
	 *  Card" expands a sub-dropdown of these. Empty array → eye is empty;
	 *  the "+ add" icon is the only path forward. */
	creditCardAccounts: readonly AccountPick[];
	/** All lease accounts on this org (mirror of creditCardAccounts). */
	leaseAccounts: readonly AccountPick[];
	/** Full CoA for the "Other" picker. */
	allAccounts: readonly AccountPick[];
	/** Notifies the parent (sub-group row) that any of this contact's
	 *  actions is in flight, so it can render a spinner / disable other
	 *  controls. */
	onPendingChange?: (pending: boolean) => void;
	/** When true, the three top-level icons render grey-at-rest with their
	 *  accent color only on hover. Used in per-row mounts (under a sub-
	 *  group) so the row doesn't shout four colored chips at the reader;
	 *  reverts to colored-at-rest at the sub-group header level. */
	muted?: boolean;
}

/**
 * Per-contact action trio for the TRUST_DEFERRED_LOAN_SPLIT_NEEDED
 * sub-group. Mounted in the sub-group header row, on the right side.
 *
 *   Not a Loan  — menu of Credit Card / Lease / Other; pick recategorizes
 *                 every finding for this contact and stamps the matching
 *                 typeTag (CC / lease) on the contact for future auto-
 *                 bucketing.
 *   Yes Loan    — loan picker; selection lives in component state. After
 *                 picking, the chosen loan is shown as a pill and Approve
 *                 lights up.
 *   Approve     — disabled until a loan is picked. Stamps 'loan_vendor'
 *                 and loops linkPaymentToLoan over every finding for this
 *                 contact, executing the P/I split.
 *
 * Selection state is React-only — picking a loan then refreshing the
 * page resets the picker. Accepted for MVP.
 */
// Top-level icon classNames. Two variants per color: 'full' = accent
// background at rest (used in the sub-group header), 'muted' = grey at
// rest with accent only on hover (used per row to keep the row quiet
// until the user mouses over an action).
const ICON_BASE = 'inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const ICON_ORANGE_FULL = 'border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-800 dark:bg-orange-900/30 dark:text-orange-300 dark:hover:bg-orange-900/50';
const ICON_ORANGE_MUTED = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-orange-800 dark:hover:bg-orange-900/30 dark:hover:text-orange-300';
const ICON_BLUE_FULL = 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50';
const ICON_BLUE_MUTED = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-blue-800 dark:hover:bg-blue-900/30 dark:hover:text-blue-300';
const ICON_EMERALD_FULL = 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50';
const ICON_EMERALD_MUTED = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-emerald-800 dark:hover:bg-emerald-900/30 dark:hover:text-emerald-300';

export function LoanPaymentContactActions({
	contactId,
	contactName,
	findingIds,
	allLoans,
	contactLoans,
	creditCardAccounts,
	leaseAccounts,
	allAccounts,
	onPendingChange,
	muted = false,
}: Props) {
	const notLoanCls = `${ICON_BASE} ${muted ? ICON_ORANGE_MUTED : ICON_ORANGE_FULL}`;
	const yesLoanCls = `${ICON_BASE} ${muted ? ICON_BLUE_MUTED : ICON_BLUE_FULL}`;
	const approveCls = `${ICON_BASE} ${muted ? ICON_EMERALD_MUTED : ICON_EMERALD_FULL}`;
	const [pickedLoanId, setPickedLoanId] = useState<string>(() => {
		if (contactLoans.length === 1) return contactLoans[0].id;
		return '';
	});
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [notLoanOpen, setNotLoanOpen] = useState(false);
	const [yesLoanOpen, setYesLoanOpen] = useState(false);
	const [otherCoaOpen, setOtherCoaOpen] = useState(false);
	const [ccDropdownOpen, setCcDropdownOpen] = useState(false);
	const [leaseDropdownOpen, setLeaseDropdownOpen] = useState(false);

	const notLoanRef = useRef<HTMLDivElement>(null);
	const yesLoanRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		onPendingChange?.(pending);
	}, [pending, onPendingChange]);

	// Click-outside to close any open dropdowns.
	useEffect(() => {
		if (!notLoanOpen && !yesLoanOpen) return;
		const handler = (e: MouseEvent) => {
			const t = e.target as Node | null;
			if (notLoanOpen && notLoanRef.current && t && !notLoanRef.current.contains(t)) {
				setNotLoanOpen(false);
				setOtherCoaOpen(false);
				setCcDropdownOpen(false);
				setLeaseDropdownOpen(false);
			}
			if (yesLoanOpen && yesLoanRef.current && t && !yesLoanRef.current.contains(t)) {
				setYesLoanOpen(false);
			}
		};
		window.addEventListener('mousedown', handler);
		return () => window.removeEventListener('mousedown', handler);
	}, [notLoanOpen, yesLoanOpen]);

	const disabled = pending || findingIds.length === 0;

	const runNotLoan = (
		classification: NotLoanClassification,
		targetAccountId: string,
	) => {
		setError(null);
		setNotLoanOpen(false);
		setOtherCoaOpen(false);
		startTransition(async () => {
			const r = await classifyContactNotLoan({
				contactId: contactId ?? null,
				findingIds,
				classification,
				targetAccountId,
			});
			if (!r.ok) {
				setError(
					r.error
						?? `${r.processed} ok, ${r.failed.length} failed — first: ${r.failed[0]?.error ?? 'unknown'}`,
				);
			}
		});
	};

	const runApprove = () => {
		if (!pickedLoanId) {
			setError('Pick a loan first via Yes Loan');
			return;
		}
		setError(null);
		startTransition(async () => {
			const r = await approveContactLoanPayment({
				contactId: contactId ?? null,
				findingIds,
				loanId: pickedLoanId,
			});
			if (!r.ok) {
				setError(
					r.error
						?? `${r.processed} ok, ${r.failed.length} failed — first: ${r.failed[0]?.error ?? 'unknown'}`,
				);
			}
		});
	};

	const pickedLoan = allLoans.find((l) => l.id === pickedLoanId);

	return (
		<div className="flex items-center gap-2">
			{pickedLoan && (
				<span
					className="hidden truncate rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 sm:inline dark:bg-emerald-900/30 dark:text-emerald-300"
					title={`Picked: ${pickedLoan.displayName}`}
				>
					{pickedLoan.displayName}
				</span>
			)}

			{/* Not a Loan */}
			<div ref={notLoanRef} className="relative">
				<button
					type="button"
					onClick={() => {
						setNotLoanOpen((v) => !v);
						setYesLoanOpen(false);
					}}
					disabled={disabled}
					title={`Not a loan — recategorize all ${findingIds.length} finding${findingIds.length === 1 ? '' : 's'} for ${contactName}`}
					aria-label="Not a loan — recategorize"
					className={notLoanCls}
				>
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<circle cx="12" cy="12" r="10" />
						<line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
					</svg>
				</button>
				{notLoanOpen && (
					<div className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-zinc-200 bg-white p-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
						<CategoryRow
							label="Credit Card"
							accounts={creditCardAccounts}
							open={ccDropdownOpen}
							onToggle={() => {
								setCcDropdownOpen((v) => !v);
								setLeaseDropdownOpen(false);
								setOtherCoaOpen(false);
							}}
							onPick={(acctId) => runNotLoan('credit_card', acctId)}
							onAddNew={(last4) => {
								if (!contactId) return; // hideAddNew should prevent this
								setError(null);
								startTransition(async () => {
									const r = await createContactCreditCardSubAccount({
										contactId,
										last4: last4 || null,
									});
									if (!r.ok || !r.accountId) {
										setError(r.error ?? 'Failed to add CC sub-account');
										return;
									}
									// Auto-apply: recategorize this contact's findings onto
									// the freshly created sub-account. Mirrors what
									// runNotLoan does, minus the menu-close (runNotLoan
									// closes the menu before the action; we want the
									// transition to wrap both calls).
									const r2 = await classifyContactNotLoan({
										contactId,
										findingIds,
										classification: 'credit_card',
										targetAccountId: r.accountId,
									});
									if (!r2.ok) {
										setError(
											r2.error
												?? `${r2.processed} ok, ${r2.failed.length} failed`,
										);
										return;
									}
									setNotLoanOpen(false);
									setCcDropdownOpen(false);
								});
							}}
							pending={pending}
							addNewTitle="Create a sub-account under 215 for this contact"
							promptOnAddLabel={`Last 4 of ${contactName}'s card (optional)`}
							promptInputMaxLength={4}
							promptInputMode="numeric"
							hideAddNew={!contactId}
						/>
						<CategoryRow
							label="Lease"
							accounts={leaseAccounts}
							open={leaseDropdownOpen}
							onToggle={() => {
								setLeaseDropdownOpen((v) => !v);
								setCcDropdownOpen(false);
								setOtherCoaOpen(false);
							}}
							onPick={(acctId) => runNotLoan('lease', acctId)}
							onAddNew={(leaseName) => {
								if (!contactId) return; // hideAddNew should prevent this
								setError(null);
								startTransition(async () => {
									const r = await createContactLeaseSubAccount({
										contactId,
										leaseName: leaseName || null,
									});
									if (!r.ok || !r.accountId) {
										setError(r.error ?? 'Failed to add lease sub-account');
										return;
									}
									// Auto-apply: recategorize this contact's findings onto
									// the freshly created sub-account.
									const r2 = await classifyContactNotLoan({
										contactId,
										findingIds,
										classification: 'lease',
										targetAccountId: r.accountId,
									});
									if (!r2.ok) {
										setError(
											r2.error
												?? `${r2.processed} ok, ${r2.failed.length} failed`,
										);
										return;
									}
									setNotLoanOpen(false);
									setLeaseDropdownOpen(false);
								});
							}}
							pending={pending}
							addNewTitle="Create a sub-account under 680 for this contact"
							promptOnAddLabel={`Lease name for ${contactName} (e.g. 2024 GLE)`}
							hideAddNew={!contactId}
						/>
						<button
							type="button"
							onClick={() => {
								setOtherCoaOpen((v) => !v);
								setCcDropdownOpen(false);
								setLeaseDropdownOpen(false);
							}}
							className="block w-full rounded-md px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
						>
							Other →
						</button>
						{otherCoaOpen && (
							<div className="mt-1 max-h-72 overflow-y-auto border-t border-zinc-200 pt-1 dark:border-zinc-800">
								{allAccounts.map((a) => (
									<button
										key={a.id}
										type="button"
										onClick={() => runNotLoan('other', a.id)}
										className="block w-full rounded-md px-3 py-1 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
									>
										<span className="font-mono">{a.accountNumber}</span>{' '}
										{a.accountName}
									</button>
								))}
							</div>
						)}
						<button
							type="button"
							onClick={() => {
								setNotLoanOpen(false);
								setOtherCoaOpen(false);
								setCcDropdownOpen(false);
								setLeaseDropdownOpen(false);
							}}
							className="mt-1 block w-full rounded-md border-t border-zinc-200 px-3 py-1.5 text-left text-xs text-zinc-500 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
						>
							✕ Close
						</button>
					</div>
				)}
			</div>

			{/* Yes Loan */}
			<div ref={yesLoanRef} className="relative">
				<button
					type="button"
					onClick={() => {
						setYesLoanOpen((v) => !v);
						setNotLoanOpen(false);
					}}
					disabled={disabled}
					title={
						allLoans.length === 0
							? 'No loans on file — add one on /loans first'
							: pickedLoan
								? `Loan picked: ${pickedLoan.displayName}`
								: 'Pick a loan to apply'
					}
					aria-label="Yes loan — pick which one"
					className={yesLoanCls}
				>
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<rect x="3" y="6" width="18" height="13" rx="2" />
						<line x1="3" y1="10" x2="21" y2="10" />
						<line x1="7" y1="15" x2="11" y2="15" />
					</svg>
				</button>
				{yesLoanOpen && (
					<div className="absolute right-0 z-20 mt-1 w-72 rounded-md border border-zinc-200 bg-white p-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
						{allLoans.length === 0 && (
							<div className="px-3 py-2 text-xs text-zinc-500">
								No loans yet.{' '}
								<Link href="/loans" className="text-blue-600 hover:underline">
									Add one →
								</Link>
							</div>
						)}
						{allLoans.map((l) => {
							const isContactLoan = contactLoans.some((cl) => cl.id === l.id);
							return (
								<button
									key={l.id}
									type="button"
									onClick={() => {
										setPickedLoanId(l.id);
										setYesLoanOpen(false);
									}}
									className={`block w-full rounded-md px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
										l.id === pickedLoanId
											? 'bg-blue-50 dark:bg-blue-900/20'
											: ''
									}`}
								>
									<div className="font-medium">
										{l.displayName}
										{isContactLoan && (
											<span className="ml-2 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
												bound
											</span>
										)}
									</div>
									{l.nextPaymentNumber !== null && l.nextDueDate && (
										<div className="text-xs text-zinc-500">
											next: #{l.nextPaymentNumber} due {l.nextDueDate}
											{l.nextTotal !== null && ` · $${l.nextTotal.toFixed(2)}`}
										</div>
									)}
								</button>
							);
						})}
						<Link
							href="/loans"
							className="block rounded-md border-t border-zinc-200 px-3 py-1.5 text-left text-xs text-blue-600 hover:bg-zinc-100 hover:underline dark:border-zinc-800 dark:hover:bg-zinc-800"
						>
							+ Add new loan
						</Link>
					</div>
				)}
			</div>

			{/* Approve */}
			<button
				type="button"
				onClick={runApprove}
				disabled={disabled || !pickedLoanId}
				title={
					pickedLoanId
						? `Approve all ${findingIds.length} as ${pickedLoan?.displayName} payments`
						: 'Pick a loan first via Yes Loan'
				}
				aria-label="Approve as loan payments"
				className={approveCls}
			>
				{pending ? (
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin" aria-hidden="true">
						<path d="M21 12a9 9 0 11-6.219-8.56" />
					</svg>
				) : (
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<polyline points="20 6 9 17 4 12" />
					</svg>
				)}
			</button>

			{error && (
				<span className="text-xs text-red-600 dark:text-red-400" title={error}>
					{error.length > 40 ? error.slice(0, 40) + '…' : error}
				</span>
			)}
		</div>
	);
}

/**
 * One row inside the "Not a Loan" menu — handles Credit Card and Lease
 * identically. The row shows "{label} →" followed by an eye icon (expands
 * the sub-list of accounts for that category) and a plus icon (creates a
 * new account on the fly).
 *
 *   eye   — disabled when accounts.length === 0 (nothing to show)
 *   plus  — always enabled; either:
 *           - calls onAddNew(null) immediately when promptOnAddLabel is
 *             unset (Lease — instant create), OR
 *           - toggles an inline input asking for a value, then calls
 *             onAddNew(value) on submit (CC — last-4 prompt)
 */
function CategoryRow({
	label,
	accounts,
	open,
	onToggle,
	onPick,
	onAddNew,
	pending,
	addNewTitle,
	promptOnAddLabel,
	promptInputMaxLength,
	promptInputMode,
	hideAddNew,
}: {
	label: string;
	accounts: readonly AccountPick[];
	open: boolean;
	onToggle: () => void;
	onPick: (accountId: string) => void;
	onAddNew: (input: string | null) => void;
	pending: boolean;
	addNewTitle: string;
	promptOnAddLabel?: string;
	promptInputMaxLength?: number;
	promptInputMode?: 'numeric' | 'text';
	/** When true, render no + button. Used in bulk-toolbar mode where
	 *  per-contact sub-account creation isn't applicable. */
	hideAddNew?: boolean;
}) {
	const [promptOpen, setPromptOpen] = useState(false);
	const [promptValue, setPromptValue] = useState('');
	return (
		<div className="px-1">
			<div className="flex items-center gap-1 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800">
				<button
					type="button"
					onClick={onToggle}
					disabled={accounts.length === 0}
					className="flex flex-1 items-center gap-1 px-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-50"
					aria-expanded={open}
				>
					<span>{label}</span>
					<span className="text-zinc-400">→</span>
				</button>
				<button
					type="button"
					onClick={onToggle}
					disabled={accounts.length === 0}
					title={accounts.length === 0 ? `No ${label} accounts — use + to add one` : `Browse ${accounts.length} ${label} account${accounts.length === 1 ? '' : 's'}`}
					aria-label={`Browse ${label} accounts`}
					className="inline-flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-700"
				>
					<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
						<circle cx="12" cy="12" r="3" />
					</svg>
				</button>
				{!hideAddNew && (
					<button
						type="button"
						onClick={() => {
							if (promptOnAddLabel) {
								setPromptOpen((v) => !v);
							} else {
								onAddNew(null);
							}
						}}
						disabled={pending}
						title={addNewTitle}
						aria-label={`Add new ${label} account`}
						className="inline-flex h-6 w-6 items-center justify-center rounded border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50"
					>
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
							<line x1="12" y1="5" x2="12" y2="19" />
							<line x1="5" y1="12" x2="19" y2="12" />
						</svg>
					</button>
				)}
			</div>
			{promptOpen && promptOnAddLabel && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						onAddNew(promptValue.trim() || null);
						setPromptOpen(false);
						setPromptValue('');
					}}
					className="mt-1 flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
				>
					<input
						type="text"
						value={promptValue}
						onChange={(e) => setPromptValue(e.target.value)}
						placeholder={promptOnAddLabel}
						inputMode={promptInputMode ?? 'text'}
						autoFocus
						maxLength={promptInputMaxLength}
						className="flex-1 rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300 dark:border-zinc-700 dark:bg-zinc-950"
					/>
					<button
						type="submit"
						disabled={pending}
						className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
					>
						Create
					</button>
					<button
						type="button"
						onClick={() => {
							setPromptOpen(false);
							setPromptValue('');
						}}
						className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
					>
						Cancel
					</button>
				</form>
			)}
			{open && accounts.length > 0 && (
				<div className="mt-1 max-h-60 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-800">
					{accounts.map((a) => (
						<button
							key={a.id}
							type="button"
							onClick={() => onPick(a.id)}
							className="block w-full px-3 py-1 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
						>
							<span className="font-mono">{a.accountNumber}</span>{' '}
							{a.accountName}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
