'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
	createDimensionValue,
	deleteDimension,
	renameDimensionValue,
	setValueArchived,
	updateDimension,
} from '../_actions/dimensionActions';

export interface UserDimensionValueRow {
	id: string;
	label: string;
	archived: boolean;
}

export interface UserDimensionRow {
	id: string;
	slug: string;
	label: string;
	emoji: string | null;
	values: UserDimensionValueRow[];
}

const inputCls =
	'rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-blue-500 dark:focus:ring-blue-900/50';

interface Props {
	dimension: UserDimensionRow;
}

/**
 * One card per user-defined dimension: inline edit of label/emoji,
 * value list with rename/archive, "Add value" form, delete.
 */
export function UserDimensionCard({ dimension }: Props) {
	const router = useRouter();
	const [editing, setEditing] = useState(false);
	const [label, setLabel] = useState(dimension.label);
	const [emoji, setEmoji] = useState(dimension.emoji ?? '🏷');
	const [error, setError] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();

	const [newValue, setNewValue] = useState('');
	const [showArchived, setShowArchived] = useState(false);

	const active = dimension.values.filter((v) => !v.archived);
	const archived = dimension.values.filter((v) => v.archived);

	const saveDimension = () => {
		setError(null);
		startTransition(async () => {
			const r = await updateDimension({
				dimensionId: dimension.id,
				label,
				emoji,
			});
			if (!r.ok) {
				setError(r.error ?? 'Failed');
				return;
			}
			setEditing(false);
			router.refresh();
		});
	};

	const remove = () => {
		const ok = window.confirm(
			`Delete dimension "${dimension.label}"? This is blocked if any JE lines still carry tags from it.`,
		);
		if (!ok) return;
		setError(null);
		startTransition(async () => {
			const r = await deleteDimension({ dimensionId: dimension.id });
			if (!r.ok) {
				setError(r.error ?? 'Failed');
				return;
			}
			router.refresh();
		});
	};

	const addValue = () => {
		if (!newValue.trim()) return;
		setError(null);
		startTransition(async () => {
			const r = await createDimensionValue({
				dimensionId: dimension.id,
				label: newValue,
			});
			if (!r.ok) {
				setError(r.error ?? 'Failed');
				return;
			}
			setNewValue('');
			router.refresh();
		});
	};

	return (
		<div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
			<header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
				{editing ? (
					<div className="flex flex-wrap items-end gap-2">
						<input
							type="text"
							value={emoji}
							onChange={(e) => setEmoji(e.target.value.slice(0, 4))}
							className={`${inputCls} w-14 text-center`}
						/>
						<input
							type="text"
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							className={inputCls}
						/>
						<button
							type="button"
							onClick={saveDimension}
							disabled={pending}
							className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
						>
							Save
						</button>
						<button
							type="button"
							onClick={() => {
								setEditing(false);
								setLabel(dimension.label);
								setEmoji(dimension.emoji ?? '🏷');
							}}
							className="text-xs text-zinc-500 underline-offset-2 hover:underline"
						>
							Cancel
						</button>
					</div>
				) : (
					<div className="flex items-center gap-3">
						<h3 className="text-base font-medium">
							<span aria-hidden>{dimension.emoji ?? '🏷'}</span> {dimension.label}
						</h3>
						<code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800">
							{dimension.slug}
						</code>
						<span className="text-xs text-zinc-500">
							{active.length} {active.length === 1 ? 'value' : 'values'}
							{archived.length > 0 && (
								<> · {archived.length} archived</>
							)}
						</span>
					</div>
				)}
				{!editing && (
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => setEditing(true)}
							className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
						>
							Edit
						</button>
						<button
							type="button"
							onClick={remove}
							disabled={pending}
							className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-950/30"
						>
							Delete
						</button>
					</div>
				)}
			</header>

			<div className="flex flex-col gap-1 px-4 py-3">
				{active.length === 0 && (
					<div className="text-sm text-zinc-500">No active values. Add one below.</div>
				)}
				{active.map((v) => (
					<ValueRow key={v.id} value={v} />
				))}
				{showArchived && archived.length > 0 && (
					<>
						<div className="mt-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
							Archived
						</div>
						{archived.map((v) => (
							<ValueRow key={v.id} value={v} />
						))}
					</>
				)}
			</div>

			<div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
				<input
					type="text"
					value={newValue}
					onChange={(e) => setNewValue(e.target.value)}
					placeholder="Add a value…"
					className={`${inputCls} flex-1 min-w-[10rem]`}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							addValue();
						}
					}}
				/>
				<button
					type="button"
					onClick={addValue}
					disabled={pending || !newValue.trim()}
					className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
				>
					+ Add value
				</button>
				{archived.length > 0 && (
					<button
						type="button"
						onClick={() => setShowArchived((v) => !v)}
						className="text-xs text-zinc-500 underline-offset-2 hover:underline"
					>
						{showArchived ? 'hide archived' : `show archived (${archived.length})`}
					</button>
				)}
			</div>
			{error && (
				<div className="border-t border-zinc-100 px-4 py-2 text-xs text-red-600 dark:border-zinc-800 dark:text-red-400">
					{error}
				</div>
			)}
		</div>
	);
}

function ValueRow({ value }: { value: UserDimensionValueRow }) {
	const router = useRouter();
	const [editing, setEditing] = useState(false);
	const [label, setLabel] = useState(value.label);
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const save = () => {
		setError(null);
		startTransition(async () => {
			const r = await renameDimensionValue({ valueId: value.id, label });
			if (!r.ok) {
				setError(r.error ?? 'Failed');
				return;
			}
			setEditing(false);
			router.refresh();
		});
	};

	const toggleArchived = () => {
		setError(null);
		startTransition(async () => {
			const r = await setValueArchived({ valueId: value.id, archived: !value.archived });
			if (!r.ok) {
				setError(r.error ?? 'Failed');
				return;
			}
			router.refresh();
		});
	};

	return (
		<div className="flex items-center justify-between gap-2 py-0.5">
			{editing ? (
				<>
					<input
						type="text"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						className={`${inputCls} flex-1 min-w-[8rem]`}
						autoFocus
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								save();
							}
							if (e.key === 'Escape') {
								setEditing(false);
								setLabel(value.label);
							}
						}}
					/>
					<button
						type="button"
						onClick={save}
						disabled={pending}
						className="text-xs font-medium text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
					>
						Save
					</button>
					<button
						type="button"
						onClick={() => {
							setEditing(false);
							setLabel(value.label);
						}}
						className="text-xs text-zinc-500 underline-offset-2 hover:underline"
					>
						Cancel
					</button>
				</>
			) : (
				<>
					<span
						className={`flex-1 text-sm ${
							value.archived ? 'text-zinc-400 line-through' : 'text-zinc-700 dark:text-zinc-300'
						}`}
					>
						{value.label}
					</span>
					<button
						type="button"
						onClick={() => setEditing(true)}
						disabled={pending}
						className="text-xs text-zinc-500 underline-offset-2 hover:underline"
					>
						rename
					</button>
					<button
						type="button"
						onClick={toggleArchived}
						disabled={pending}
						className="text-xs text-zinc-500 underline-offset-2 hover:underline"
					>
						{value.archived ? 'unarchive' : 'archive'}
					</button>
				</>
			)}
			{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
		</div>
	);
}
