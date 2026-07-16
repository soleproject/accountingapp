'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveAssetCategory } from '../_actions/saveAssetCategory';
import type { AccountOption } from './AssetCategoryRow';

interface Props {
	assetAccounts: AccountOption[];
	accumDepAccounts: AccountOption[];
	expenseAccounts: AccountOption[];
}

export function NewAssetCategoryForm({ assetAccounts, accumDepAccounts, expenseAccounts }: Props) {
	const [open, setOpen] = useState(false);
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [name, setName] = useState('');
	const [assetAccountId, setAssetAccountId] = useState(assetAccounts[0]?.id ?? '');
	const [accumDepAccountId, setAccumDepAccountId] = useState(accumDepAccounts[0]?.id ?? '');
	const [depExpenseAccountId, setDepExpenseAccountId] = useState(expenseAccounts[0]?.id ?? '');
	const [method, setMethod] = useState('straight_line');
	const [useful, setUseful] = useState('60');
	const [autoDepreciate, setAutoDepreciate] = useState(false);
	const router = useRouter();

	const onSave = () => {
		setError(null);
		startTransition(async () => {
			const r = await saveAssetCategory({
				name,
				assetAccountId,
				accumulatedDepAccountId: accumDepAccountId,
				depExpenseAccountId,
				defaultMethod: method as 'straight_line' | 'declining_balance_150' | 'declining_balance_200' | 'macrs_gds' | 'macrs_ads',
				defaultUsefulLifeMonths: Number(useful),
				defaultAutoDepreciate: autoDepreciate,
			});
			if (!r.ok) {
				setError(r.error ?? 'Failed to save');
				return;
			}
			setOpen(false);
			setName('');
			setUseful('60');
			setAutoDepreciate(false);
			router.refresh();
		});
	};

	if (!open) {
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
			>
				+ New category
			</button>
		);
	}

	return (
		<div className="rounded-lg border border-blue-300 bg-blue-50/40 p-4 dark:border-blue-800 dark:bg-blue-900/20">
			<div className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
				New category
			</div>
			<div className="grid grid-cols-1 gap-3 md:grid-cols-3">
				<Field label="Name">
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						maxLength={80}
						placeholder="Real Estate"
						className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</Field>
				<Field label="Asset account">
					<select
						value={assetAccountId}
						onChange={(e) => setAssetAccountId(e.target.value)}
						className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					>
						{assetAccounts.map((a) => (
							<option key={a.id} value={a.id}>
								{a.label}
							</option>
						))}
					</select>
				</Field>
				<Field label="Accumulated depreciation">
					<select
						value={accumDepAccountId}
						onChange={(e) => setAccumDepAccountId(e.target.value)}
						className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					>
						{accumDepAccounts.map((a) => (
							<option key={a.id} value={a.id}>
								{a.label}
							</option>
						))}
					</select>
				</Field>
				<Field label="Depreciation expense">
					<select
						value={depExpenseAccountId}
						onChange={(e) => setDepExpenseAccountId(e.target.value)}
						className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					>
						{expenseAccounts.map((a) => (
							<option key={a.id} value={a.id}>
								{a.label}
							</option>
						))}
					</select>
				</Field>
				<Field label="Default method">
					<select
						value={method}
						onChange={(e) => setMethod(e.target.value)}
						className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					>
						<option value="straight_line">Straight-line</option>
						<option value="declining_balance_150">150% DB</option>
						<option value="declining_balance_200">200% DB</option>
						<option value="macrs_gds">MACRS GDS</option>
						<option value="macrs_ads">MACRS ADS</option>
					</select>
				</Field>
				<Field label="Useful life (months)">
					<input
						type="number"
						min="1"
						step="1"
						value={useful}
						onChange={(e) => setUseful(e.target.value)}
						className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-right tabular-nums text-sm dark:border-zinc-700 dark:bg-zinc-900"
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
					Default new assets in this category to auto-depreciate
				</label>
			</div>
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
					{pending ? 'Saving…' : 'Create'}
				</button>
				<button
					type="button"
					onClick={() => {
						setOpen(false);
						setName('');
						setError(null);
					}}
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
			<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
			{children}
		</label>
	);
}
