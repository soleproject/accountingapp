'use client';

import { useState, useTransition } from 'react';
import { tagFindingTrusteeContact } from '../_actions/tagFindingTrusteeContact';
import { split710ByTrustees } from '../_actions/split710ByTrustees';
import { reroute815ToTrustee } from '../_actions/reroute815ToTrustee';
import { Assign710Modal, type PickerOption } from './Assign710Modal';

export interface TrusteePick {
	id: string;
	contactName: string;
}

/**
 * Which finding family this trustee action targets. 820 is intentionally
 * absent — clothing-to-trustee makes no narrative sense.
 *   710 → in-place / reverse+repost to 710 (admin meal); supports split.
 *   815 → reverse the 815 (or 26x) line and repost on 710 with trustee
 *         tag (recovery from "actually a trustee meal, not bene food").
 */
export type AssignTrusteeKind = '710' | '815';

interface Props {
	findingId: string;
	trustees: readonly TrusteePick[];
	kind: AssignTrusteeKind;
}

/**
 * Per-row "Assign trustee" icon for the 710/815 groups. Same shape as
 * AssignBeneficiaryButton:
 *
 *   0  → button disabled, tooltip points the user at the contacts page
 *        to mark someone as a trustee.
 *   1  → single-click runs the right server action directly.
 *   2+ → opens Assign710Modal so the user picks one (all kinds) or
 *        splits evenly (710 only).
 */
export function AssignTrusteeButton({ findingId, trustees, kind }: Props) {
	const [open, setOpen] = useState(false);
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);

	const supportsSplit = kind === '710';
	const disabled = trustees.length === 0 || pending;
	const title = trustees.length === 0
		? 'No trustees on file — mark a contact as a trustee on the Contacts page first.'
		: trustees.length === 1
			? `Attribute to ${trustees[0].contactName}`
			: supportsSplit
				? `Assign or split between ${trustees.length} trustees`
				: `Assign one of ${trustees.length} trustees`;

	const assignOne = async (contactId: string) => {
		if (kind === '710') {
			return await tagFindingTrusteeContact({ findingId, contactId });
		}
		return await reroute815ToTrustee({ findingId, contactId });
	};

	const onClick = () => {
		if (disabled) return;
		setError(null);
		if (trustees.length === 1) {
			startTransition(async () => {
				const r = await assignOne(trustees[0].id);
				if (!r.ok) setError(r.error ?? 'Failed to attribute trustee');
				else setSuccess(true);
			});
			return;
		}
		setOpen(true);
	};

	const colorCls = success
		? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50'
		: 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300 dark:hover:bg-amber-900/50';

	const options: PickerOption[] = trustees.map((t) => ({
		id: t.id,
		label: t.contactName,
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
					// Shield-with-check — "trustee" (fiduciary stewardship)
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
						<polyline points="9 12 11 14 15 10" />
					</svg>
				)}
			</button>
			{open && (
				<Assign710Modal
					mode="trustee"
					options={options}
					supportsSplit={supportsSplit}
					onAssignOne={(id) =>
						assignOne(id).then((r) => {
							if (r.ok) setSuccess(true);
							return r;
						})
					}
					onSplitAll={(ids) =>
						split710ByTrustees({ findingId, contactIds: ids }).then((r) => {
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
