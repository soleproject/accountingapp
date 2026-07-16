'use client';

import { useActionState, useState, useTransition } from 'react';
import {
	updateBeneficiaryIncapacitation,
	type UpdateBeneficiaryIncapacitationState,
} from '../_actions/updateBeneficiaryIncapacitation';
import { updateBeneficiary } from '../../_actions/updateBeneficiary';
import { previewBeneficiaryDobChange } from '../../_actions/previewBeneficiaryDobChange';
import { DobCorrectionModal } from '../../_components/DobCorrectionModal';
import type { DobCorrectionDiff } from '@/lib/accounting/trust-dob-correction';

interface Props {
	beneficiaryId: string;
	beneficiaryName: string;
	dateOfBirth: string | null;
	relationship: string | null;
	isIncapacitated: boolean;
	incapacitatedSince: string | null;
	notIncapacitatedSince: string | null;
}

/**
 * Combined editor for a beneficiary's date of birth (left) and incapacitation
 * status (right). DOB writes through the shared updateBeneficiary action;
 * incapacitation goes through its dedicated action so its findings re-eval
 * runs.
 */
export function IncapacitationCard({
	beneficiaryId,
	beneficiaryName,
	dateOfBirth,
	relationship,
	isIncapacitated,
	incapacitatedSince,
	notIncapacitatedSince,
}: Props) {
	return (
		<div className="rounded-xl border border-zinc-400 bg-amber-50 p-4 shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 transition-all hover:shadow-amber-600/60 hover:ring-2 hover:ring-amber-600/70 dark:border-zinc-500 dark:bg-amber-950/20 dark:shadow-black/60 dark:ring-white/10 dark:hover:shadow-amber-500/60 dark:hover:ring-amber-500/60">
			<div className="grid grid-cols-1 gap-6 md:grid-cols-2 md:divide-x md:divide-zinc-300 md:dark:divide-zinc-700">
				<div className="md:pr-6">
					<BirthdayForm
						beneficiaryId={beneficiaryId}
						beneficiaryName={beneficiaryName}
						dateOfBirth={dateOfBirth}
						relationship={relationship}
					/>
				</div>
				<div className="md:pl-6">
					<IncapacitationForm
						beneficiaryId={beneficiaryId}
						beneficiaryName={beneficiaryName}
						isIncapacitated={isIncapacitated}
						incapacitatedSince={incapacitatedSince}
						notIncapacitatedSince={notIncapacitatedSince}
					/>
				</div>
			</div>
		</div>
	);
}

function BirthdayForm({
	beneficiaryId,
	beneficiaryName,
	dateOfBirth,
	relationship,
}: {
	beneficiaryId: string;
	beneficiaryName: string;
	dateOfBirth: string | null;
	relationship: string | null;
}) {
	const [value, setValue] = useState(dateOfBirth ?? '');
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [savedNote, setSavedNote] = useState<string | null>(null);
	const [dobDiff, setDobDiff] = useState<DobCorrectionDiff | null>(null);
	const noChange = value === (dateOfBirth ?? '');

	const onSave = () => {
		setError(null);
		setSavedNote(null);
		const newDob = value.trim();
		if (newDob === (dateOfBirth ?? '').trim()) return;

		startTransition(async () => {
			// Preview first so we can decide between a quiet save (no JEs to
			// rework) and the modal-driven repost flow (existing 815/820/710
			// postings need reversing + reposting against the new DOB).
			const r = await previewBeneficiaryDobChange({
				beneficiaryId,
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
				const fd = new FormData();
				fd.set('beneficiaryId', beneficiaryId);
				fd.set('fullName', beneficiaryName);
				fd.set('dateOfBirth', newDob);
				fd.set('relationship', relationship ?? '');
				const r2 = await updateBeneficiary(undefined, fd);
				if (r2?.error) {
					setError(r2.error);
					return;
				}
				setSavedNote('Saved.');
				return;
			}
			setDobDiff(r.diff);
		});
	};

	return (
		<>
			{dobDiff && (
				<DobCorrectionModal
					diff={dobDiff}
					onCancel={() => setDobDiff(null)}
					onApplied={() => {
						setDobDiff(null);
						setSavedNote('Saved. Demand note and findings updated.');
					}}
				/>
			)}
			<div>
				<div className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
					Date of birth
				</div>
				<p className="mb-3 text-sm text-zinc-700 dark:text-zinc-300">
					{dateOfBirth ? `On file: ${dateOfBirth}.` : 'No date of birth on file.'}
				</p>

				<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
					<label className="flex flex-col gap-1">
						<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
							Date of birth
						</span>
						<input
							type="date"
							value={value}
							onChange={(e) => setValue(e.target.value)}
							disabled={pending}
							className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
						/>
					</label>
					<button
						type="button"
						onClick={onSave}
						disabled={pending || noChange}
						className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
					>
						{pending ? 'Checking…' : noChange ? 'No change' : 'Save'}
					</button>
				</div>

				{error && (
					<div className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</div>
				)}
				{savedNote && (
					<div className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">{savedNote}</div>
				)}

				<p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
					Used by the age-under-21 check on 815/820 postings. If historical JEs
					need to move between food/clothing and the demand note, you&rsquo;ll
					be asked to confirm before any reposts run.
				</p>
			</div>
		</>
	);
}

function IncapacitationForm({
	beneficiaryId,
	beneficiaryName,
	isIncapacitated,
	incapacitatedSince,
	notIncapacitatedSince,
}: {
	beneficiaryId: string;
	beneficiaryName: string;
	isIncapacitated: boolean;
	incapacitatedSince: string | null;
	notIncapacitatedSince: string | null;
}) {
	const [state, action, pending] = useActionState<
		UpdateBeneficiaryIncapacitationState | undefined,
		FormData
	>(updateBeneficiaryIncapacitation, undefined);
	const today = new Date().toISOString().slice(0, 10);
	const [checked, setChecked] = useState(isIncapacitated);

	let statusLine: string;
	if (isIncapacitated && incapacitatedSince) {
		statusLine = `Currently incapacitated since ${incapacitatedSince}.`;
	} else if (isIncapacitated) {
		statusLine = `Currently incapacitated. (No effective date on file — set one below.)`;
	} else if (notIncapacitatedSince && incapacitatedSince) {
		statusLine = `Recovered on ${notIncapacitatedSince}. (Was incapacitated from ${incapacitatedSince}.)`;
	} else {
		statusLine = `Not flagged as incapacitated.`;
	}

	const flipsToOn = checked && !isIncapacitated;
	const flipsToOff = !checked && isIncapacitated;
	const noChange = checked === isIncapacitated;

	return (
		<form action={action}>
			<input type="hidden" name="beneficiaryId" value={beneficiaryId} />
			<div className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
				Incapacitation status
			</div>
			<p className="mb-3 text-sm text-zinc-700 dark:text-zinc-300">{statusLine}</p>

			<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
				<label className="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						name="isIncapacitated"
						checked={checked}
						onChange={(e) => setChecked(e.target.checked)}
					/>{' '}
					{beneficiaryName} is incapacitated
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						{flipsToOn
							? 'Incapacitated since'
							: flipsToOff
								? 'Recovered on'
								: 'Effective date'}
					</span>
					<input
						type="date"
						name="effectiveDate"
						defaultValue={today}
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<button
					type="submit"
					disabled={pending || noChange}
					className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
				>
					{pending ? 'Saving…' : noChange ? 'No change' : 'Save'}
				</button>
			</div>

			{state?.error && (
				<div className="mt-2 text-xs text-red-600 dark:text-red-400">{state.error}</div>
			)}
			{state?.ok && (
				<div className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
					Saved. Open Trust Review to see updated findings.
				</div>
			)}

			<p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
				The effective date is used by the 815/820 qualifying check at posting time —
				historical posts evaluated before this date keep their original eligibility.
			</p>
		</form>
	);
}
