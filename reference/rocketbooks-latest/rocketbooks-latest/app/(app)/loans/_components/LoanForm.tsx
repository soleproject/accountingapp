'use client';

import { useActionState, useMemo, useState } from 'react';
import { createLoan, type CreateLoanState } from '../_actions/createLoan';
import { updateLoan, type UpdateLoanState } from '../_actions/updateLoan';
import { generateSchedule, type ScheduleRow } from '@/lib/loans/generate-schedule';

interface AccountOption {
	id: string;
	accountNumber: string | null;
	accountName: string;
}
interface ContactOption {
	id: string;
	contactName: string;
}

export interface LoanFormInitial {
	id: string;
	displayName: string;
	lenderContactId: string | null;
	noteDocumentUrl: string | null;
	originalPrincipal: number;
	aprPercent: number;
	termMonths: number;
	startDate: string;
	firstPaymentDate: string;
	paymentAmount: number | null;
	liabilityAccountId: string;
	interestExpenseAccountId: string;
	collateralAssetId: string | null;
	notes: string | null;
	postedCount: number;
}

export interface AssetOption {
	id: string;
	label: string;
	categoryName: string;
}

interface Props {
	lenderContacts: ContactOption[];
	liabilityAccounts: AccountOption[];
	interestExpenseAccounts: AccountOption[];
	/** Active + draft fixed assets — disposed ones aren't valid collateral. */
	collateralAssets: AssetOption[];
	defaultLiabilityAccountId: string | null;
	defaultInterestAccountId: string | null;
	/** When supplied → edit mode. */
	initial?: LoanFormInitial;
}

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

const inputCls =
	'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-blue-500 dark:focus:ring-blue-900/50';
const labelCls = 'text-xs font-medium uppercase tracking-wide text-zinc-500';

function todayISO(): string {
	const d = new Date();
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function plusOneMonth(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m, d));
	return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Create-loan form with live schedule preview. State for the editable
 * fields lives in React so the preview recomputes on every keystroke;
 * the form still submits via the native action → createLoan server
 * action (we re-parse from FormData server-side so client tampering
 * can't bypass validation).
 */
export function LoanForm({
	lenderContacts,
	liabilityAccounts,
	interestExpenseAccounts,
	collateralAssets,
	defaultLiabilityAccountId,
	defaultInterestAccountId,
	initial,
}: Props) {
	const isEdit = !!initial;
	const [createState, createAction, createPending] = useActionState<CreateLoanState | undefined, FormData>(
		createLoan,
		undefined,
	);
	const [updateState, updateAction, updatePending] = useActionState<UpdateLoanState | undefined, FormData>(
		updateLoan,
		undefined,
	);
	const state = isEdit ? updateState : createState;
	const action = isEdit ? updateAction : createAction;
	const pending = isEdit ? updatePending : createPending;

	const initialStart = initial?.startDate ?? todayISO();
	const initialFirst = initial?.firstPaymentDate ?? plusOneMonth(initialStart);

	const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
	const [originalPrincipal, setOriginalPrincipal] = useState(
		initial?.originalPrincipal !== undefined ? String(initial.originalPrincipal) : '',
	);
	const [aprPercent, setAprPercent] = useState(
		initial?.aprPercent !== undefined ? String(initial.aprPercent) : '',
	);
	const [termMonths, setTermMonths] = useState(
		initial?.termMonths !== undefined ? String(initial.termMonths) : '',
	);
	const [startDate, setStartDate] = useState(initialStart);
	const [firstPaymentDate, setFirstPaymentDate] = useState(initialFirst);
	const [paymentAmountOverride, setPaymentAmountOverride] = useState(
		initial?.paymentAmount !== null && initial?.paymentAmount !== undefined
			? String(initial.paymentAmount)
			: '',
	);

	const preview = useMemo(() => {
		const p = Number(originalPrincipal);
		const r = Number(aprPercent) / 100;
		const n = Number(termMonths);
		if (!Number.isFinite(p) || p <= 0) return null;
		if (!Number.isFinite(r) || r < 0) return null;
		if (!Number.isFinite(n) || n < 1) return null;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(firstPaymentDate)) return null;
		try {
			const override = paymentAmountOverride.trim() ? Number(paymentAmountOverride) : undefined;
			return generateSchedule({
				originalPrincipal: p,
				apr: r,
				termMonths: n,
				firstPaymentDate,
				paymentAmount: override && Number.isFinite(override) && override > 0 ? override : undefined,
			});
		} catch {
			return null;
		}
	}, [originalPrincipal, aprPercent, termMonths, firstPaymentDate, paymentAmountOverride]);

	const totalInterest = preview
		? preview.rows.reduce((s, r) => s + r.interestAmount, 0)
		: 0;

	return (
		<form action={action} className="flex flex-col gap-6">
			{isEdit && <input type="hidden" name="loanId" value={initial!.id} />}
			{isEdit && initial!.postedCount > 0 && (
				<div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
					This loan has <strong>{initial!.postedCount}</strong> posted payment
					{initial!.postedCount === 1 ? '' : 's'}. Changing terms regenerates the
					schedule and walks you through accepting / re-recording / reversing each
					prior payment on the rebuild review screen.
				</div>
			)}
			<Section title="Identity">
				<Field label="Loan name" required>
					<input
						name="displayName"
						value={displayName}
						onChange={(e) => setDisplayName(e.target.value)}
						placeholder="Chase auto loan"
						required
						className={inputCls}
					/>
				</Field>
				<Field label="Lender (optional)">
					<select
						name="lenderContactId"
						defaultValue={initial?.lenderContactId ?? ''}
						className={inputCls}
					>
						<option value="">— none —</option>
						{lenderContacts.map((c) => (
							<option key={c.id} value={c.id}>
								{c.contactName}
							</option>
						))}
					</select>
				</Field>
				<Field label="Loan-agreement URL (optional)">
					<input
						type="url"
						name="noteDocumentUrl"
						defaultValue={initial?.noteDocumentUrl ?? ''}
						placeholder="https://drive.google.com/…"
						className={inputCls}
					/>
				</Field>
			</Section>

			<Section title="Terms">
				<Field label="Original principal" required>
					<input
						type="number"
						name="originalPrincipal"
						value={originalPrincipal}
						onChange={(e) => setOriginalPrincipal(e.target.value)}
						min="0.01"
						step="0.01"
						required
						className={inputCls}
					/>
				</Field>
				<Field label="APR (%)" required>
					<input
						type="number"
						name="aprPercent"
						value={aprPercent}
						onChange={(e) => setAprPercent(e.target.value)}
						min="0"
						max="100"
						step="0.0001"
						placeholder="6.25"
						required
						className={inputCls}
					/>
				</Field>
				<Field label="Term (months)" required>
					<input
						type="number"
						name="termMonths"
						value={termMonths}
						onChange={(e) => setTermMonths(e.target.value)}
						min="1"
						max="720"
						step="1"
						placeholder="60"
						required
						className={inputCls}
					/>
				</Field>
				<Field label="Loan start date" required>
					<input
						type="date"
						name="startDate"
						value={startDate}
						onChange={(e) => setStartDate(e.target.value)}
						required
						className={inputCls}
					/>
				</Field>
				<Field label="First payment date" required>
					<input
						type="date"
						name="firstPaymentDate"
						value={firstPaymentDate}
						onChange={(e) => setFirstPaymentDate(e.target.value)}
						required
						className={inputCls}
					/>
				</Field>
				<Field label="Payment amount (optional override)">
					<input
						type="number"
						name="paymentAmount"
						value={paymentAmountOverride}
						onChange={(e) => setPaymentAmountOverride(e.target.value)}
						min="0.01"
						step="0.01"
						placeholder={preview ? preview.computedPaymentAmount.toFixed(2) : 'auto-computed'}
						className={inputCls}
					/>
				</Field>
			</Section>

			<Section title="Accounting">
				<Field label="Liability account" required>
					<select
						name="liabilityAccountId"
						defaultValue={initial?.liabilityAccountId ?? defaultLiabilityAccountId ?? ''}
						required
						className={inputCls}
					>
						<option value="" disabled>
							— pick an account —
						</option>
						{liabilityAccounts.map((a) => (
							<option key={a.id} value={a.id}>
								{a.accountNumber ? `${a.accountNumber} · ` : ''}
								{a.accountName}
							</option>
						))}
					</select>
				</Field>
				<Field label="Interest expense account" required>
					<select
						name="interestExpenseAccountId"
						defaultValue={initial?.interestExpenseAccountId ?? defaultInterestAccountId ?? ''}
						required
						className={inputCls}
					>
						<option value="" disabled>
							— pick an account —
						</option>
						{interestExpenseAccounts.map((a) => (
							<option key={a.id} value={a.id}>
								{a.accountNumber ? `${a.accountNumber} · ` : ''}
								{a.accountName}
							</option>
						))}
					</select>
				</Field>
				<Field label="Collateral asset (optional)">
					<select
						name="collateralAssetId"
						defaultValue={initial?.collateralAssetId ?? ''}
						className={inputCls}
					>
						<option value="">— unsecured / not linked —</option>
						{collateralAssets.map((a) => (
							<option key={a.id} value={a.id}>
								{a.label} ({a.categoryName})
							</option>
						))}
					</select>
					<span className="text-[10px] text-zinc-500">
						Purchase-money mortgage on a building, auto loan on a vehicle, etc.
						Letting the GL know lets disposal warn when the loan still has a
						balance.
					</span>
				</Field>
				<Field label="Notes (optional)">
					<textarea
						name="notes"
						rows={2}
						defaultValue={initial?.notes ?? ''}
						className={inputCls}
						placeholder="Anything worth remembering about this loan"
					/>
				</Field>
			</Section>

			<Section title="Schedule preview">
				{!preview ? (
					<div className="rounded-md border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
						Fill in principal, APR, term, and first-payment date to preview the
						amortization schedule.
					</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
							<Stat label="Monthly payment" value={CURRENCY_FMT.format(preview.paymentAmount)} />
							<Stat label="Total interest" value={CURRENCY_FMT.format(totalInterest)} />
							<Stat
								label="Total paid"
								value={CURRENCY_FMT.format(
									preview.rows.reduce((s, r) => s + r.principalAmount + r.interestAmount, 0),
								)}
							/>
							<Stat label="Final payment" value={preview.rows[preview.rows.length - 1]?.dueDate ?? '—'} />
						</div>
						{!preview.amortizesCleanly && (
							<div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
								Your override payment doesn&apos;t fully amortize within the term —
								the final balance won&apos;t reach zero. Adjust the payment, term, or
								leave the override blank to use the computed payment of{' '}
								<strong>{CURRENCY_FMT.format(preview.computedPaymentAmount)}</strong>.
							</div>
						)}
						<SchedulePreview rows={preview.rows} />
					</>
				)}
			</Section>

			{state?.error && (
				<div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950/30 dark:text-red-200">
					{state.error}
				</div>
			)}

			<div className="flex items-center justify-end gap-3">
				<a
					href={isEdit ? `/loans/${initial!.id}` : '/loans'}
					className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
				>
					Cancel
				</a>
				<button
					type="submit"
					disabled={pending}
					className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
				>
					{pending ? (isEdit ? 'Saving…' : 'Creating…') : isEdit ? 'Save changes' : 'Create loan'}
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

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col">
			<span className={labelCls}>{label}</span>
			<span className="mt-0.5 text-base font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
				{value}
			</span>
		</div>
	);
}

const PREVIEW_CAP = 24;

function SchedulePreview({ rows }: { rows: ScheduleRow[] }) {
	const [showAll, setShowAll] = useState(false);
	const shown = showAll || rows.length <= PREVIEW_CAP ? rows : rows.slice(0, PREVIEW_CAP);
	const truncated = !showAll && rows.length > PREVIEW_CAP;
	return (
		<div className="mt-4 overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
			<table className="w-full text-sm">
				<thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
					<tr>
						<th className="px-3 py-2 font-medium">#</th>
						<th className="px-3 py-2 font-medium">Due</th>
						<th className="px-3 py-2 text-right font-medium">Principal</th>
						<th className="px-3 py-2 text-right font-medium">Interest</th>
						<th className="px-3 py-2 text-right font-medium">Balance</th>
					</tr>
				</thead>
				<tbody>
					{shown.map((r) => (
						<tr key={r.paymentNumber} className="border-t border-zinc-100 dark:border-zinc-800">
							<td className="px-3 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">{r.paymentNumber}</td>
							<td className="px-3 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">{r.dueDate}</td>
							<td className="px-3 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
								{CURRENCY_FMT.format(r.principalAmount)}
							</td>
							<td className="px-3 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
								{CURRENCY_FMT.format(r.interestAmount)}
							</td>
							<td className="px-3 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
								{CURRENCY_FMT.format(r.remainingBalance)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{truncated && (
				<div className="flex items-center justify-between border-t border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
					<span>
						Showing first {PREVIEW_CAP} of {rows.length.toLocaleString()} payments
					</span>
					<button
						type="button"
						onClick={() => setShowAll(true)}
						className="rounded-md border border-zinc-300 px-2 py-1 hover:bg-white dark:border-zinc-700 dark:hover:bg-zinc-800"
					>
						Show all
					</button>
				</div>
			)}
		</div>
	);
}
