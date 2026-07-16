'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { draftResolution } from '../../_actions/draftResolution';
import { updateDocumentVariables } from '../../_actions/updateDocumentVariables';

interface DividendLineItem {
	accountNumber: string | null;
	accountName: string;
	incomeCents: number;
	distributedCents: number;
	retainedCents: number;
}

interface InitialValues {
	taxYear?: number;
	periodEndDate?: string;
	items?: DividendLineItem[];
	retentionRationale?: string | null;
	authorityCitation?: string | null;
}

interface Props {
	initial?: InitialValues;
	editingDocumentId?: string;
}

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function fmtMoney(cents: number): string {
	return CURRENCY_FMT.format(cents / 100);
}

/**
 * Review-and-submit form for the annual Declaration of Extraordinary
 * Dividend. Items are auto-loaded from the year's 4xx credits and a
 * proportional distribution split — read-only here. Trustee picks
 * the tax year + period-end + writes the retention rationale.
 *
 * For a different tax year, the user can navigate to the catalog
 * and pass ?taxYear=YYYY (we render a year-selector below for
 * convenience). Editing existing item amounts would require a
 * full row editor; deferred to Phase 2 since most trusts will
 * accept the auto-computed split.
 */
export function DeclarationOfExtraordinaryDividendForm({ initial, editingDocumentId }: Props = {}) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const taxYear = initial?.taxYear ?? new Date().getFullYear() - 1;
	const periodEndDate = initial?.periodEndDate ?? `${taxYear}-12-31`;
	const items = initial?.items ?? [];

	const [retentionRationale, setRetentionRationale] = useState(initial?.retentionRationale ?? '');
	const [authorityCitation, setAuthorityCitation] = useState(initial?.authorityCitation ?? '');

	const totalIncome = items.reduce((acc, i) => acc + i.incomeCents, 0);
	const totalDistributed = items.reduce((acc, i) => acc + i.distributedCents, 0);
	const totalRetained = items.reduce((acc, i) => acc + i.retainedCents, 0);

	const onYearChange = (yearStr: string) => {
		const y = Number.parseInt(yearStr, 10);
		if (Number.isFinite(y) && y >= 1900 && y <= 3000) {
			// Reload the page on the new year — the server-side prefill
			// pulls the new totals.
			router.push(`/trust-documents/new?template=declaration-of-extraordinary-dividend&taxYear=${y}`);
		}
	};

	const onSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		const variables = {
			taxYear,
			periodEndDate,
			items,
			retentionRationale: retentionRationale.trim() || null,
			authorityCitation: authorityCitation.trim() || null,
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
				templateId: 'declaration-of-extraordinary-dividend',
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
				Auto-populated from {taxYear} income (4xx credits) minus distributions
				(310 debits), with distributions split proportionally across income
				accounts. Change the tax year below to reload from a different period.
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
				<label className="flex flex-col gap-1 md:col-span-2">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Period ending
					</span>
					<div className="rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800">
						{periodEndDate}
					</div>
				</label>
			</div>

			<section className="mt-6">
				<h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
					Income retained ({items.length} account{items.length === 1 ? '' : 's'})
				</h2>
				{items.length === 0 ? (
					<div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
						No income retained for {taxYear}. Either there was no 4xx income in the period or
						distributions matched income dollar-for-dollar. This declaration would have no
						effect; consider whether it&rsquo;s needed.
					</div>
				) : (
					<div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
						<table className="w-full text-sm">
							<thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
								<tr>
									<th className="px-3 py-2 font-medium">Account</th>
									<th className="px-3 py-2 text-right font-medium">Income</th>
									<th className="px-3 py-2 text-right font-medium">Distributed</th>
									<th className="px-3 py-2 text-right font-medium">Retained</th>
								</tr>
							</thead>
							<tbody>
								{items.map((item, idx) => (
									<tr key={idx} className="border-t border-zinc-100 dark:border-zinc-800">
										<td className="px-3 py-2 align-top">
											<div>{item.accountName}</div>
											{item.accountNumber && (
												<div className="font-mono text-xs text-zinc-500">{item.accountNumber}</div>
											)}
										</td>
										<td className="px-3 py-2 align-top text-right tabular-nums">{fmtMoney(item.incomeCents)}</td>
										<td className="px-3 py-2 align-top text-right tabular-nums">{fmtMoney(item.distributedCents)}</td>
										<td className="px-3 py-2 align-top text-right tabular-nums font-medium">{fmtMoney(item.retainedCents)}</td>
									</tr>
								))}
								<tr className="border-t-2 border-zinc-300 bg-zinc-50 font-semibold dark:border-zinc-700 dark:bg-zinc-900">
									<td className="px-3 py-2">Totals</td>
									<td className="px-3 py-2 text-right tabular-nums">{fmtMoney(totalIncome)}</td>
									<td className="px-3 py-2 text-right tabular-nums">{fmtMoney(totalDistributed)}</td>
									<td className="px-3 py-2 text-right tabular-nums">{fmtMoney(totalRetained)}</td>
								</tr>
							</tbody>
						</table>
					</div>
				)}
			</section>

			<div className="mt-6 grid grid-cols-1 gap-4">
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Retention rationale (optional, recommended)
					</span>
					<textarea
						value={retentionRationale}
						onChange={(e) => setRetentionRationale(e.target.value)}
						disabled={pending}
						rows={3}
						placeholder="Why is the trustee retaining this income rather than distributing? E.g., 'Preserving operating reserves for the upcoming year', 'Current-year beneficiary distributions are sufficient', 'Funding planned capital improvements on trust property'."
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Authority citation (optional)
					</span>
					<input
						type="text"
						value={authorityCitation}
						onChange={(e) => setAuthorityCitation(e.target.value)}
						disabled={pending}
						placeholder="e.g., 'Section 6.4 of the Trust Agreement authorizes the Trustee to retain undistributed income to corpus.'"
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
							: `Draft Declaration for ${taxYear}`}
				</button>
			</div>
		</form>
	);
}
