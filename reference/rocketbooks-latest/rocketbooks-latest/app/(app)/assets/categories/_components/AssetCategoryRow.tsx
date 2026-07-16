'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
	saveAssetCategory,
	deleteAssetCategory,
} from '../_actions/saveAssetCategory';

export interface AccountOption {
	id: string;
	label: string;
}

export interface CategoryRowData {
	id: string;
	name: string;
	assetAccountId: string;
	accumulatedDepAccountId: string;
	depExpenseAccountId: string;
	defaultMethod: string;
	defaultUsefulLifeMonths: number;
	defaultAutoDepreciate: boolean;
	assetCount: number;
}

interface Props {
	row: CategoryRowData;
	assetAccounts: AccountOption[];
	accumDepAccounts: AccountOption[];
	expenseAccounts: AccountOption[];
}

const METHOD_LABELS: Record<string, string> = {
	straight_line: 'Straight-line',
	declining_balance_150: '150% DB',
	declining_balance_200: '200% DB',
	macrs_gds: 'MACRS GDS',
	macrs_ads: 'MACRS ADS',
};

export function AssetCategoryRow({ row, assetAccounts, accumDepAccounts, expenseAccounts }: Props) {
	const [editing, setEditing] = useState(false);
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [name, setName] = useState(row.name);
	const [assetAccountId, setAssetAccountId] = useState(row.assetAccountId);
	const [accumDepAccountId, setAccumDepAccountId] = useState(row.accumulatedDepAccountId);
	const [depExpenseAccountId, setDepExpenseAccountId] = useState(row.depExpenseAccountId);
	const [method, setMethod] = useState(row.defaultMethod);
	const [useful, setUseful] = useState(String(row.defaultUsefulLifeMonths));
	const [autoDepreciate, setAutoDepreciate] = useState(row.defaultAutoDepreciate);
	const router = useRouter();

	const reset = () => {
		setName(row.name);
		setAssetAccountId(row.assetAccountId);
		setAccumDepAccountId(row.accumulatedDepAccountId);
		setDepExpenseAccountId(row.depExpenseAccountId);
		setMethod(row.defaultMethod);
		setUseful(String(row.defaultUsefulLifeMonths));
		setAutoDepreciate(row.defaultAutoDepreciate);
		setError(null);
	};

	const onSave = () => {
		setError(null);
		startTransition(async () => {
			const r = await saveAssetCategory({
				id: row.id,
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
			setEditing(false);
			router.refresh();
		});
	};

	const onDelete = () => {
		if (!confirm(`Delete category "${row.name}"? Only works if no assets use it.`)) return;
		setError(null);
		startTransition(async () => {
			const r = await deleteAssetCategory({ id: row.id });
			if (!r.ok) {
				setError(r.error ?? 'Failed to delete');
				return;
			}
			router.refresh();
		});
	};

	if (!editing) {
		return (
			<tr className="border-t border-zinc-100 dark:border-zinc-800">
				<td className="px-4 py-2 align-top text-zinc-700 dark:text-zinc-300">
					<div className="font-medium">{row.name}</div>
					<div className="text-xs text-zinc-500">
						{row.assetCount} asset{row.assetCount === 1 ? '' : 's'}
					</div>
				</td>
				<td className="px-4 py-2 align-top text-xs text-zinc-600 dark:text-zinc-400">
					{labelOf(assetAccounts, row.assetAccountId)}
				</td>
				<td className="px-4 py-2 align-top text-xs text-zinc-600 dark:text-zinc-400">
					{labelOf(accumDepAccounts, row.accumulatedDepAccountId)}
				</td>
				<td className="px-4 py-2 align-top text-xs text-zinc-600 dark:text-zinc-400">
					{labelOf(expenseAccounts, row.depExpenseAccountId)}
				</td>
				<td className="px-4 py-2 align-top text-xs text-zinc-600 dark:text-zinc-400">
					{METHOD_LABELS[row.defaultMethod] ?? row.defaultMethod}
				</td>
				<td className="px-4 py-2 align-top text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
					{Math.round(row.defaultUsefulLifeMonths / 12)} yr
				</td>
				<td className="px-4 py-2 align-top text-xs text-zinc-600 dark:text-zinc-400">
					{row.defaultAutoDepreciate ? 'On' : 'Off'}
				</td>
				<td className="px-4 py-2 align-top text-right">
					<div className="flex justify-end gap-1">
						<button
							type="button"
							onClick={() => setEditing(true)}
							className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
						>
							Edit
						</button>
						<button
							type="button"
							onClick={onDelete}
							disabled={pending || row.assetCount > 0}
							title={row.assetCount > 0 ? 'Reassign or dispose linked assets first' : undefined}
							className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-zinc-700 dark:text-rose-300 dark:hover:bg-rose-900/30"
						>
							Delete
						</button>
					</div>
				</td>
			</tr>
		);
	}

	return (
		<tr className="border-t border-zinc-100 bg-blue-50/40 dark:border-zinc-800 dark:bg-blue-900/10">
			<td className="px-4 py-2 align-top" colSpan={8}>
				<div className="grid grid-cols-1 gap-3 md:grid-cols-3">
					<Field label="Name">
						<input
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							maxLength={80}
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
					<Field label="Accumulated depreciation account">
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
					<Field label="Depreciation expense account">
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
							{Object.entries(METHOD_LABELS).map(([k, v]) => (
								<option key={k} value={k}>
									{v}
								</option>
							))}
						</select>
					</Field>
					<Field label="Default useful life (months)">
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
						{pending ? 'Saving…' : 'Save'}
					</button>
					<button
						type="button"
						onClick={() => {
							reset();
							setEditing(false);
						}}
						disabled={pending}
						className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
					>
						Cancel
					</button>
				</div>
			</td>
		</tr>
	);
}

function labelOf(options: AccountOption[], id: string): string {
	const found = options.find((o) => o.id === id);
	return found?.label ?? '—';
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<label className="flex flex-col gap-1">
			<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
			{children}
		</label>
	);
}
