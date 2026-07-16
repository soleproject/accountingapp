'use client';

import { useEffect, useState, useTransition } from 'react';
import { bulk710AssignBeneficiary } from '../_actions/bulk710AssignBeneficiary';
import { bulk815Or820AssignBeneficiary } from '../_actions/bulk815Or820AssignBeneficiary';
import { Assign710Modal, type PickerOption } from './Assign710Modal';
import type { AssignBeneficiaryKind, BeneficiaryPick } from './AssignBeneficiaryButton';

interface Props {
	findingIds: string[];
	beneficiaries: readonly BeneficiaryPick[];
	kind: AssignBeneficiaryKind;
	/** Fired with the count of successfully-processed findings so the
	 *  parent can clear selection state once the action completes. */
	onComplete?: (processed: number) => void;
	/** Bubbles the network-in-flight state up to the group header so it
	 *  can render a spinner next to the count badge. */
	onPendingChange?: (pending: boolean) => void;
}

/**
 * Bulk version of AssignBeneficiaryButton. Routes to the appropriate
 * server action per `kind`:
 *
 *   710     → bulk710AssignBeneficiary (supports single + split)
 *   815/820 → bulk815Or820AssignBeneficiary (single only)
 */
export function BulkAssignBeneficiaryButton({ findingIds, beneficiaries, kind, onComplete, onPendingChange }: Props) {
	const [open, setOpen] = useState(false);
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	// Bubble our pending state up so FindingGroup can render a spinner
	// alongside the count badge while a bulk action is in flight.
	useEffect(() => {
		onPendingChange?.(pending);
	}, [pending, onPendingChange]);

	const supportsSplit = kind === '710';
	const disabled = beneficiaries.length === 0 || pending || findingIds.length === 0;
	const title = beneficiaries.length === 0
		? 'No beneficiaries on file — add one on the Trust Beneficiaries page.'
		: beneficiaries.length === 1
			? `Tag ${findingIds.length} selected with ${beneficiaries[0].fullName}`
			: supportsSplit
				? `Assign or split ${findingIds.length} selected across ${beneficiaries.length} beneficiaries`
				: `Assign ${findingIds.length} selected to one of ${beneficiaries.length} beneficiaries`;

	const runBulk = async (beneficiaryIds: string[]) => {
		if (kind === '710') {
			return await bulk710AssignBeneficiary({ findingIds, beneficiaryIds });
		}
		return await bulk815Or820AssignBeneficiary({ findingIds, beneficiaryIds });
	};

	const onClick = () => {
		if (disabled) return;
		setError(null);
		if (beneficiaries.length === 1) {
			startTransition(async () => {
				const r = await runBulk([beneficiaries[0].id]);
				if (!r.ok && r.failed.length === 0) {
					setError(r.error ?? 'Failed');
					return;
				}
				if (r.failed.length > 0) {
					setError(`${r.processed} ok, ${r.failed.length} failed`);
				}
				onComplete?.(r.processed);
			});
			return;
		}
		setOpen(true);
	};

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
				className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-violet-300 bg-violet-50 text-violet-700 transition-colors hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-800 dark:bg-violet-900/30 dark:text-violet-300 dark:hover:bg-violet-900/50"
			>
				{pending ? (
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin" aria-hidden="true">
						<path d="M21 12a9 9 0 11-6.219-8.56" />
					</svg>
				) : (
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
					onAssignOne={async (id) => {
						const r = await runBulk([id]);
						if (r.failed.length > 0) {
							return {
								ok: false,
								error: `${r.processed} ok, ${r.failed.length} failed — first error: ${r.failed[0]?.error ?? 'unknown'}`,
							};
						}
						onComplete?.(r.processed);
						return { ok: true };
					}}
					onSplitAll={async (ids) => {
						const r = await runBulk(ids);
						if (r.failed.length > 0) {
							return {
								ok: false,
								error: `${r.processed} ok, ${r.failed.length} failed — first error: ${r.failed[0]?.error ?? 'unknown'}`,
							};
						}
						onComplete?.(r.processed);
						return { ok: true };
					}}
					onClose={() => setOpen(false)}
				/>
			)}
			{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
		</>
	);
}
