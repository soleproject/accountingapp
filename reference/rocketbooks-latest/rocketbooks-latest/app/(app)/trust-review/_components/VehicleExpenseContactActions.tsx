'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { approveContactVehicleExpense } from '../_actions/approveContactVehicleExpense';
import { recategorizeContactVehicleExpense } from '../_actions/recategorizeContactVehicleExpense';
import type { AccountPick } from './RecategorizeNonTrustButton';

export interface VehiclePick {
	id: string;
	name: string;
	/** "2024 GLE" / "Asset #A-12" style sublabel. Optional. */
	sublabel?: string | null;
}

interface Props {
	/** Source contact when scoped to a single sub-group / row. Omitted
	 *  when mounted in the selection toolbar across multiple contacts. */
	contactId?: string;
	contactName: string;
	/** Every open finding for this contact in the 605 verify group, OR
	 *  every selected finding when mounted in the toolbar. */
	findingIds: string[];
	/** All active trust-owned vehicles (fixed_assets rows in the Vehicles
	 *  asset category). Drives the Pick-Vehicle dropdown. */
	vehicles: readonly VehiclePick[];
	/** Full CoA for the Not-a-Vehicle → Other → CoA picker. */
	allAccounts: readonly AccountPick[];
	onPendingChange?: (pending: boolean) => void;
	/** When true, render top-level icons grey-at-rest / colored on hover
	 *  (per-row treatment). Defaults to false (sub-group header treatment). */
	muted?: boolean;
}

// Top-level icon classNames — same scheme as LoanPaymentContactActions
// so the row visuals match across loan-payment and vehicle-expense.
const ICON_BASE = 'inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const ICON_ORANGE_FULL = 'border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-800 dark:bg-orange-900/30 dark:text-orange-300 dark:hover:bg-orange-900/50';
const ICON_ORANGE_MUTED = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-orange-800 dark:hover:bg-orange-900/30 dark:hover:text-orange-300';
const ICON_BLUE_FULL = 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50';
const ICON_BLUE_MUTED = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-blue-800 dark:hover:bg-blue-900/30 dark:hover:text-blue-300';
const ICON_EMERALD_FULL = 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50';
const ICON_EMERALD_MUTED = 'border-zinc-200 bg-transparent text-zinc-400 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-emerald-800 dark:hover:bg-emerald-900/30 dark:hover:text-emerald-300';

/**
 * Per-contact action trio for the TRUST_605_VERIFY_TRUST_OWNED_VEHICLE
 * sub-group, mirroring LoanPaymentContactActions:
 *
 *   Not a Vehicle Expense  — menu with only "Other → [CoA picker]"; the
 *                            + next to Other links to /chart-of-accounts/new
 *                            for arbitrary CoA creation. Picking from the
 *                            CoA list recategorizes all the contact's
 *                            findings onto that account.
 *   Pick Vehicle           — dropdown of trust-owned vehicles + a link to
 *                            /assets/new for "Add new vehicle". Selection
 *                            lives in component state.
 *   Approve                — disabled until a vehicle is picked; calls
 *                            approveContactVehicleExpense to tag the JE
 *                            line(s) with fixed_asset_id and dismiss the
 *                            finding(s).
 */
export function VehicleExpenseContactActions({
	contactId,
	contactName,
	findingIds,
	vehicles,
	allAccounts,
	onPendingChange,
	muted = false,
}: Props) {
	const [pickedVehicleId, setPickedVehicleId] = useState<string>('');
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [notVehicleOpen, setNotVehicleOpen] = useState(false);
	const [pickVehicleOpen, setPickVehicleOpen] = useState(false);
	const [otherCoaOpen, setOtherCoaOpen] = useState(false);

	const notVehicleRef = useRef<HTMLDivElement>(null);
	const pickVehicleRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		onPendingChange?.(pending);
	}, [pending, onPendingChange]);

	useEffect(() => {
		if (!notVehicleOpen && !pickVehicleOpen) return;
		const handler = (e: MouseEvent) => {
			const t = e.target as Node | null;
			if (notVehicleOpen && notVehicleRef.current && t && !notVehicleRef.current.contains(t)) {
				setNotVehicleOpen(false);
				setOtherCoaOpen(false);
			}
			if (pickVehicleOpen && pickVehicleRef.current && t && !pickVehicleRef.current.contains(t)) {
				setPickVehicleOpen(false);
			}
		};
		window.addEventListener('mousedown', handler);
		return () => window.removeEventListener('mousedown', handler);
	}, [notVehicleOpen, pickVehicleOpen]);

	const disabled = pending || findingIds.length === 0;

	const runRecategorize = (targetAccountId: string) => {
		setError(null);
		setNotVehicleOpen(false);
		setOtherCoaOpen(false);
		startTransition(async () => {
			const r = await recategorizeContactVehicleExpense({
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
		if (!pickedVehicleId) {
			setError('Pick a vehicle first');
			return;
		}
		setError(null);
		startTransition(async () => {
			const r = await approveContactVehicleExpense({
				contactId: contactId ?? null,
				findingIds,
				vehicleId: pickedVehicleId,
			});
			if (!r.ok) {
				setError(
					r.error
						?? `${r.processed} ok, ${r.failed.length} failed — first: ${r.failed[0]?.error ?? 'unknown'}`,
				);
			}
		});
	};

	const pickedVehicle = vehicles.find((v) => v.id === pickedVehicleId);

	const notVehicleCls = `${ICON_BASE} ${muted ? ICON_ORANGE_MUTED : ICON_ORANGE_FULL}`;
	const pickVehicleCls = `${ICON_BASE} ${muted ? ICON_BLUE_MUTED : ICON_BLUE_FULL}`;
	const approveCls = `${ICON_BASE} ${muted ? ICON_EMERALD_MUTED : ICON_EMERALD_FULL}`;

	return (
		<div className="flex items-center gap-2">
			{pickedVehicle && (
				<span
					className="hidden truncate rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 sm:inline dark:bg-emerald-900/30 dark:text-emerald-300"
					title={`Picked: ${pickedVehicle.name}`}
				>
					{pickedVehicle.name}
				</span>
			)}

			{/* Not a Vehicle Expense */}
			<div ref={notVehicleRef} className="relative">
				<button
					type="button"
					onClick={() => {
						setNotVehicleOpen((v) => !v);
						setPickVehicleOpen(false);
					}}
					disabled={disabled}
					title={`Not a vehicle expense — recategorize all ${findingIds.length} finding${findingIds.length === 1 ? '' : 's'} for ${contactName}`}
					aria-label="Not a vehicle expense — recategorize"
					className={notVehicleCls}
				>
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<circle cx="12" cy="12" r="10" />
						<line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
					</svg>
				</button>
				{notVehicleOpen && (
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
								setNotVehicleOpen(false);
								setOtherCoaOpen(false);
							}}
							className="mt-1 block w-full rounded-md border-t border-zinc-200 px-3 py-1.5 text-left text-xs text-zinc-500 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
						>
							✕ Close
						</button>
					</div>
				)}
			</div>

			{/* Pick Vehicle */}
			<div ref={pickVehicleRef} className="relative">
				<button
					type="button"
					onClick={() => {
						setPickVehicleOpen((v) => !v);
						setNotVehicleOpen(false);
					}}
					disabled={disabled}
					title={
						vehicles.length === 0
							? 'No vehicles on file — add one on /assets first'
							: pickedVehicle
								? `Picked: ${pickedVehicle.name}`
								: 'Pick a trust-owned vehicle'
					}
					aria-label="Pick vehicle"
					className={pickVehicleCls}
				>
					{/* Car silhouette */}
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M3 12l2-5h14l2 5" />
						<path d="M3 12v5h18v-5" />
						<circle cx="7" cy="17" r="1.5" />
						<circle cx="17" cy="17" r="1.5" />
					</svg>
				</button>
				{pickVehicleOpen && (
					<div className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-zinc-200 bg-white p-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
						{vehicles.length === 0 && (
							<div className="px-3 py-2 text-xs text-zinc-500">
								No vehicles yet.{' '}
								<Link href="/assets/new" className="text-blue-600 hover:underline">
									Add one →
								</Link>
							</div>
						)}
						{vehicles.map((v) => (
							<button
								key={v.id}
								type="button"
								onClick={() => {
									setPickedVehicleId(v.id);
									setPickVehicleOpen(false);
								}}
								className={`block w-full rounded-md px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
									v.id === pickedVehicleId
										? 'bg-blue-50 dark:bg-blue-900/20'
										: ''
								}`}
							>
								<div className="font-medium">{v.name}</div>
								{v.sublabel && (
									<div className="text-xs text-zinc-500">{v.sublabel}</div>
								)}
							</button>
						))}
						<Link
							href="/assets/new"
							className="block rounded-md border-t border-zinc-200 px-3 py-1.5 text-left text-xs text-blue-600 hover:bg-zinc-100 hover:underline dark:border-zinc-800 dark:hover:bg-zinc-800"
						>
							+ Add new vehicle
						</Link>
					</div>
				)}
			</div>

			{/* Approve */}
			<button
				type="button"
				onClick={runApprove}
				disabled={disabled || !pickedVehicleId}
				title={
					pickedVehicleId
						? `Tag all ${findingIds.length} 605 line${findingIds.length === 1 ? '' : 's'} to ${pickedVehicle?.name}`
						: 'Pick a vehicle first'
				}
				aria-label="Approve — tag to vehicle"
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
