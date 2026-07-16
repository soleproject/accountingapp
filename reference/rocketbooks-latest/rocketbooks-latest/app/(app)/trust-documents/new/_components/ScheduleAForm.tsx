'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { draftResolution } from '../../_actions/draftResolution';
import { updateDocumentVariables } from '../../_actions/updateDocumentVariables';

interface ScheduleAAssetItem {
	name: string;
	categoryName: string | null;
	acquisitionType: 'contributed' | 'inherited';
	costBasisCents: number;
	fmvCents: number | null;
	inServiceDate: string;
	assetNumber: string | null;
	serialNumber: string | null;
	location: string | null;
}

interface InitialValues {
	revision?: number;
	asOfDate?: string;
	notes?: string | null;
	assets?: ScheduleAAssetItem[];
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
 * Review-and-submit form for Schedule A. The asset list is
 * server-loaded from fixed_assets and shown read-only — the trustee
 * confirms the snapshot looks right before drafting. To change asset
 * facts, the user goes to the Assets page and edits there, then
 * re-opens this form.
 */
export function ScheduleAForm({ initial, editingDocumentId }: Props = {}) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const [asOfDate, setAsOfDate] = useState(
		initial?.asOfDate ?? new Date().toISOString().slice(0, 10),
	);
	const [notes, setNotes] = useState(initial?.notes ?? '');

	const assets = initial?.assets ?? [];
	const revision = initial?.revision ?? 1;
	const totalBasisCents = assets.reduce((acc, a) => acc + a.costBasisCents, 0);
	const totalFmvCents = assets.reduce((acc, a) => acc + (a.fmvCents ?? a.costBasisCents), 0);

	const onSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		const variables = {
			revision,
			asOfDate,
			notes: notes.trim() || null,
			assets,
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
				templateId: 'schedule-a',
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
				{revision === 1 ? (
					<>
						This will be the <strong>Initial Schedule A</strong> for the trust.
						Auto-populated from the fixed-asset register
						(<Link href="/assets" className="underline">/assets</Link>) — to change asset facts, edit them there first, then come back.
					</>
				) : (
					<>
						This will be <strong>Amendment {revision - 1}</strong> to Schedule A. Reflects all current contributed / inherited assets as of the snapshot date.
					</>
				)}
			</div>

			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						As-of date <span className="text-red-600">*</span>
					</span>
					<input
						type="date"
						value={asOfDate}
						onChange={(e) => setAsOfDate(e.target.value)}
						required
						disabled={pending}
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Revision
					</span>
					<div className="rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800">
						{revision === 1 ? 'Initial (1)' : `Amendment ${revision - 1} (revision ${revision})`}
					</div>
				</label>
				<label className="flex flex-col gap-1 md:col-span-2">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Notes (optional)
					</span>
					<textarea
						value={notes}
						onChange={(e) => setNotes(e.target.value)}
						disabled={pending}
						rows={2}
						placeholder={revision === 1
							? "Cover note — e.g., 'This Schedule reflects all assets contributed at funding on 2026-01-15.'"
							: "What's new since the prior schedule. E.g., 'Adds 1 vehicle contributed on 2026-05-10.'"
						}
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
			</div>

			<section className="mt-6">
				<div className="mb-2 flex items-baseline justify-between">
					<h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Assets in corpus ({assets.length})
					</h2>
					<Link href="/assets" className="text-xs text-blue-600 hover:underline dark:text-blue-400">
						Manage assets ↗
					</Link>
				</div>
				{assets.length === 0 ? (
					<div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
						No contributed or inherited assets in the fixed-asset register yet. Add at least one on the Assets page before drafting Schedule A.
					</div>
				) : (
					<div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
						<table className="w-full text-sm">
							<thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
								<tr>
									<th className="px-3 py-2 font-medium">#</th>
									<th className="px-3 py-2 font-medium">Description</th>
									<th className="px-3 py-2 font-medium">Class</th>
									<th className="px-3 py-2 text-right font-medium">Cost basis</th>
									<th className="px-3 py-2 text-right font-medium">FMV</th>
									<th className="px-3 py-2 text-right font-medium">In service</th>
								</tr>
							</thead>
							<tbody>
								{assets.map((a, idx) => (
									<tr key={idx} className="border-t border-zinc-100 dark:border-zinc-800">
										<td className="px-3 py-2 align-top text-zinc-500">{idx + 1}</td>
										<td className="px-3 py-2 align-top">
											<div className="font-medium">{a.name}</div>
											{(a.assetNumber || a.serialNumber || a.location) && (
												<div className="font-mono text-xs text-zinc-500">
													{[
														a.assetNumber ? `#${a.assetNumber}` : null,
														a.serialNumber ? `SN ${a.serialNumber}` : null,
														a.location,
													].filter(Boolean).join(' · ')}
												</div>
											)}
										</td>
										<td className="px-3 py-2 align-top">
											<div>{a.categoryName ?? '—'}</div>
											<div className="text-xs text-zinc-500 capitalize">{a.acquisitionType}</div>
										</td>
										<td className="px-3 py-2 align-top text-right tabular-nums">{fmtMoney(a.costBasisCents)}</td>
										<td className="px-3 py-2 align-top text-right tabular-nums">
											{a.fmvCents != null ? fmtMoney(a.fmvCents) : '—'}
										</td>
										<td className="px-3 py-2 align-top text-right tabular-nums text-zinc-700 dark:text-zinc-300">
											{a.inServiceDate}
										</td>
									</tr>
								))}
								<tr className="border-t-2 border-zinc-300 bg-zinc-50 font-semibold dark:border-zinc-700 dark:bg-zinc-900">
									<td className="px-3 py-2" colSpan={3}>Totals</td>
									<td className="px-3 py-2 text-right tabular-nums">{fmtMoney(totalBasisCents)}</td>
									<td className="px-3 py-2 text-right tabular-nums">{fmtMoney(totalFmvCents)}</td>
									<td className="px-3 py-2" />
								</tr>
							</tbody>
						</table>
					</div>
				)}
			</section>

			{error && <div className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</div>}

			<div className="mt-5 flex items-center justify-end gap-2">
				<button
					type="submit"
					disabled={pending || assets.length === 0}
					className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
				>
					{pending
						? editingDocumentId
							? 'Saving…'
							: 'Drafting…'
						: editingDocumentId
							? 'Save changes'
							: revision === 1
								? 'Draft Initial Schedule A'
								: `Draft Schedule A Amendment ${revision - 1}`}
				</button>
			</div>
		</form>
	);
}
