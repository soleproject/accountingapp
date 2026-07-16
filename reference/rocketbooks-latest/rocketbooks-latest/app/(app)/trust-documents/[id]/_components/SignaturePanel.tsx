'use client';

import { useState, useTransition } from 'react';
import { submitTypedSignature } from '../../_actions/submitTypedSignature';
import type { Signer } from '@/lib/resolutions/types';

export interface TrusteePickOption {
	id: string;
	contactName: string;
	trusteeRole: string | null;
}

interface Props {
	documentRecordId: string;
	signers: Signer[];
	trustees: TrusteePickOption[];
}

function isTrusteeRole(role: string): boolean {
	return role.toLowerCase().includes('trustee');
}

/**
 * Per-signer typed-name signature collection. Each signer gets a row;
 * already-signed signers render as a static badge with the captured
 * name + timestamp. Submit triggers a re-render of the PDF so the
 * signature blocks pick up the new name in the body.
 */
export function SignaturePanel({ documentRecordId, signers, trustees }: Props) {
	return (
		<section className="rounded-xl border border-zinc-300 bg-white p-4 shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/60 dark:ring-white/10">
			<h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-500">
				Signatures
			</h2>
			<ul className="flex flex-col gap-3">
				{signers.map((s) => (
					<li key={s.id}>
						<SignerRow
							documentRecordId={documentRecordId}
							signer={s}
							trustees={trustees}
						/>
					</li>
				))}
			</ul>
			<p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
				Typed name + your IP + UTC timestamp are recorded in the audit
				trail. This satisfies UETA / federal E-SIGN intent capture; we&rsquo;ll
				swap in DocuSign / Dropbox Sign in a later release if needed.
			</p>
		</section>
	);
}

function SignerRow({
	documentRecordId,
	signer,
	trustees,
}: {
	documentRecordId: string;
	signer: Signer;
	trustees: TrusteePickOption[];
}) {
	// Trustee signer rows pick from the roster instead of typing a
	// free-form name — this prevents typos that could break the audit
	// trail and saves a step. Non-trustee roles (Seller, Beneficiary,
	// etc.) stay free-text since they're often parties outside the
	// org's contact list.
	const isTrustee = isTrusteeRole(signer.role);

	// For trustee rows, seed the dropdown by matching expectedName to
	// a roster contact. If the expected name doesn't match anyone
	// (e.g., the trustee was removed since the doc was drafted), the
	// dropdown opens to "Select trustee".
	const initialTrusteeId = (() => {
		if (!isTrustee) return '';
		const target = (signer.expectedName ?? '').trim().toLowerCase();
		if (!target) return '';
		return trustees.find((t) => t.contactName.trim().toLowerCase() === target)?.id ?? '';
	})();
	const [trusteeId, setTrusteeId] = useState(initialTrusteeId);

	const [name, setName] = useState(signer.expectedName ?? '');
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const signed = !!signer.signedAt;

	const effectiveName = isTrustee
		? (trustees.find((t) => t.id === trusteeId)?.contactName ?? '')
		: name;

	const onSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		startTransition(async () => {
			const r = await submitTypedSignature({
				documentRecordId,
				signerId: signer.id,
				typedName: effectiveName,
			});
			if (!r.ok) {
				setError(r.error ?? 'Sign failed');
			}
		});
	};

	if (signed) {
		return (
			<div className="rounded-md border border-emerald-300 bg-emerald-50 p-2.5 dark:border-emerald-800 dark:bg-emerald-900/20">
				<div className="text-xs font-medium uppercase tracking-wide text-emerald-800 dark:text-emerald-200">
					{signer.role}
				</div>
				<div className="mt-0.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">
					{signer.signedName}
				</div>
				<div className="text-xs text-zinc-500 dark:text-zinc-400">
					Signed {signer.signedAt}
					{signer.signedIp ? ` · IP ${signer.signedIp}` : ''}
				</div>
			</div>
		);
	}

	const canSign = isTrustee ? !!trusteeId : name.trim().length > 0;
	const noTrusteesOnFile = isTrustee && trustees.length === 0;

	return (
		<form onSubmit={onSubmit} className="flex flex-col gap-1.5">
			<label className="flex flex-col gap-1">
				<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{signer.role}</span>
				{isTrustee ? (
					noTrusteesOnFile ? (
						<div className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
							No trustees on file. Add a contact with a trustee role first.
						</div>
					) : (
						<select
							value={trusteeId}
							onChange={(e) => setTrusteeId(e.target.value)}
							disabled={pending}
							className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
						>
							<option value="">— Select trustee —</option>
							{trustees.map((t) => (
								<option key={t.id} value={t.id}>
									{t.contactName}
									{t.trusteeRole ? ` · ${t.trusteeRole}` : ''}
								</option>
							))}
						</select>
					)
				) : (
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						disabled={pending}
						placeholder="Type full legal name to sign"
						className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				)}
			</label>
			<div className="flex items-center justify-between">
				<span className="text-xs text-red-600 dark:text-red-400">{error ?? ''}</span>
				<button
					type="submit"
					disabled={pending || !canSign}
					className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
				>
					{pending ? 'Signing…' : 'Sign'}
				</button>
			</div>
		</form>
	);
}
