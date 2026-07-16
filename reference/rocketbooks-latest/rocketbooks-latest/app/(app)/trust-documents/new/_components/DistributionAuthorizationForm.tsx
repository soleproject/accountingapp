'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { draftResolution } from '../../_actions/draftResolution';
import { updateDocumentVariables } from '../../_actions/updateDocumentVariables';

const CHARACTER_OPTIONS = [
	{ value: 'income', label: 'Income — flows to beneficiary K-1 as ordinary income' },
	{ value: 'dni', label: 'DNI — Distributable Net Income flow-through' },
	{ value: 'principal', label: 'Principal — corpus distribution, no K-1' },
] as const;

interface BeneficiaryOption {
	id: string;
	fullName: string;
	relationship: string | null;
}

interface InitialValues {
	beneficiaryName?: string;
	beneficiaryRelationship?: string | null;
	amountCents?: number;
	distributionDate?: string;
	taxYear?: number;
	character?: 'principal' | 'income' | 'dni';
	purpose?: string;
	standardApplied?: string;
	hemsCategory?: 'health' | 'education' | 'maintenance' | 'support' | 'none' | null;
	hemsFindings?: string | null;
	otherResourcesConsidered?: boolean | null;
	sourceAccountLabel?: string | null;
	sourceFindingId?: string;
}

interface Props {
	initial?: InitialValues;
	beneficiaries: BeneficiaryOption[];
	/** When set, submits an edit to this document instead of drafting
	 *  a new one. Drives the /trust-documents/[id]/edit flow. */
	editingDocumentId?: string;
}

/**
 * Hand-written form for the Distribution Authorization. When prefilled
 * from a trust-review finding (TRUST_310_FLAG_K1_ISSUANCE) the
 * beneficiary, amount, date, and tax year arrive populated — user
 * fills in the judgment-call fields (purpose, standard applied,
 * character) and drafts.
 */
export function DistributionAuthorizationForm({ initial, beneficiaries, editingDocumentId }: Props) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	// Match the prefilled name to a roster id so the dropdown shows
	// the right beneficiary on first paint. Case-insensitive whitespace-
	// trimmed compare to absorb minor formatting drift between
	// `journal_entry_lines.beneficiaryId → trust_beneficiaries.fullName`
	// and whatever name we want to display.
	const initialBeneficiaryId = (() => {
		const target = (initial?.beneficiaryName ?? '').trim().toLowerCase();
		if (!target) return '';
		return beneficiaries.find((b) => b.fullName.trim().toLowerCase() === target)?.id ?? '';
	})();
	const [beneficiaryId, setBeneficiaryId] = useState<string>(initialBeneficiaryId);

	const selectedBeneficiary = beneficiaries.find((b) => b.id === beneficiaryId) ?? null;
	const beneficiaryName = selectedBeneficiary?.fullName ?? '';
	const [beneficiaryRelationship, setBeneficiaryRelationship] = useState(
		initial?.beneficiaryRelationship ?? selectedBeneficiary?.relationship ?? '',
	);

	const onBeneficiaryChange = (id: string) => {
		setBeneficiaryId(id);
		const next = beneficiaries.find((b) => b.id === id) ?? null;
		// Auto-fill relationship from the picked beneficiary unless the
		// user has already typed something custom — overwriting their
		// edit would be annoying.
		if (next && (!beneficiaryRelationship || beneficiaryRelationship === selectedBeneficiary?.relationship)) {
			setBeneficiaryRelationship(next.relationship ?? '');
		}
	};
	const [amountDollars, setAmountDollars] = useState(
		initial?.amountCents != null ? (initial.amountCents / 100).toFixed(2) : '',
	);
	const [distributionDate, setDistributionDate] = useState(
		initial?.distributionDate ?? new Date().toISOString().slice(0, 10),
	);
	const [taxYear, setTaxYear] = useState(
		String(initial?.taxYear ?? new Date().getFullYear()),
	);
	const [character, setCharacter] = useState<typeof CHARACTER_OPTIONS[number]['value']>(
		initial?.character ?? 'income',
	);
	const [purpose, setPurpose] = useState(initial?.purpose ?? '');
	const [standardApplied, setStandardApplied] = useState(initial?.standardApplied ?? '');
	const [sourceAccountLabel, setSourceAccountLabel] = useState(initial?.sourceAccountLabel ?? '');
	const [hemsCategory, setHemsCategory] = useState<'health' | 'education' | 'maintenance' | 'support' | 'none'>(
		initial?.hemsCategory ?? 'none',
	);
	const [hemsFindings, setHemsFindings] = useState(initial?.hemsFindings ?? '');
	const [otherResourcesConsidered, setOtherResourcesConsidered] = useState<'consider' | 'disregard' | 'unspecified'>(
		initial?.otherResourcesConsidered === true ? 'consider'
		: initial?.otherResourcesConsidered === false ? 'disregard'
		: 'unspecified',
	);

	const prefilledNote = initial?.sourceFindingId
		? `Prefilled from trust-review finding ${initial.sourceFindingId.slice(0, 8)} — review the values before drafting.`
		: null;

	const onSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		if (!beneficiaryId) {
			setError('Pick a beneficiary');
			return;
		}
		const dollars = Number.parseFloat(amountDollars);
		if (!Number.isFinite(dollars) || dollars <= 0) {
			setError('Amount must be a positive dollar value');
			return;
		}
		const cents = Math.round(dollars * 100);
		const taxYearNum = Number.parseInt(taxYear, 10);
		if (!Number.isFinite(taxYearNum) || taxYearNum < 1900 || taxYearNum > 3000) {
			setError('Tax year is out of range');
			return;
		}
		const variables = {
			beneficiaryName: beneficiaryName.trim(),
			beneficiaryRelationship: beneficiaryRelationship.trim() || null,
			amountCents: cents,
			distributionDate,
			taxYear: taxYearNum,
			character,
			purpose: purpose.trim(),
			standardApplied: standardApplied.trim(),
			hemsCategory: hemsCategory === 'none' ? null : hemsCategory,
			hemsFindings: hemsFindings.trim() || null,
			otherResourcesConsidered:
				otherResourcesConsidered === 'consider' ? true
				: otherResourcesConsidered === 'disregard' ? false
				: null,
			sourceAccountLabel: sourceAccountLabel.trim() || null,
			sourceFindingId: initial?.sourceFindingId ?? null,
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
				templateId: 'distribution-authorization',
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
			{prefilledNote && (
				<div className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-200">
					{prefilledNote}
				</div>
			)}

			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Beneficiary <span className="text-red-600">*</span>
					</span>
					{beneficiaries.length === 0 ? (
						<div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
							No beneficiaries on file.{' '}
							<Link href="/trust-beneficiaries" className="underline">
								Add one first
							</Link>
							.
						</div>
					) : (
						<select
							value={beneficiaryId}
							onChange={(e) => onBeneficiaryChange(e.target.value)}
							required
							disabled={pending}
							className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
						>
							<option value="">— Select beneficiary —</option>
							{beneficiaries.map((b) => (
								<option key={b.id} value={b.id}>
									{b.fullName}
									{b.relationship ? ` (${b.relationship})` : ''}
								</option>
							))}
						</select>
					)}
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Relationship</span>
					<input
						type="text"
						value={beneficiaryRelationship}
						onChange={(e) => setBeneficiaryRelationship(e.target.value)}
						disabled={pending}
						placeholder="son, daughter, spouse, etc."
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Amount ($) <span className="text-red-600">*</span>
					</span>
					<input
						type="number"
						value={amountDollars}
						onChange={(e) => setAmountDollars(e.target.value)}
						required
						step="0.01"
						min="0"
						disabled={pending}
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Distribution date <span className="text-red-600">*</span>
					</span>
					<input
						type="date"
						value={distributionDate}
						onChange={(e) => setDistributionDate(e.target.value)}
						required
						disabled={pending}
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Tax year <span className="text-red-600">*</span>
					</span>
					<input
						type="number"
						value={taxYear}
						onChange={(e) => setTaxYear(e.target.value)}
						required
						min="1900"
						max="3000"
						disabled={pending}
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Character <span className="text-red-600">*</span>
					</span>
					<select
						value={character}
						onChange={(e) => setCharacter(e.target.value as typeof character)}
						disabled={pending}
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					>
						{CHARACTER_OPTIONS.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1 md:col-span-2">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Purpose <span className="text-red-600">*</span>
					</span>
					<input
						type="text"
						value={purpose}
						onChange={(e) => setPurpose(e.target.value)}
						required
						disabled={pending}
						placeholder="Tuition, medical, annual support, etc."
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label className="flex flex-col gap-1 md:col-span-2">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Standard applied <span className="text-red-600">*</span>
					</span>
					<input
						type="text"
						value={standardApplied}
						onChange={(e) => setStandardApplied(e.target.value)}
						required
						disabled={pending}
						placeholder="HEMS (health, education, maintenance, support), best-interests, etc."
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						HEMS category (asset-protection backbone)
					</span>
					<select
						value={hemsCategory}
						onChange={(e) => setHemsCategory(e.target.value as typeof hemsCategory)}
						disabled={pending}
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					>
						<option value="none">— Not a HEMS distribution —</option>
						<option value="health">Health (medical, dental, mental-health care)</option>
						<option value="education">Education (tuition, books, room/board)</option>
						<option value="maintenance">Maintenance (housing, food, utilities)</option>
						<option value="support">Support (general standard of living)</option>
					</select>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Other resources consideration
					</span>
					<select
						value={otherResourcesConsidered}
						onChange={(e) => setOtherResourcesConsidered(e.target.value as typeof otherResourcesConsidered)}
						disabled={pending}
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					>
						<option value="unspecified">— Not specified —</option>
						<option value="consider">Considered beneficiary&apos;s other resources (UTC §814 default)</option>
						<option value="disregard">Disregarded other resources (instrument so directs)</option>
					</select>
				</label>
				{hemsCategory !== 'none' && (
					<label className="flex flex-col gap-1 md:col-span-2">
						<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
							HEMS findings (specific facts)
						</span>
						<textarea
							value={hemsFindings}
							onChange={(e) => setHemsFindings(e.target.value)}
							disabled={pending}
							rows={3}
							placeholder={
								hemsCategory === 'health' ? 'Medical condition, treatment, providers, why this distribution funds care.'
								: hemsCategory === 'education' ? 'Institution, program, tuition/fees/books breakdown, academic standing.'
								: hemsCategory === 'maintenance' ? 'Housing / food / utilities cost basis; comparison to beneficiary standard of living at distribution.'
								: 'Standard-of-living rationale and how the amount was calibrated to the beneficiary\'s circumstances.'
							}
							className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
						/>
					</label>
				)}
				<label className="flex flex-col gap-1 md:col-span-2">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Source account (optional)
					</span>
					<input
						type="text"
						value={sourceAccountLabel}
						onChange={(e) => setSourceAccountLabel(e.target.value)}
						disabled={pending}
						placeholder="310 — Distributions"
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
							: 'Draft Distribution Authorization'}
				</button>
			</div>
		</form>
	);
}
