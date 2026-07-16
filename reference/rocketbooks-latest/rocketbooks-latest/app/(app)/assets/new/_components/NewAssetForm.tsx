'use client';

import { useActionState, useState } from 'react';
import {
	createAsset,
	type CreateAssetState,
} from '../../_actions/createAsset';

export interface CategoryOption {
	id: string;
	name: string;
	defaultMethod: string;
	defaultUsefulLifeMonths: number;
	defaultAutoDepreciate: boolean;
}

interface Props {
	categories: CategoryOption[];
	/** Existing assets that could be the `replaced_asset_id` for a 1031
	 *  exchange, or the parent for a cost-segregation child. Trimmed to
	 *  id + name for the dropdown. */
	activeAssets: Array<{ id: string; name: string }>;
}

const inputClass =
	'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900';
const labelClass = 'text-xs font-medium uppercase tracking-wide text-zinc-500';

/**
 * Asset registration form. Branches on acquisition type:
 *
 *   purchased       → cost basis is the GL hit. Beginning-balance JE
 *                     debits the category's asset account, credits Trust
 *                     Corpus.
 *   inherited       → fmv_at_dod replaces cost_basis as the depreciable
 *                     basis (stepped-up basis). Original cost is also
 *                     captured for the audit trail.
 *   exchanged_1031  → carry-over basis + excess basis split. Replaced-
 *                     asset dropdown limits to other assets on this org.
 *   contributed     → cost basis posts to Trust Corpus as a non-cash
 *                     contribution from the grantor / donor.
 *
 * Prior accumulated depreciation lets the user migrate an in-flight
 * asset from another bookkeeping tool with the correct book value.
 */
export function NewAssetForm({ categories, activeAssets }: Props) {
	const [state, action, pending] = useActionState<CreateAssetState | undefined, FormData>(
		createAsset,
		undefined,
	);

	const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
	const [acquisitionType, setAcquisitionType] = useState<
		'purchased' | 'inherited' | 'exchanged_1031' | 'contributed'
	>('purchased');

	const selectedCategory = categories.find((c) => c.id === categoryId);

	return (
		<form
			action={action}
			className="flex max-w-3xl flex-col gap-5 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950"
		>
			<section className="grid grid-cols-1 gap-4 md:grid-cols-2">
				<Field label="Category" required>
					<select
						name="categoryId"
						value={categoryId}
						onChange={(e) => setCategoryId(e.target.value)}
						required
						className={inputClass}
					>
						{categories.map((c) => (
							<option key={c.id} value={c.id}>
								{c.name}
							</option>
						))}
					</select>
					{selectedCategory && (
						<div className="text-[10px] text-zinc-500">
							Default: {selectedCategory.defaultMethod.replace('_', ' ')} ·{' '}
							{Math.round(selectedCategory.defaultUsefulLifeMonths / 12)} yr life
						</div>
					)}
				</Field>
				<Field label="Acquisition type" required>
					<select
						name="acquisitionType"
						value={acquisitionType}
						onChange={(e) =>
							setAcquisitionType(
								e.target.value as 'purchased' | 'inherited' | 'exchanged_1031' | 'contributed',
							)
						}
						className={inputClass}
					>
						<option value="purchased">Purchased</option>
						<option value="inherited">Inherited (stepped-up basis)</option>
						<option value="exchanged_1031">§1031 like-kind exchange</option>
						<option value="contributed">Contributed (non-cash)</option>
					</select>
				</Field>

				<Field label="Name" required className="md:col-span-2">
					<input type="text" name="name" required maxLength={200} className={inputClass} />
				</Field>

				<Field label="Asset number (optional)">
					<input type="text" name="assetNumber" maxLength={50} className={inputClass} placeholder="A-001" />
				</Field>
				<Field label="Serial number (optional)">
					<input type="text" name="serialNumber" maxLength={100} className={inputClass} />
				</Field>
				<Field label="Location (optional)" className="md:col-span-2">
					<input type="text" name="location" maxLength={200} className={inputClass} placeholder="1234 Main St, Unit B" />
				</Field>
			</section>

			<section className="grid grid-cols-1 gap-4 md:grid-cols-2">
				<Field label="In-service date" required>
					<input type="date" name="inServiceDate" required className={inputClass} />
				</Field>
				<Field label="Cost basis (original)" required>
					<input
						type="number"
						name="costBasis"
						required
						min="0"
						step="0.01"
						className={`${inputClass} text-right tabular-nums`}
					/>
				</Field>

				{acquisitionType === 'inherited' && (
					<>
						<Field label="FMV at date of death" required>
							<input
								type="number"
								name="fmvAtDod"
								required
								min="0"
								step="0.01"
								className={`${inputClass} text-right tabular-nums`}
							/>
							<div className="text-[10px] text-zinc-500">
								Stepped-up basis. Replaces cost basis for depreciation.
							</div>
						</Field>
						<Field label="Alternate valuation date (optional)">
							<input type="date" name="alternateValuationDate" className={inputClass} />
							<div className="text-[10px] text-zinc-500">If estate elected AVD (6 mo after DOD).</div>
						</Field>
					</>
				)}

				{acquisitionType === 'exchanged_1031' && (
					<>
						<Field label="Replaced asset">
							<select name="replacedAssetId" className={inputClass}>
								<option value="">— none —</option>
								{activeAssets.map((a) => (
									<option key={a.id} value={a.id}>
										{a.name}
									</option>
								))}
							</select>
						</Field>
						<Field label="Carryover basis">
							<input
								type="number"
								name="carryoverBasis"
								min="0"
								step="0.01"
								className={`${inputClass} text-right tabular-nums`}
							/>
						</Field>
						<Field label="Excess basis (boot paid)">
							<input
								type="number"
								name="excessBasis"
								min="0"
								step="0.01"
								className={`${inputClass} text-right tabular-nums`}
							/>
						</Field>
					</>
				)}

				<Field label="Salvage value">
					<input
						type="number"
						name="salvageValue"
						min="0"
						step="0.01"
						defaultValue="0"
						autoComplete="off"
						className={`${inputClass} text-right tabular-nums`}
					/>
					<div className="text-[10px] text-zinc-500">
						Estimated residual value at end of life. Usually 0 for trust
						personal property.
					</div>
				</Field>

				<Field label="Parent asset (cost-seg child only)">
					<select name="parentAssetId" className={inputClass}>
						<option value="">— top-level asset —</option>
						{activeAssets.map((a) => (
							<option key={a.id} value={a.id}>
								{a.name}
							</option>
						))}
					</select>
				</Field>
			</section>

			<section className="grid grid-cols-1 gap-4 md:grid-cols-3">
				<Field label="Depreciation method" required>
					<select
						name="method"
						defaultValue={selectedCategory?.defaultMethod ?? 'straight_line'}
						className={inputClass}
					>
						<option value="straight_line">Straight-line</option>
						<option value="declining_balance_150">150% Declining balance</option>
						<option value="declining_balance_200">200% Declining balance</option>
						<option value="macrs_gds">MACRS — GDS</option>
						<option value="macrs_ads">MACRS — ADS</option>
					</select>
				</Field>
				<Field label="Useful life (months)" required>
					<input
						type="number"
						name="usefulLifeMonths"
						required
						min="1"
						step="1"
						defaultValue={selectedCategory?.defaultUsefulLifeMonths ?? 60}
						className={`${inputClass} text-right tabular-nums`}
					/>
					{selectedCategory && (
						<div className="text-[10px] text-zinc-500">
							{Math.round(selectedCategory.defaultUsefulLifeMonths / 12)} yr default for this category
						</div>
					)}
				</Field>
				<Field label="Convention">
					<select name="convention" defaultValue="half_year" className={inputClass}>
						<option value="half_year">Half-year</option>
						<option value="mid_month">Mid-month</option>
						<option value="mid_quarter">Mid-quarter</option>
						<option value="full_month">Full month</option>
					</select>
				</Field>
			</section>

			<section className="grid grid-cols-1 gap-4 md:grid-cols-2">
				<Field label="Prior accumulated depreciation (migration)">
					<input
						type="number"
						name="priorAccumulatedDepreciation"
						min="0"
						step="0.01"
						defaultValue="0"
						className={`${inputClass} text-right tabular-nums`}
					/>
					<div className="text-[10px] text-zinc-500">
						Migrating an in-flight asset? Enter accumulated depreciation through the prior period.
					</div>
				</Field>
				<Field label="Through date">
					<input type="date" name="priorAccumulatedThroughDate" className={inputClass} />
				</Field>
			</section>

			<section className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
				<label className="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						name="autoDepreciate"
						defaultChecked={selectedCategory?.defaultAutoDepreciate ?? false}
					/>
					Auto-depreciate monthly (when the org cron is enabled)
				</label>
				<label className="flex items-center gap-2 text-sm">
					<input type="checkbox" name="activate" defaultChecked />
					Activate immediately (uncheck to save as draft)
				</label>
			</section>

			<Field label="Notes (optional)">
				<textarea name="notes" rows={3} maxLength={2000} className={inputClass} />
			</Field>

			<div className="flex items-center gap-3">
				<button
					type="submit"
					disabled={pending}
					className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
				>
					{pending ? 'Creating…' : 'Create asset'}
				</button>
				<a
					href="/assets"
					className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
				>
					Cancel
				</a>
				{state?.error && <span className="text-sm text-red-600">{state.error}</span>}
			</div>
		</form>
	);
}

function Field({
	label,
	required,
	className,
	children,
}: {
	label: string;
	required?: boolean;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div className={`flex flex-col gap-1 ${className ?? ''}`}>
			<label className={labelClass}>
				{label}
				{required && <span className="ml-1 text-red-600">*</span>}
			</label>
			{children}
		</div>
	);
}
