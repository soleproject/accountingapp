'use client';

import { useState, useTransition } from 'react';
import { reroute710ToBeneficiary } from '../_actions/reroute710ToBeneficiary';
import { split710ByBeneficiaries } from '../_actions/split710ByBeneficiaries';
import { reassign815Or820Beneficiary } from '../_actions/reassign815Or820Beneficiary';
import { Assign710Modal, type PickerOption } from './Assign710Modal';

export interface BeneficiaryPick {
	id: string;
	fullName: string;
	/** Pre-formatted age / status note for the sublabel. */
	ageNote: string;
}

/**
 * Which finding family this button is acting on — selects the right
 * server action under the hood. UX is identical across kinds; only the
 * 710 path supports split-evenly (the 815/820 path is single-pick only).
 */
export type AssignBeneficiaryKind = '710' | '815' | '820';

interface Props {
	findingId: string;
	beneficiaries: readonly BeneficiaryPick[];
	kind: AssignBeneficiaryKind;
}

/**
 * Per-row "Assign beneficiary" icon for the food/clothing/M&E groups
 * (710, 815, 820). Behavior:
 *
 *   0 benes  → disabled, tooltip explains.
 *   1 bene   → single-click runs the right server action directly.
 *   2+ benes → opens Assign710Modal; the user picks one (all kinds) or
 *              splits evenly (710 only).
 *
 * Renders as the same 28×28 colored icon convention as Add Receipt /
 * Dismiss.
 */
export function AssignBeneficiaryButton({ findingId, beneficiaries, kind }: Props) {
	const [open, setOpen] = useState(false);
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);

	const supportsSplit = kind === '710';
	const disabled = beneficiaries.length === 0 || pending;
	const title = beneficiaries.length === 0
		? 'No beneficiaries on file — add one on the Trust Beneficiaries page.'
		: beneficiaries.length === 1
			? `Tag ${beneficiaries[0].fullName} as the beneficiary`
			: supportsSplit
				? `Assign or split between ${beneficiaries.length} beneficiaries`
				: `Assign one of ${beneficiaries.length} beneficiaries`;

	const assignOne = async (beneficiaryId: string) => {
		if (kind === '710') {
			return await reroute710ToBeneficiary({ findingId, beneficiaryId });
		}
		return await reassign815Or820Beneficiary({ findingId, beneficiaryId });
	};

	const onClick = () => {
		if (disabled) return;
		setError(null);
		if (beneficiaries.length === 1) {
			startTransition(async () => {
				const r = await assignOne(beneficiaries[0].id);
				if (!r.ok) setError(r.error ?? 'Failed to reroute');
				else setSuccess(true);
			});
			return;
		}
		setOpen(true);
	};

	const colorCls = success
		? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50'
		: 'border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-900/30 dark:text-violet-300 dark:hover:bg-violet-900/50';

	const options: PickerOption[] = beneficiaries.map((b) => ({
		id: b.id,
		label: b.fullName,
		sublabel: b.ageNote,
	}));

	return (
		<>
			<button
				type="button"
				onClick={onClick}
				disabled={disabled}
				title={title}
				aria-label={title}
				className={`inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${colorCls}`}
			>
				{pending ? (
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin" aria-hidden="true">
						<path d="M21 12a9 9 0 11-6.219-8.56" />
					</svg>
				) : success ? (
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<polyline points="20 6 9 17 4 12" />
					</svg>
				) : (
					// Person-heart-ish icon — "beneficiary"
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<circle cx="9" cy="7" r="4" />
						<path d="M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" />
						<path d="M19 13l1.5 1.5L22 13l-1.5 3-1.5-3z" />
					</svg>
				)}
			</button>
			{open && (
				<Assign710Modal
					mode="beneficiary"
					options={options}
					supportsSplit={supportsSplit}
					onAssignOne={(id) =>
						assignOne(id).then((r) => {
							if (r.ok) setSuccess(true);
							return r;
						})
					}
					onSplitAll={(ids) =>
						split710ByBeneficiaries({ findingId, beneficiaryIds: ids }).then((r) => {
							if (r.ok) setSuccess(true);
							return r;
						})
					}
					onClose={() => setOpen(false)}
				/>
			)}
			{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
		</>
	);
}
