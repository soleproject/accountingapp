'use client';

import { useState, useTransition } from 'react';
import { tagFindingBeneficiary } from '../_actions/tagFindingBeneficiary';

export interface BeneficiaryOption {
	id: string;
	fullName: string;
	qualifies: boolean;
	ageNote: string; // pre-formatted "age 21" / "incapacitated" / "DOB unknown"
}

interface Props {
	findingId: string;
	beneficiaries: BeneficiaryOption[];
	/** When the rule on this account requires a qualifying beneficiary (815/820),
	 *  passing true grays out + tooltip non-qualifying choices in the dropdown. */
	requiresQualifying?: boolean;
}

export function BeneficiaryPickerInline({ findingId, beneficiaries, requiresQualifying }: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [chosen, setChosen] = useState<string>('');

	const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const beneficiaryId = e.target.value;
		setChosen(beneficiaryId);
		if (!beneficiaryId) return;
		setError(null);
		startTransition(async () => {
			const result = await tagFindingBeneficiary({ findingId, beneficiaryId });
			if (!result.ok) {
				setError(result.error ?? 'Failed to tag');
				setChosen('');
			}
			// On success, revalidatePath inside the action refreshes the page —
			// this row will either disappear (resolved) or update its message.
		});
	};

	return (
		<div className="flex flex-col items-end gap-1">
			<select
				value={chosen}
				onChange={onChange}
				disabled={pending}
				className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950"
			>
				<option value="">{pending ? 'Tagging…' : 'Tag beneficiary…'}</option>
				{beneficiaries.map((b) => {
					const disable = !!requiresQualifying && !b.qualifies;
					return (
						<option key={b.id} value={b.id} disabled={disable}>
							{b.fullName} · {b.ageNote}
							{disable ? " · doesn't qualify" : ''}
						</option>
					);
				})}
			</select>
			{error && <span className="text-xs text-red-600">{error}</span>}
		</div>
	);
}
