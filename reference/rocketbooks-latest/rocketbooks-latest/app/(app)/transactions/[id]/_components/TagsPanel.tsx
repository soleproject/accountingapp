'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { tagJournalLines } from '../_actions/tagJournalLines';

/** Tag entity_type — any non-empty slug (system or user-defined).
 *  Client component can't import 'server-only' modules so the type is
 *  re-declared here. */
export type TagEntityType = string;

export interface TagOption {
	id: string;
	label: string;
	subLabel?: string;
}

export interface TagDimensionRender {
	entityType: TagEntityType;
	label: string;
	emoji: string;
	options: TagOption[];
	/** Currently-set entityId on this JE for this dimension (or null). */
	currentId: string | null;
	/** Pre-computed URL for the "Open entity →" link when currentId is
	 *  set. Computed server-side because functions can't cross the
	 *  server→client boundary. */
	currentDetailHref: string | null;
}

interface Props {
	journalEntryId: string;
	bankAccountId: string;
	dimensions: TagDimensionRender[];
}

const selectCls =
	'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-blue-500 dark:focus:ring-blue-900/50';

/**
 * Single-dropdown Tags panel. Options are grouped by dimension via
 * <optgroup> so all dimensions live in one picker. Picking an option
 * stages a tag for that dimension (replacing any existing one — a
 * line can carry at most one tag per dimension). Currently-applied
 * tags render as chips below the picker, each with × to remove. Save
 * commits the diff in one round-trip.
 */
export function TagsPanel({ journalEntryId, bankAccountId, dimensions }: Props) {
	const router = useRouter();

	const initialApplied: Record<string, string> = {};
	for (const d of dimensions) {
		if (d.currentId) initialApplied[d.entityType] = d.currentId;
	}
	const [applied, setApplied] = useState<Record<string, string>>(initialApplied);
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	const dimensionsWithOptions = dimensions.filter((d) => d.options.length > 0);
	if (dimensionsWithOptions.length === 0) return null;

	// Diff applied (working state) against currentId per dimension.
	const dirtyEntries = dimensions
		.map((d) => ({
			dim: d,
			newId: applied[d.entityType] ?? null,
			oldId: d.currentId ?? null,
		}))
		.filter((e) => e.newId !== e.oldId);
	const dirty = dirtyEntries.length > 0;
	const appliedCount = Object.values(applied).filter(Boolean).length;

	const addTag = (composite: string) => {
		// Composite is "entityType::entityId" — encodes which dimension
		// the picked option belongs to. Cleaner than a parallel lookup
		// because <option value> is the only payload <select> gives us.
		if (!composite) return;
		const sep = composite.indexOf('::');
		if (sep < 0) return;
		const entityType = composite.slice(0, sep);
		const entityId = composite.slice(sep + 2);
		setApplied((p) => ({ ...p, [entityType]: entityId }));
		setSaved(false);
	};

	const removeTag = (entityType: string) => {
		setApplied((p) => {
			const next = { ...p };
			delete next[entityType];
			return next;
		});
		setSaved(false);
	};

	const save = () => {
		setError(null);
		setSaved(false);
		startTransition(async () => {
			const tags = dirtyEntries.map((e) => ({
				entityType: e.dim.entityType,
				entityId: e.newId, // null clears the dimension
			}));
			const r = await tagJournalLines({ journalEntryId, bankAccountId, tags });
			if (!r.ok) {
				setError(r.error ?? 'Failed to save');
				return;
			}
			setSaved(true);
			router.refresh();
		});
	};

	const renderedChips = dimensions
		.filter((d) => applied[d.entityType])
		.map((d) => {
			const entityId = applied[d.entityType];
			const opt = d.options.find((o) => o.id === entityId);
			const label = opt?.label ?? `${d.label} ${entityId.slice(0, 8)}`;
			const wasOriginal = d.currentId === entityId;
			return (
				<Chip
					key={d.entityType}
					emoji={d.emoji}
					dimensionLabel={d.label}
					valueLabel={label}
					href={wasOriginal ? d.currentDetailHref : null}
					onRemove={() => removeTag(d.entityType)}
				/>
			);
		});

	return (
		<div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
			<div className="mb-2 flex items-center justify-between gap-2">
				<h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">Tags</h2>
				{appliedCount > 0 && (
					<span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
						{appliedCount} tagged
					</span>
				)}
			</div>
			<p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
				Attribute this transaction&rsquo;s category lines for per-dimension
				rollups. Pick a tag from any dimension below. Bank-side line is
				untouched.
			</p>

			<select
				value=""
				onChange={(e) => addTag(e.target.value)}
				className={`${selectCls} w-full`}
			>
				<option value="">+ Add a tag…</option>
				{dimensionsWithOptions.map((d) => (
					<optgroup key={d.entityType} label={`${d.emoji}  ${d.label}`}>
						{d.options.map((o) => (
							<option key={o.id} value={`${d.entityType}::${o.id}`}>
								{o.label}
								{o.subLabel ? ` (${o.subLabel})` : ''}
							</option>
						))}
					</optgroup>
				))}
			</select>

			{renderedChips.length > 0 && (
				<div className="mt-3 flex flex-wrap gap-1.5">{renderedChips}</div>
			)}

			<div className="mt-3 flex items-center gap-2">
				<button
					type="button"
					onClick={save}
					disabled={pending || !dirty}
					className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
				>
					{pending ? 'Saving…' : 'Save tags'}
				</button>
				{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
				{saved && !dirty && (
					<span className="text-xs text-emerald-600 dark:text-emerald-400">Saved.</span>
				)}
			</div>
		</div>
	);
}

function Chip({
	emoji,
	dimensionLabel,
	valueLabel,
	href,
	onRemove,
}: {
	emoji: string;
	dimensionLabel: string;
	valueLabel: string;
	href: string | null;
	onRemove: () => void;
}) {
	const inner = (
		<>
			<span aria-hidden>{emoji}</span>
			<span className="text-zinc-500 dark:text-zinc-400">{dimensionLabel}:</span>
			<span className="font-medium text-zinc-700 dark:text-zinc-200">{valueLabel}</span>
		</>
	);
	return (
		<span className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900">
			{href ? (
				<Link href={href} className="inline-flex items-center gap-1 hover:underline">
					{inner}
				</Link>
			) : (
				<span className="inline-flex items-center gap-1">{inner}</span>
			)}
			<button
				type="button"
				onClick={onRemove}
				title={`Remove ${dimensionLabel}`}
				aria-label={`Remove ${dimensionLabel}`}
				className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
			>
				<svg viewBox="0 0 12 12" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
					<line x1="2" y1="2" x2="10" y2="10" />
					<line x1="10" y1="2" x2="2" y2="10" />
				</svg>
			</button>
		</span>
	);
}
