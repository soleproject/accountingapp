'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { draftResolution } from '../../_actions/draftResolution';
import { updateDocumentVariables } from '../../_actions/updateDocumentVariables';

const CHARACTER_OPTIONS = [
	{ value: 'income', label: 'Income — flowed via K-1 as ordinary income' },
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
	authorizationDocumentId?: string | null;
}

interface Props {
	initial?: InitialValues;
	editingDocumentId?: string;
	beneficiaries?: BeneficiaryOption[];
}

/**
 * Edit form for Beneficiary Receipt & Release. The R&R is normally
 * auto-spawned alongside a Distribution Authorization (so most R&Rs
 * land in the user's queue without ever opening this form), but
 * editing is supported here for typo fixes and the rare manual
 * draft. Manual drafts SHOULD reference an existing Authorization
 * id; we don't enforce that today.
 */
export function BeneficiaryReceiptAndReleaseForm({ initial, editingDocumentId, beneficiaries = [] }: Props = {}) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const initialBeneficiaryId = (() => {
		const target = (initial?.beneficiaryName ?? '').trim().toLowerCase();
		if (!target) return '';
		return beneficiaries.find((b) => b.fullName.trim().toLowerCase() === target)?.id ?? '';
	})();
	const [beneficiaryId, setBeneficiaryId] = useState(initialBeneficiaryId);
	const selectedBeneficiary = beneficiaries.find((b) => b.id === beneficiaryId) ?? null;
	const beneficiaryName = selectedBeneficiary?.fullName ?? initial?.beneficiaryName ?? '';
	const [beneficiaryRelationship, setBeneficiaryRelationship] = useState(
		initial?.beneficiaryRelationship ?? selectedBeneficiary?.relationship ?? '',
	);

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
	const [authorizationDocumentId, setAuthorizationDocumentId] = useState(
		initial?.authorizationDocumentId ?? '',
	);

	const onSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		if (!beneficiaryName) {
			setError(beneficiaries.length === 0 ? 'Pick a beneficiary' : 'Pick a beneficiary');
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
			authorizationDocumentId: authorizationDocumentId.trim() || null,
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
				templateId: 'beneficiary-receipt-and-release',
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
				Normally auto-spawned next to a Distribution Authorization. Manual
				drafts should reference the paired Authorization id below for the
				audit trail.
			</div>

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
							onChange={(e) => {
								setBeneficiaryId(e.target.value);
								const next = beneficiaries.find((b) => b.id === e.target.value);
								if (next) setBeneficiaryRelationship(next.relationship ?? '');
							}}
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
						Date received <span className="text-red-600">*</span>
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
						{CHARACTER_OPTIONS.map((c) => (
							<option key={c.value} value={c.value}>
								{c.label}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1 md:col-span-2">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Paired Distribution Authorization id (optional)
					</span>
					<input
						type="text"
						value={authorizationDocumentId}
						onChange={(e) => setAuthorizationDocumentId(e.target.value)}
						disabled={pending}
						placeholder="UUID of the paired Authorization document"
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-mono dark:border-zinc-700 dark:bg-zinc-900"
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
							: 'Draft Receipt & Release'}
				</button>
			</div>
		</form>
	);
}
