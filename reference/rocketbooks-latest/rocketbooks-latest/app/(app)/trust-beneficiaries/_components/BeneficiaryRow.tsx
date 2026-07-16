'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { updateBeneficiary } from '../_actions/updateBeneficiary';
import { previewBeneficiaryDobChange } from '../_actions/previewBeneficiaryDobChange';
import { DobCorrectionModal } from './DobCorrectionModal';
import type { DobCorrectionDiff } from '@/lib/accounting/trust-dob-correction';

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

interface Props {
	id: string;
	fullName: string;
	relationship: string | null;
	dateOfBirth: string | null;
	ageYears: number | null;
	eligibility: React.ReactNode;
	/** Pre-rendered Demand Note cell (count + acct sublabel) — server side. */
	demandNoteCell: React.ReactNode;
	outstanding: number;
	outstandingHint: boolean;
	taggedCount: number;
	k1Ytd: number;
}

/**
 * Per-row inline edit on /trust-beneficiaries. Pencil button swaps the
 * Name / DOB / Relationship cells for inputs; Save calls updateBeneficiary,
 * Cancel reverts. Other cells (Eligibility, Demand Note, totals) stay
 * read-only — incapacitation toggle + status lives on the detail page card.
 */
export function BeneficiaryRow(props: Props) {
	const [editing, setEditing] = useState(false);
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [fullName, setFullName] = useState(props.fullName);
	const [relationship, setRelationship] = useState(props.relationship ?? '');
	const [dateOfBirth, setDateOfBirth] = useState(props.dateOfBirth ?? '');
	const [dobDiff, setDobDiff] = useState<DobCorrectionDiff | null>(null);

	const reset = () => {
		setFullName(props.fullName);
		setRelationship(props.relationship ?? '');
		setDateOfBirth(props.dateOfBirth ?? '');
		setError(null);
	};

	// Persists the non-DOB fields via updateBeneficiary. Called by both the
	// no-DOB-change branch and the post-modal-confirm path (the modal
	// handles the DOB + repost; we still need to save name/relationship).
	const saveNonDobFields = (onDone: () => void) => {
		const fd = new FormData();
		fd.set('beneficiaryId', props.id);
		fd.set('fullName', fullName);
		// Always send the CURRENT-persisted DOB so updateBeneficiary doesn't
		// fight the modal's apply path. When the modal isn't involved,
		// dateOfBirth and props.dateOfBirth are equal anyway.
		fd.set('dateOfBirth', props.dateOfBirth ?? '');
		fd.set('relationship', relationship);
		startTransition(async () => {
			const r = await updateBeneficiary(undefined, fd);
			if (r?.error) {
				setError(r.error);
				return;
			}
			onDone();
		});
	};

	const onSave = () => {
		setError(null);
		const newDob = dateOfBirth.trim();
		const oldDob = (props.dateOfBirth ?? '').trim();
		const dobChanged = newDob !== oldDob;

		if (!dobChanged) {
			saveNonDobFields(() => setEditing(false));
			return;
		}

		// DOB changed → preview first. If the diff has any rerouteOut /
		// rerouteIn entries, open the modal so the user can confirm before
		// reposts happen. If empty, fall through to a normal save with the
		// new DOB.
		startTransition(async () => {
			const r = await previewBeneficiaryDobChange({
				beneficiaryId: props.id,
				newDob,
			});
			if (!r.ok || !r.diff) {
				setError(r.error ?? 'Failed to preview DOB change');
				return;
			}
			const noOp =
				r.diff.rerouteOut.length === 0
				&& r.diff.rerouteIn.length === 0
				&& r.diff.manualReview.length === 0;
			if (noOp) {
				// No reposts needed — update both DOB and the other fields
				// directly. updateBeneficiary writes whatever is in the form.
				const fd = new FormData();
				fd.set('beneficiaryId', props.id);
				fd.set('fullName', fullName);
				fd.set('dateOfBirth', newDob);
				fd.set('relationship', relationship);
				const r2 = await updateBeneficiary(undefined, fd);
				if (r2?.error) {
					setError(r2.error);
					return;
				}
				setEditing(false);
				return;
			}
			// Open the modal — apply path handles the DOB + reposts.
			setDobDiff(r.diff);
		});
	};

	const onCancel = () => {
		reset();
		setEditing(false);
	};

	const onModalApplied = () => {
		// Modal already saved the DOB + reposted. Persist name/relationship
		// if those also changed.
		const nameChanged = fullName !== props.fullName;
		const relChanged = (relationship || null) !== (props.relationship ?? null);
		setDobDiff(null);
		if (nameChanged || relChanged) {
			saveNonDobFields(() => setEditing(false));
		} else {
			setEditing(false);
		}
	};

	return (
		<>
		{dobDiff && (
			<DobCorrectionModal
				diff={dobDiff}
				onCancel={() => setDobDiff(null)}
				onApplied={onModalApplied}
			/>
		)}
		<tr className="border-t border-zinc-100 dark:border-zinc-800">
			<td className="px-4 py-2 align-top text-zinc-700 dark:text-zinc-300">
				{editing ? (
					<div className="flex flex-col gap-1">
						<input
							type="text"
							value={fullName}
							onChange={(e) => setFullName(e.target.value)}
							disabled={pending}
							className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
							placeholder="Full name"
						/>
						<input
							type="text"
							value={relationship}
							onChange={(e) => setRelationship(e.target.value)}
							disabled={pending}
							className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
							placeholder="Relationship (e.g. son)"
						/>
					</div>
				) : (
					<>
						<div className="font-medium">
							<Link
								href={`/trust-beneficiaries/${props.id}`}
								className="hover:underline"
							>
								{props.fullName}
							</Link>
						</div>
						{props.relationship && (
							<div className="text-xs text-zinc-500">{props.relationship}</div>
						)}
					</>
				)}
			</td>
			<td className="px-4 py-2 align-top text-zinc-700 dark:text-zinc-300">
				{editing ? (
					<input
						type="date"
						value={dateOfBirth}
						onChange={(e) => setDateOfBirth(e.target.value)}
						disabled={pending}
						className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				) : (
					<>
						<div>{props.dateOfBirth ?? '—'}</div>
						{props.ageYears !== null && (
							<div className="text-xs text-zinc-500">age {props.ageYears}</div>
						)}
					</>
				)}
			</td>
			<td className="px-4 py-2 align-top">{props.eligibility}</td>
			<td className="px-4 py-2 align-top text-right tabular-nums text-zinc-700 dark:text-zinc-300">
				{props.demandNoteCell}
			</td>
			<td className="px-4 py-2 align-top text-right tabular-nums text-zinc-700 dark:text-zinc-300">
				{CURRENCY_FMT.format(props.outstanding)}
				{props.outstandingHint && (
					<div className="text-xs text-amber-700 dark:text-amber-400">owed to trust</div>
				)}
			</td>
			<td className="px-4 py-2 align-top text-right tabular-nums text-zinc-700 dark:text-zinc-300">
				{props.taggedCount > 0 ? (
					<Link
						href={`/trust-beneficiaries/${props.id}`}
						className="text-blue-600 hover:underline dark:text-blue-400"
					>
						{props.taggedCount.toLocaleString()}
					</Link>
				) : (
					props.taggedCount.toLocaleString()
				)}
			</td>
			<td className="px-4 py-2 align-top text-right tabular-nums text-zinc-700 dark:text-zinc-300">
				{CURRENCY_FMT.format(props.k1Ytd)}
				{props.k1Ytd > 0 && (
					<div className="text-xs text-zinc-500">K-1 required at year-end</div>
				)}
			</td>
			<td className="px-4 py-2 align-top text-right">
				{editing ? (
					<div className="flex flex-col items-end gap-1">
						<div className="flex gap-1">
							<button
								type="button"
								onClick={onSave}
								disabled={pending || !fullName.trim()}
								className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
							>
								{pending ? 'Saving…' : 'Save'}
							</button>
							<button
								type="button"
								onClick={onCancel}
								disabled={pending}
								className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
							>
								Cancel
							</button>
						</div>
						{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
					</div>
				) : (
					<button
						type="button"
						onClick={() => setEditing(true)}
						className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
					>
						Edit
					</button>
				)}
			</td>
		</tr>
		</>
	);
}
