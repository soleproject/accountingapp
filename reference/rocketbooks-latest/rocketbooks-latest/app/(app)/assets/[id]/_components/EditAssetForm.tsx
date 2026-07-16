'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { updateAsset } from '../../_actions/updateAsset';

interface Props {
	assetId: string;
	initial: {
		name: string;
		assetNumber: string | null;
		serialNumber: string | null;
		location: string | null;
		notes: string | null;
		autoDepreciate: boolean;
	};
}

/**
 * Inline edit form on the asset detail page. Display + auto-depreciate
 * toggle. Financial fields are intentionally read-only here — changing
 * them post-registration would invalidate prior depreciation runs.
 */
export function EditAssetForm({ assetId, initial }: Props) {
	const [editing, setEditing] = useState(false);
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [name, setName] = useState(initial.name);
	const [assetNumber, setAssetNumber] = useState(initial.assetNumber ?? '');
	const [serialNumber, setSerialNumber] = useState(initial.serialNumber ?? '');
	const [location, setLocation] = useState(initial.location ?? '');
	const [notes, setNotes] = useState(initial.notes ?? '');
	const [autoDepreciate, setAutoDepreciate] = useState(initial.autoDepreciate);
	const router = useRouter();

	const onCancel = () => {
		setName(initial.name);
		setAssetNumber(initial.assetNumber ?? '');
		setSerialNumber(initial.serialNumber ?? '');
		setLocation(initial.location ?? '');
		setNotes(initial.notes ?? '');
		setAutoDepreciate(initial.autoDepreciate);
		setError(null);
		setEditing(false);
	};

	const onSave = () => {
		setError(null);
		startTransition(async () => {
			const r = await updateAsset({
				assetId,
				name,
				assetNumber,
				serialNumber,
				location,
				notes,
				autoDepreciate,
			});
			if (!r.ok) {
				setError(r.error ?? 'Failed to save');
				return;
			}
			setEditing(false);
			router.refresh();
		});
	};

	if (!editing) {
		return (
			<button
				type="button"
				onClick={() => setEditing(true)}
				className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
			>
				Edit
			</button>
		);
	}

	return (
		<div className="rounded-lg border border-blue-300 bg-blue-50/40 p-4 dark:border-blue-800 dark:bg-blue-900/20">
			<div className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
				Edit details
			</div>
			<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
				<Field label="Name">
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						required
						maxLength={200}
						className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</Field>
				<Field label="Asset number">
					<input
						type="text"
						value={assetNumber}
						onChange={(e) => setAssetNumber(e.target.value)}
						maxLength={50}
						className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</Field>
				<Field label="Serial number">
					<input
						type="text"
						value={serialNumber}
						onChange={(e) => setSerialNumber(e.target.value)}
						maxLength={100}
						className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</Field>
				<Field label="Location">
					<input
						type="text"
						value={location}
						onChange={(e) => setLocation(e.target.value)}
						maxLength={200}
						className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</Field>
			</div>
			<div className="mt-3">
				<label className="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						checked={autoDepreciate}
						onChange={(e) => setAutoDepreciate(e.target.checked)}
					/>
					Auto-depreciate monthly (when the org cron is enabled)
				</label>
			</div>
			<div className="mt-3">
				<label className="text-xs font-medium uppercase tracking-wide text-zinc-500">
					Notes
				</label>
				<textarea
					rows={3}
					maxLength={2000}
					value={notes}
					onChange={(e) => setNotes(e.target.value)}
					className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
				/>
			</div>
			<p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
				Cost basis, method, and useful life can&rsquo;t be edited after
				registration — those changes would invalidate the beginning-balance
				JE and every depreciation run. Dispose + re-register to make
				financial corrections.
			</p>
			{error && (
				<div className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</div>
			)}
			<div className="mt-3 flex items-center gap-2">
				<button
					type="button"
					onClick={onSave}
					disabled={pending || !name.trim()}
					className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
				>
					{pending ? 'Saving…' : 'Save'}
				</button>
				<button
					type="button"
					onClick={onCancel}
					disabled={pending}
					className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
				>
					Cancel
				</button>
			</div>
		</div>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<label className="flex flex-col gap-1">
			<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
				{label}
			</span>
			{children}
		</label>
	);
}
