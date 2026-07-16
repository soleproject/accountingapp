'use client';

import { useEffect, useState, useTransition } from 'react';
import { bulk710AssignTrustee } from '../_actions/bulk710AssignTrustee';
import { bulk815AssignTrustee } from '../_actions/bulk815AssignTrustee';
import { Assign710Modal, type PickerOption } from './Assign710Modal';
import type { AssignTrusteeKind, TrusteePick } from './AssignTrusteeButton';

interface Props {
	findingIds: string[];
	trustees: readonly TrusteePick[];
	kind: AssignTrusteeKind;
	onComplete?: (processed: number) => void;
	/** Bubbles network-in-flight state to the group header. */
	onPendingChange?: (pending: boolean) => void;
}

/**
 * Bulk version of AssignTrusteeButton. Routes per `kind`:
 *
 *   710 → bulk710AssignTrustee (supports single + split)
 *   815 → bulk815AssignTrustee (single only)
 */
export function BulkAssignTrusteeButton({ findingIds, trustees, kind, onComplete, onPendingChange }: Props) {
	const [open, setOpen] = useState(false);
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		onPendingChange?.(pending);
	}, [pending, onPendingChange]);

	const supportsSplit = kind === '710';
	const disabled = trustees.length === 0 || pending || findingIds.length === 0;
	const title = trustees.length === 0
		? 'No trustees on file — mark a contact as a trustee on the Contacts page first.'
		: trustees.length === 1
			? `Attribute ${findingIds.length} selected to ${trustees[0].contactName}`
			: supportsSplit
				? `Assign or split ${findingIds.length} selected across ${trustees.length} trustees`
				: `Assign ${findingIds.length} selected to one of ${trustees.length} trustees`;

	const runBulk = async (contactIds: string[]) => {
		if (kind === '710') {
			return await bulk710AssignTrustee({ findingIds, contactIds });
		}
		return await bulk815AssignTrustee({ findingIds, contactIds });
	};

	const onClick = () => {
		if (disabled) return;
		setError(null);
		if (trustees.length === 1) {
			startTransition(async () => {
				const r = await runBulk([trustees[0].id]);
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
				className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-amber-300 bg-amber-50 text-amber-700 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300 dark:hover:bg-amber-900/50"
			>
				{pending ? (
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin" aria-hidden="true">
						<path d="M21 12a9 9 0 11-6.219-8.56" />
					</svg>
				) : (
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
