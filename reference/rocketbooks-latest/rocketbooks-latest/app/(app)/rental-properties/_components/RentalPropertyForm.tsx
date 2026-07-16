'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import {
	createRentalProperty,
	type CreateRentalPropertyState,
} from '../_actions/createRentalProperty';
import {
	updateRentalProperty,
	type UpdateRentalPropertyState,
} from '../_actions/updateRentalProperty';

export interface CategoryPick {
	id: string;
	name: string;
	defaultMethod: string;
	defaultUsefulLifeMonths: number;
}

export interface RentalPropertyInitial {
	id: string;
	displayName: string;
	addressLine: string | null;
	city: string | null;
	state: string | null;
	zip: string | null;
	acquiredOn: string | null;
	fixedAssetId: string | null;
}

interface Props {
	/** Required in create mode, unused in edit mode (asset details are
	 *  managed on the asset detail page). */
	categories?: CategoryPick[];
	defaultCategoryId?: string | null;
	/** When supplied → edit mode. Asset section is hidden; only identity
	 *  fields are shown and the action wires to updateRentalProperty. */
	initial?: RentalPropertyInitial;
}

const inputCls =
	'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-blue-500 dark:focus:ring-blue-900/50';
const labelCls = 'text-xs font-medium uppercase tracking-wide text-zinc-500';

export function RentalPropertyForm({ categories = [], defaultCategoryId, initial }: Props) {
	const isEdit = !!initial;

	const [createState, createAction, createPending] = useActionState<
		CreateRentalPropertyState | undefined,
		FormData
	>(createRentalProperty, undefined);
	const [updateState, updateAction, updatePending] = useActionState<
		UpdateRentalPropertyState | undefined,
		FormData
	>(updateRentalProperty, undefined);

	const state = isEdit ? updateState : createState;
	const action = isEdit ? updateAction : createAction;
	const pending = isEdit ? updatePending : createPending;

	const [categoryId, setCategoryId] = useState(defaultCategoryId ?? categories[0]?.id ?? '');
	const selectedCategory = categories.find((c) => c.id === categoryId);
	const defaultLife = selectedCategory?.defaultUsefulLifeMonths ?? 330;
	const defaultMethod = selectedCategory?.defaultMethod ?? 'straight_line';

	const noCategories = !isEdit && categories.length === 0;

	return (
		<form action={action} className="flex flex-col gap-6">
			{isEdit && <input type="hidden" name="propertyId" value={initial.id} />}

			<Section title="Property">
				<Field label="Display name" required>
					<input
						name="displayName"
						placeholder="123 Main St"
						required
						defaultValue={initial?.displayName ?? ''}
						className={inputCls}
					/>
				</Field>
				<Field label="Acquired on">
					<input
						type="date"
						name="acquiredOn"
						defaultValue={initial?.acquiredOn ?? ''}
						className={inputCls}
					/>
				</Field>
				<Field label="Street address">
					<input
						name="addressLine"
						placeholder="123 Main St"
						defaultValue={initial?.addressLine ?? ''}
						className={inputCls}
					/>
				</Field>
				<Field label="City">
					<input
						name="city"
						defaultValue={initial?.city ?? ''}
						className={inputCls}
					/>
				</Field>
				<Field label="State">
					<input
						name="state"
						maxLength={40}
						placeholder="WA"
						defaultValue={initial?.state ?? ''}
						className={inputCls}
					/>
				</Field>
				<Field label="ZIP">
					<input
						name="zip"
						maxLength={20}
						defaultValue={initial?.zip ?? ''}
						className={inputCls}
					/>
				</Field>
			</Section>

			{isEdit ? (
				<Section title="Building (fixed asset)">
					<p className="col-span-full text-xs text-zinc-500 dark:text-zinc-400">
						Cost basis, depreciation, and disposal are managed on the linked
						asset record so the GL stays consistent.{' '}
						{initial?.fixedAssetId ? (
							<Link
								href={`/assets/${initial.fixedAssetId}`}
								className="text-blue-600 hover:underline dark:text-blue-400"
							>
								Open building asset →
							</Link>
						) : (
							<span className="text-zinc-400">
								(no building asset linked — this property was created before the
								asset link was added)
							</span>
						)}
					</p>
				</Section>
			) : (
				<Section title="Building (fixed asset)">
					<p className="col-span-full text-xs text-zinc-500 dark:text-zinc-400">
						Posts a beginning-balance JE: debit the category&rsquo;s asset
						account, credit Trust Corpus. The building shows up on the balance
						sheet and on the Assets page, linked back to this property.
					</p>
					{noCategories ? (
						<div className="col-span-full rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
							No fixed-asset categories exist on this org. Visit{' '}
							<a href="/assets/categories" className="underline">
								/assets/categories
							</a>{' '}
							to seed one (e.g. &ldquo;Buildings&rdquo;) and come back.
						</div>
					) : (
						<>
							<Field label="Category" required>
								<select
									name="categoryId"
									value={categoryId}
									onChange={(e) => setCategoryId(e.target.value)}
									required
									className={inputCls}
								>
									{categories.map((c) => (
										<option key={c.id} value={c.id}>
											{c.name}
										</option>
									))}
								</select>
								{selectedCategory && (
									<span className="text-[10px] text-zinc-500">
										Default: {selectedCategory.defaultMethod.replace(/_/g, ' ')} ·{' '}
										{Math.round(selectedCategory.defaultUsefulLifeMonths / 12)} yr life
									</span>
								)}
							</Field>
							<Field label="Acquisition type" required>
								<select name="acquisitionType" defaultValue="purchased" className={inputCls}>
									<option value="purchased">Purchased</option>
									<option value="inherited">Inherited (stepped-up basis)</option>
									<option value="contributed">Contributed (non-cash)</option>
								</select>
							</Field>
							<Field label="In-service date" required>
								<input type="date" name="inServiceDate" required className={inputCls} />
							</Field>
							<Field label="Cost basis" required>
								<input
									type="number"
									name="costBasis"
									min="0"
									step="0.01"
									required
									placeholder="0.00"
									className={inputCls}
								/>
							</Field>
							<Field label="Salvage value">
								<input
									type="number"
									name="salvageValue"
									min="0"
									step="0.01"
									defaultValue="0"
									className={inputCls}
								/>
							</Field>
							<Field label="Useful life (months)">
								<input
									type="number"
									name="usefulLifeMonths"
									min="1"
									step="1"
									defaultValue={defaultLife}
									className={inputCls}
								/>
							</Field>
							<Field label="Depreciation method">
								<select name="method" defaultValue={defaultMethod} className={inputCls}>
									<option value="straight_line">Straight line</option>
									<option value="declining_balance_150">Declining balance 150%</option>
									<option value="declining_balance_200">Declining balance 200%</option>
									<option value="macrs_gds">MACRS GDS</option>
									<option value="macrs_ads">MACRS ADS</option>
								</select>
							</Field>
							<Field label="Convention">
								<select name="convention" defaultValue="mid_month" className={inputCls}>
									<option value="mid_month">Mid-month (real estate default)</option>
									<option value="half_year">Half-year</option>
									<option value="mid_quarter">Mid-quarter</option>
									<option value="full_month">Full month</option>
								</select>
							</Field>
						</>
					)}
				</Section>
			)}

			{state?.error && (
				<div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950/30 dark:text-red-200">
					{state.error}
				</div>
			)}

			<div className="flex items-center justify-end gap-3">
				<a
					href="/rental-properties"
					className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
				>
					Cancel
				</a>
				<button
					type="submit"
					disabled={pending || noCategories}
					className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
				>
					{pending ? (isEdit ? 'Saving…' : 'Creating…') : isEdit ? 'Save changes' : 'Create property + asset'}
				</button>
			</div>
		</form>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<fieldset className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
			<legend className="px-1 text-sm font-medium uppercase tracking-wide text-zinc-500">{title}</legend>
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
		</fieldset>
	);
}

function Field({
	label,
	required,
	children,
}: {
	label: string;
	required?: boolean;
	children: React.ReactNode;
}) {
	return (
		<label className="flex flex-col gap-1">
			<span className={labelCls}>
				{label}
				{required && <span className="ml-0.5 text-red-500">*</span>}
			</span>
			{children}
		</label>
	);
}
