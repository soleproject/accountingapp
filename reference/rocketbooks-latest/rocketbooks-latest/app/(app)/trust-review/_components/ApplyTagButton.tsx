'use client';

import { useState, useTransition } from 'react';
import { applyTagFromFinding } from '../_actions/applyTagFromFinding';

/** Tag entity_type — any non-empty slug (system or user-defined). */
export type TagEntityType = string;

export interface TagOption {
	id: string;
	label: string;
	subLabel?: string;
}

export interface DimensionRender {
	entityType: TagEntityType;
	label: string;
	shortLabel: string;
	emoji: string;
	options: TagOption[];
}

interface SuggestedProps {
	mode: 'suggested';
	findingId: string;
	suggestionLabel: string;
}

interface PickerProps {
	mode: 'picker';
	findingId: string;
	dimensions: DimensionRender[];
}

type Props = SuggestedProps | PickerProps;

/**
 * Resolution button for the tag-memory findings.
 *
 *   mode='suggested' → TRUST_TAG_SUGGESTED — one-click apply (tags
 *                       come from finding.metadata).
 *   mode='picker'    → TRUST_PROPERTY_EXPENSE_UNTAGGED — opens an
 *                       inline picker with one dropdown per dimension.
 *                       Generic over dimensions.
 */
export function ApplyTagButton(props: Props) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [picks, setPicks] = useState<Record<string, string>>({});

	if (props.mode === 'suggested') {
		const apply = () => {
			setError(null);
			startTransition(async () => {
				const r = await applyTagFromFinding({ findingId: props.findingId, tags: [] });
				if (!r.ok) setError(r.error ?? 'Failed to apply');
			});
		};
		return (
			<div className="flex flex-col items-end gap-1">
				<button
					type="button"
					onClick={apply}
					disabled={pending}
					title={`Apply ${props.suggestionLabel}`}
					className="flex h-7 items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2 text-xs text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200 dark:hover:bg-emerald-900/50"
				>
					{pending ? '…' : '✓ Apply suggestion'}
				</button>
				{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
			</div>
		);
	}

	const { dimensions, findingId } = props;
	const dimensionsWithOptions = dimensions.filter((d) => d.options.length > 0);
	if (dimensionsWithOptions.length === 0) {
		return (
			<a
				href="/rental-properties/new"
				className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
				title="Create a rental property or asset first"
			>
				🏷 + property
			</a>
		);
	}

	const submit = () => {
		const tags = Object.entries(picks)
			.filter(([, v]) => !!v)
			.map(([entityType, entityId]) => ({
				entityType: entityType as TagEntityType,
				entityId,
			}));
		if (tags.length === 0) {
			setError('Pick at least one tag');
			return;
		}
		setError(null);
		startTransition(async () => {
			const r = await applyTagFromFinding({ findingId, tags });
			if (!r.ok) setError(r.error ?? 'Failed to apply');
		});
	};

	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				onClick={() => setPickerOpen((v) => !v)}
				disabled={pending}
				title="Tag this expense"
				className="flex h-7 items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
			>
				🏷 Tag
			</button>
			{pickerOpen && (
				<div className="flex flex-wrap items-center gap-1 rounded-md border border-zinc-300 bg-white p-1 dark:border-zinc-700 dark:bg-zinc-900">
					{dimensionsWithOptions.map((d) => (
						<select
							key={d.entityType}
							value={picks[d.entityType] ?? ''}
							onChange={(e) =>
								setPicks((p) => ({ ...p, [d.entityType]: e.target.value }))
							}
							disabled={pending}
							className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
						>
							<option value="">
								— {d.emoji} {d.shortLabel.toLowerCase()} —
							</option>
							{d.options.map((o) => (
								<option key={o.id} value={o.id}>
									{o.label}
								</option>
							))}
						</select>
					))}
					<button
						type="button"
						onClick={submit}
						disabled={pending}
						className="rounded-md bg-zinc-900 px-2 py-0.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
					>
						{pending ? '…' : 'Apply'}
					</button>
				</div>
			)}
			{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
		</div>
	);
}
