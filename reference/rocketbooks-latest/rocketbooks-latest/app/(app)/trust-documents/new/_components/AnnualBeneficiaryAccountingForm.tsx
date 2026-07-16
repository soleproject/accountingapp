'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { draftResolution } from '../../_actions/draftResolution';
import { updateDocumentVariables } from '../../_actions/updateDocumentVariables';

interface BalanceItem {
	accountNumber: string | null;
	accountName: string;
	balanceCents: number;
}

interface ActivityItem {
	accountNumber: string | null;
	accountName: string;
	amountCents: number;
}

interface DistributionItem {
	beneficiaryName: string;
	amountCents: number;
	distributionCount: number;
}

interface InitialValues {
	taxYear?: number;
	periodStartDate?: string;
	periodEndDate?: string;
	assetBalances?: BalanceItem[];
	liabilityBalances?: BalanceItem[];
	receipts?: ActivityItem[];
	disbursements?: ActivityItem[];
	distributions?: DistributionItem[];
	trusteeCompensationCents?: number;
	notes?: string | null;
}

interface Props {
	initial?: InitialValues;
	editingDocumentId?: string;
}

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function fmtMoney(cents: number): string {
	const neg = cents < 0;
	const abs = Math.abs(cents);
	const formatted = CURRENCY_FMT.format(abs / 100);
	return neg ? `(${formatted})` : formatted;
}

/**
 * Review-and-submit form for the Annual Beneficiary Accounting. The
 * meat is auto-loaded from a year of GL activity — the user reviews
 * the rollup, picks the tax year, and adds optional notes before
 * drafting. Item-level edits aren't supported here; to change the
 * numbers, the user adjusts the underlying JEs and regenerates.
 */
export function AnnualBeneficiaryAccountingForm({ initial, editingDocumentId }: Props = {}) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const taxYear = initial?.taxYear ?? new Date().getFullYear() - 1;
	const periodStartDate = initial?.periodStartDate ?? `${taxYear}-01-01`;
	const periodEndDate = initial?.periodEndDate ?? `${taxYear}-12-31`;
	const assetBalances = initial?.assetBalances ?? [];
	const liabilityBalances = initial?.liabilityBalances ?? [];
	const receipts = initial?.receipts ?? [];
	const disbursements = initial?.disbursements ?? [];
	const distributions = initial?.distributions ?? [];
	const trusteeCompensationCents = initial?.trusteeCompensationCents ?? 0;

	const [notes, setNotes] = useState(initial?.notes ?? '');

	const totalAssets = assetBalances.reduce((acc, b) => acc + b.balanceCents, 0);
	const totalLiabilities = liabilityBalances.reduce((acc, b) => acc + b.balanceCents, 0);
	const totalReceipts = receipts.reduce((acc, r) => acc + r.amountCents, 0);
	const totalDisbursements = disbursements.reduce((acc, d) => acc + d.amountCents, 0);
	const totalDistributions = distributions.reduce((acc, d) => acc + d.amountCents, 0);

	const onYearChange = (yearStr: string) => {
		const y = Number.parseInt(yearStr, 10);
		if (Number.isFinite(y) && y >= 1900 && y <= 3000) {
			router.push(`/trust-documents/new?template=annual-beneficiary-accounting&taxYear=${y}`);
		}
	};

	const onSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		const variables = {
			taxYear,
			periodStartDate,
			periodEndDate,
			assetBalances,
			liabilityBalances,
			receipts,
			disbursements,
			distributions,
			trusteeCompensationCents,
			notes: notes.trim() || null,
		};
		startTransition(async () => {
			if (editingDocumentId) {
				const r = await updateDocumentVariables({
					documentRecordId: editingDocumentId,
					variables,
				});
				if (!r.ok) {
					setError(r.error ?? 'Save failed');
					return;
				}
				router.push(`/trust-documents/${editingDocumentId}`);
				return;
			}
			const r = await draftResolution({
				templateId: 'annual-beneficiary-accounting',
				variables,
			});
			if (!r.ok) {
				setError(r.error ?? 'Draft failed');
				return;
			}
			if (r.documentRecordId) {
				router.push(`/trust-documents/${r.documentRecordId}`);
			}
		});
	};

	return (
		<form
			onSubmit={onSubmit}
			className="rounded-xl border border-zinc-300 bg-white p-5 shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/60 dark:ring-white/10"
		>
			<div className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-200">
				Auto-populated from {taxYear} GL activity per UTC §813. Change the tax year
				below to reload from a different period. To fix a number, adjust the
				underlying journal entries and regenerate.
			</div>

			<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Tax year <span className="text-red-600">*</span>
					</span>
					{editingDocumentId ? (
						<div className="rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800">
							{taxYear}
						</div>
					) : (
						<input
							type="number"
							defaultValue={taxYear}
							onBlur={(e) => onYearChange(e.target.value)}
							min="1900"
							max="3000"
							disabled={pending}
							className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
						/>
					)}
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Period start
					</span>
					<div className="rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800">
						{periodStartDate}
					</div>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Period end
					</span>
					<div className="rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800">
						{periodEndDate}
					</div>
				</label>
			</div>

			<RollupSection
				title={`Assets (${assetBalances.length})`}
				items={assetBalances.map((b) => ({ label: b.accountName, hint: b.accountNumber, amountCents: b.balanceCents }))}
				totalCents={totalAssets}
				emptyMsg="No asset balances on record"
			/>
			<RollupSection
				title={`Liabilities (${liabilityBalances.length})`}
				items={liabilityBalances.map((b) => ({ label: b.accountName, hint: b.accountNumber, amountCents: b.balanceCents }))}
				totalCents={totalLiabilities}
				emptyMsg="No liabilities on record"
			/>
			<RollupSection
				title={`Receipts (${receipts.length})`}
				items={receipts.map((r) => ({ label: r.accountName, hint: r.accountNumber, amountCents: r.amountCents }))}
				totalCents={totalReceipts}
				emptyMsg="No receipts in the period"
			/>
			<RollupSection
				title={`Disbursements (${disbursements.length})`}
				items={disbursements.map((d) => ({ label: d.accountName, hint: d.accountNumber, amountCents: d.amountCents }))}
				totalCents={totalDisbursements}
				emptyMsg="No disbursements in the period"
			/>
			<section className="mt-6">
				<h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
					Distributions to beneficiaries ({distributions.length})
				</h2>
				{distributions.length === 0 ? (
					<div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
						No distributions in the period.
					</div>
				) : (
					<div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
						<table className="w-full text-sm">
							<thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
								<tr>
									<th className="px-3 py-2 font-medium">Beneficiary</th>
									<th className="px-3 py-2 text-right font-medium">#</th>
									<th className="px-3 py-2 text-right font-medium">Total</th>
								</tr>
							</thead>
							<tbody>
								{distributions.map((d, idx) => (
									<tr key={idx} className="border-t border-zinc-100 dark:border-zinc-800">
										<td className="px-3 py-2 align-top">{d.beneficiaryName}</td>
										<td className="px-3 py-2 align-top text-right tabular-nums">{d.distributionCount}</td>
										<td className="px-3 py-2 align-top text-right tabular-nums">{fmtMoney(d.amountCents)}</td>
									</tr>
								))}
								<tr className="border-t-2 border-zinc-300 bg-zinc-50 font-semibold dark:border-zinc-700 dark:bg-zinc-900">
									<td className="px-3 py-2">Total</td>
									<td className="px-3 py-2 text-right" />
									<td className="px-3 py-2 text-right tabular-nums">{fmtMoney(totalDistributions)}</td>
								</tr>
							</tbody>
						</table>
					</div>
				)}
			</section>

			<section className="mt-6">
				<h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Trustee compensation</h2>
				<div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm tabular-nums dark:border-zinc-800 dark:bg-zinc-900">
					{fmtMoney(trusteeCompensationCents)}
				</div>
			</section>

			<div className="mt-6">
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Notes from the trustee (optional)
					</span>
					<textarea
						value={notes}
						onChange={(e) => setNotes(e.target.value)}
						disabled={pending}
						rows={3}
						placeholder="Any context for beneficiaries — material events during the period, planned activity for next year, contact info for questions, etc."
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
			</div>

			{error && <div className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</div>}

			<div className="mt-5 flex items-center justify-end gap-2">
				<button
					type="submit"
					disabled={pending}
					className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
				>
					{pending
						? editingDocumentId
							? 'Saving…'
							: 'Drafting…'
						: editingDocumentId
							? 'Save changes'
							: `Draft Accounting for ${taxYear}`}
				</button>
			</div>
		</form>
	);
}

function RollupSection({
	title,
	items,
	totalCents,
	emptyMsg,
}: {
	title: string;
	items: Array<{ label: string; hint: string | null; amountCents: number }>;
	totalCents: number;
	emptyMsg: string;
}) {
	return (
		<section className="mt-6">
			<h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</h2>
			{items.length === 0 ? (
				<div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
					{emptyMsg}
				</div>
			) : (
				<div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
					<table className="w-full text-sm">
						<tbody>
							{items.map((item, idx) => (
								<tr key={idx} className="border-t border-zinc-100 first:border-t-0 dark:border-zinc-800">
									<td className="px-3 py-2 align-top">
										<div>{item.label}</div>
										{item.hint && (
											<div className="font-mono text-xs text-zinc-500">Account {item.hint}</div>
										)}
									</td>
									<td className="px-3 py-2 align-top text-right tabular-nums">{fmtMoney(item.amountCents)}</td>
								</tr>
							))}
							<tr className="border-t-2 border-zinc-300 bg-zinc-50 font-semibold dark:border-zinc-700 dark:bg-zinc-900">
								<td className="px-3 py-2">Total</td>
								<td className="px-3 py-2 text-right tabular-nums">{fmtMoney(totalCents)}</td>
							</tr>
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}
