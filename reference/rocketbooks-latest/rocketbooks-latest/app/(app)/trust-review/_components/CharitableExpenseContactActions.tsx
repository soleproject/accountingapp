'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { approveContactCharitableExpense } from '../_actions/approveContactCharitableExpense';
import { recategorizeContactCharitableExpense } from '../_actions/recategorizeContactCharitableExpense';
import { createOrTagCharityContact } from '../_actions/createOrTagCharityContact';
import type { AccountPick } from './RecategorizeNonTrustButton';

export interface CharityPick {
	id: string;
	contactName: string;
}

interface Props {
	/** Source-row contact id when this action set is mounted under a
	 *  single contact's sub-group or row. Omitted when mounted in the
	 *  selection toolbar (selected findings may span contacts). */
	contactId?: string;
	contactName: string;
	/** Every open finding for this contact in the 515 verify group, OR
	 *  every selected finding when mounted in the toolbar. */
	findingIds: string[];
	/** All contacts on this org tagged 'charity_501c3'. Drives the
	 *  Pick-Charity dropdown. */
	charities: readonly CharityPick[];
	/** Full CoA for the Not-a-Charity → Other → CoA picker. */
	allAccounts: readonly AccountPick[];
	onPendingChange?: (pending: boolean) => void;
	muted?: boolean;
}

// Identical icon class scheme to LoanPaymentContactActions /
// VehicleExpenseContactActions so the row visuals stay consistent.
const ICON_BASE = 'inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const ICON_ORANGE_FULL = 'border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-800 dark:bg-orange-900/30 dark:text-orange-300 dark:hover:bg-orange-900/50';
const ICON_ORANGE_MUTED = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-orange-800 dark:hover:bg-orange-900/30 dark:hover:text-orange-300';
const ICON_BLUE_FULL = 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50';
const ICON_BLUE_MUTED = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-blue-800 dark:hover:bg-blue-900/30 dark:hover:text-blue-300';
const ICON_EMERALD_FULL = 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50';
const ICON_EMERALD_MUTED = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-emerald-800 dark:hover:bg-emerald-900/30 dark:hover:text-emerald-300';

/**
 * Per-contact action trio for the TRUST_515_VERIFY_501C3 sub-group.
 *
 *   Not a Charitable Contribution  — menu with only "Other → CoA picker"
 *                                    + a Link to /chart-of-accounts/new.
 *                                    Picking recategorizes all the
 *                                    contact's findings.
 *   Pick Charity                    — dropdown of 'charity_501c3'-tagged
 *                                    contacts + inline "+ Add new
 *                                    charity" prompt. New charity flow
 *                                    creates (or re-uses + tags) a
 *                                    contact by the user-supplied name.
 *   Approve                         — disabled until a charity is picked.
 *                                    Stamps 'charity_501c3' on the
 *                                    charity contact (idempotent), re-
 *                                    points each finding's 515 line to
 *                                    that contact, drops the
 *                                    TRUST_515_RECIPIENT_VERIFIED audit,
 *                                    dismisses the finding.
 */
export function CharitableExpenseContactActions({
	contactId,
	contactName,
	findingIds,
	charities,
	allAccounts,
	onPendingChange,
	muted = false,
}: Props) {
	const [pickedCharityId, setPickedCharityId] = useState<string>('');
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [notCharityOpen, setNotCharityOpen] = useState(false);
	const [pickCharityOpen, setPickCharityOpen] = useState(false);
	const [otherCoaOpen, setOtherCoaOpen] = useState(false);
	const [newCharityPromptOpen, setNewCharityPromptOpen] = useState(false);
	const [newCharityName, setNewCharityName] = useState('');

	const notCharityRef = useRef<HTMLDivElement>(null);
	const pickCharityRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		onPendingChange?.(pending);
	}, [pending, onPendingChange]);

	useEffect(() => {
		if (!notCharityOpen && !pickCharityOpen) return;
		const handler = (e: MouseEvent) => {
			const t = e.target as Node | null;
			if (notCharityOpen && notCharityRef.current && t && !notCharityRef.current.contains(t)) {
				setNotCharityOpen(false);
				setOtherCoaOpen(false);
			}
			if (pickCharityOpen && pickCharityRef.current && t && !pickCharityRef.current.contains(t)) {
				setPickCharityOpen(false);
				setNewCharityPromptOpen(false);
			}
		};
		window.addEventListener('mousedown', handler);
		return () => window.removeEventListener('mousedown', handler);
	}, [notCharityOpen, pickCharityOpen]);

	const disabled = pending || findingIds.length === 0;

	const runRecategorize = (targetAccountId: string) => {
		setError(null);
		setNotCharityOpen(false);
		setOtherCoaOpen(false);
		startTransition(async () => {
			const r = await recategorizeContactCharitableExpense({
				findingIds,
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
		if (!pickedCharityId) {
			setError('Pick a charity first');
			return;
		}
		setError(null);
		startTransition(async () => {
			const r = await approveContactCharitableExpense({
				contactId: contactId ?? null,
				findingIds,
				charityContactId: pickedCharityId,
			});
			if (!r.ok) {
				setError(
					r.error
						?? `${r.processed} ok, ${r.failed.length} failed — first: ${r.failed[0]?.error ?? 'unknown'}`,
				);
			}
		});
	};

	const pickedCharity = charities.find((c) => c.id === pickedCharityId);
	const notCharityCls = `${ICON_BASE} ${muted ? ICON_ORANGE_MUTED : ICON_ORANGE_FULL}`;
	const pickCharityCls = `${ICON_BASE} ${muted ? ICON_BLUE_MUTED : ICON_BLUE_FULL}`;
	const approveCls = `${ICON_BASE} ${muted ? ICON_EMERALD_MUTED : ICON_EMERALD_FULL}`;

	return (
		<div className="flex items-center gap-2">
			{pickedCharity && (
				<span
					className="hidden truncate rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 sm:inline dark:bg-emerald-900/30 dark:text-emerald-300"
					title={`Picked: ${pickedCharity.contactName}`}
				>
					{pickedCharity.contactName}
				</span>
			)}

			{/* Not a Charitable Contribution */}
			<div ref={notCharityRef} className="relative">
				<button
					type="button"
					onClick={() => {
						setNotCharityOpen((v) => !v);
						setPickCharityOpen(false);
					}}
					disabled={disabled}
					title={`Not a charitable contribution — recategorize all ${findingIds.length} finding${findingIds.length === 1 ? '' : 's'} for ${contactName}`}
					aria-label="Not a charitable contribution"
					className={notCharityCls}
				>
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<circle cx="12" cy="12" r="10" />
						<line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
					</svg>
				</button>
				{notCharityOpen && (
					<div className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-zinc-200 bg-white p-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
						<div className="flex items-center gap-1 rounded-md px-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
							<button
								type="button"
								onClick={() => setOtherCoaOpen((v) => !v)}
								className="flex flex-1 items-center gap-1 px-2 py-1.5 text-left"
								aria-expanded={otherCoaOpen}
							>
								<span>Other</span>
								<span className="text-zinc-400">→</span>
							</button>
							<Link
								href="/chart-of-accounts/new"
								title="Create a new account (opens chart-of-accounts/new)"
								aria-label="Add new CoA"
								className="inline-flex h-6 w-6 items-center justify-center rounded border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50"
							>
								<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
									<line x1="12" y1="5" x2="12" y2="19" />
									<line x1="5" y1="12" x2="19" y2="12" />
								</svg>
							</Link>
						</div>
						{otherCoaOpen && (
							<div className="mt-1 max-h-72 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-800">
								{allAccounts.map((a) => (
									<button
										key={a.id}
										type="button"
										onClick={() => runRecategorize(a.id)}
										className="block w-full px-3 py-1 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
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
								setNotCharityOpen(false);
								setOtherCoaOpen(false);
							}}
							className="mt-1 block w-full rounded-md border-t border-zinc-200 px-3 py-1.5 text-left text-xs text-zinc-500 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
						>
							✕ Close
						</button>
					</div>
				)}
			</div>

			{/* Pick Charity */}
			<div ref={pickCharityRef} className="relative">
				<button
					type="button"
					onClick={() => {
						setPickCharityOpen((v) => !v);
						setNotCharityOpen(false);
					}}
					disabled={disabled}
					title={
						charities.length === 0
							? 'No charities on file — use + to add one'
							: pickedCharity
								? `Picked: ${pickedCharity.contactName}`
								: 'Pick a 501(c)(3) charity'
					}
					aria-label="Pick charity"
					className={pickCharityCls}
				>
					{/* Hand giving a heart — donate / charity glyph */}
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
					</svg>
				</button>
				{pickCharityOpen && (
					<div className="absolute right-0 z-20 mt-1 w-72 rounded-md border border-zinc-200 bg-white p-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
						{charities.length === 0 && !newCharityPromptOpen && (
							<div className="px-3 py-2 text-xs text-zinc-500">
								No 501(c)(3) charities yet — use + below to add one.
							</div>
						)}
						{charities.map((c) => (
							<button
								key={c.id}
								type="button"
								onClick={() => {
									setPickedCharityId(c.id);
									setPickCharityOpen(false);
								}}
								className={`block w-full rounded-md px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
									c.id === pickedCharityId
										? 'bg-blue-50 dark:bg-blue-900/20'
										: ''
								}`}
							>
								<div className="font-medium">{c.contactName}</div>
								<div className="text-xs text-zinc-500">501(c)(3) tagged</div>
							</button>
						))}
						{!newCharityPromptOpen ? (
							<button
								type="button"
								onClick={() => setNewCharityPromptOpen(true)}
								className="block w-full rounded-md border-t border-zinc-200 px-3 py-1.5 text-left text-xs text-blue-600 hover:bg-zinc-100 hover:underline dark:border-zinc-800 dark:hover:bg-zinc-800"
							>
								+ Add new charity
							</button>
						) : (
							<form
								onSubmit={(e) => {
									e.preventDefault();
									if (!newCharityName.trim()) return;
									setError(null);
									const name = newCharityName.trim();
									startTransition(async () => {
										const r = await createOrTagCharityContact({ name });
										if (!r.ok || !r.contactId) {
											setError(r.error ?? 'Failed to add charity');
											return;
										}
										setPickedCharityId(r.contactId);
										setNewCharityPromptOpen(false);
										setNewCharityName('');
										setPickCharityOpen(false);
									});
								}}
								className="mt-1 flex items-center gap-1 rounded-md border-t border-zinc-200 p-1.5 dark:border-zinc-800"
							>
								<input
									type="text"
									value={newCharityName}
									onChange={(e) => setNewCharityName(e.target.value)}
									placeholder="Charity name (required)"
									autoFocus
									maxLength={200}
									className="flex-1 rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300 dark:border-zinc-700 dark:bg-zinc-950"
								/>
								<button
									type="submit"
									disabled={pending || !newCharityName.trim()}
									className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
								>
									Create
								</button>
								<button
									type="button"
									onClick={() => {
										setNewCharityPromptOpen(false);
										setNewCharityName('');
									}}
									className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
								>
									Cancel
								</button>
							</form>
						)}
					</div>
				)}
			</div>

			{/* Approve */}
			<button
				type="button"
				onClick={runApprove}
				disabled={disabled || !pickedCharityId}
				title={
					pickedCharityId
						? `Verify all ${findingIds.length} 515 line${findingIds.length === 1 ? '' : 's'} for ${pickedCharity?.contactName}`
						: 'Pick a charity first'
				}
				aria-label="Approve — verify 501(c)(3) recipient"
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
