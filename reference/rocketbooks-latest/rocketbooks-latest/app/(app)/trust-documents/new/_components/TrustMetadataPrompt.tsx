'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { upsertTrustMetadata } from '../../_actions/upsertTrustMetadata';

interface InitialMetadata {
	trustName: string | null;
	effectiveDate: string | null;
	governingState: string | null;
	situsState: string | null;
	ein: string | null;
	grantorName: string | null;
	defaultSigningAuthority: string | null;
}

interface Props {
	organizationId: string;
	initial: InitialMetadata | null;
}

/**
 * Lazy-prompt that appears the first time the user drafts a
 * resolution whose template needs trust-level fields. Captures the
 * minimum required to render the requested template (governing state)
 * plus the most useful headers (trust name, EIN, effective date).
 * Refreshes on success so the parent page falls through to the
 * actual draft form.
 */
export function TrustMetadataPrompt({ initial }: Props) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [trustName, setTrustName] = useState(initial?.trustName ?? '');
	const [effectiveDate, setEffectiveDate] = useState(initial?.effectiveDate ?? '');
	const [governingState, setGoverningState] = useState(initial?.governingState ?? '');
	const [ein, setEin] = useState(initial?.ein ?? '');
	const [grantorName, setGrantorName] = useState(initial?.grantorName ?? '');
	const [signingAuthority, setSigningAuthority] = useState<string>(initial?.defaultSigningAuthority ?? 'sole');

	const onSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		if (!governingState.trim()) {
			setError('Governing state is required for this template');
			return;
		}
		startTransition(async () => {
			const r = await upsertTrustMetadata({
				trustName: trustName.trim() || null,
				effectiveDate: effectiveDate || null,
				governingState: governingState.trim().toUpperCase(),
				situsState: governingState.trim().toUpperCase(),
				ein: ein.trim() || null,
				grantorName: grantorName.trim() || null,
				defaultSigningAuthority: signingAuthority as 'sole' | 'majority' | 'unanimous',
			});
			if (!r.ok) {
				setError(r.error ?? 'Save failed');
				return;
			}
			router.refresh();
		});
	};

	return (
		<form
			onSubmit={onSubmit}
			className="rounded-xl border border-amber-300 bg-amber-50 p-5 shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 dark:border-amber-800 dark:bg-amber-950/20 dark:shadow-black/60 dark:ring-white/10"
		>
			<h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-amber-800 dark:text-amber-200">
				One-time: tell us about the trust
			</h2>
			<p className="mb-4 text-sm text-zinc-700 dark:text-zinc-300">
				This template needs the trust&rsquo;s governing state and a few headers
				to render. We&rsquo;ll save these for every future document so this
				prompt only appears once.
			</p>

			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Trust name</span>
					<input
						type="text"
						value={trustName}
						onChange={(e) => setTrustName(e.target.value)}
						disabled={pending}
						placeholder="The Smith Family Trust"
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Effective date</span>
					<input
						type="date"
						value={effectiveDate}
						onChange={(e) => setEffectiveDate(e.target.value)}
						disabled={pending}
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
						Governing state <span className="text-red-600">*</span>
					</span>
					<input
						type="text"
						value={governingState}
						onChange={(e) => setGoverningState(e.target.value)}
						disabled={pending}
						placeholder="TX"
						maxLength={2}
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm uppercase dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">EIN</span>
					<input
						type="text"
						value={ein}
						onChange={(e) => setEin(e.target.value)}
						disabled={pending}
						placeholder="XX-XXXXXXX"
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Grantor name</span>
					<input
						type="text"
						value={grantorName}
						onChange={(e) => setGrantorName(e.target.value)}
						disabled={pending}
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Signing authority</span>
					<select
						value={signingAuthority}
						onChange={(e) => setSigningAuthority(e.target.value)}
						disabled={pending}
						className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					>
						<option value="sole">Sole — any trustee may act alone</option>
						<option value="majority">Majority of trustees must consent</option>
						<option value="unanimous">All trustees must consent</option>
					</select>
				</label>
			</div>

			{error && <div className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</div>}

			<div className="mt-5 flex items-center justify-end gap-2">
				<button
					type="submit"
					disabled={pending}
					className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
				>
					{pending ? 'Saving…' : 'Save and continue'}
				</button>
			</div>
		</form>
	);
}
