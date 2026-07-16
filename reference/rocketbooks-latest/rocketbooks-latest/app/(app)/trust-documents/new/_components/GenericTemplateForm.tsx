'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { draftResolution } from '../../_actions/draftResolution';
import { updateDocumentVariables } from '../../_actions/updateDocumentVariables';
import type { TemplateField } from '@/lib/resolutions/types';

interface Props {
	templateId: string;
	fields: readonly TemplateField[];
	/** Variable name → initial value. Strings, numbers, or null. */
	initial?: Record<string, unknown>;
	/** When set, submits an edit to this doc instead of a new draft. */
	editingDocumentId?: string;
	/** Source linkage for new drafts (e.g., ?fromAsset → fixed_asset,
	 *  ?fromRental → rental_property). */
	source?: { kind: 'fixed_asset' | 'deposit_finding' | 'rental_property' | 'manual'; id: string };
	/** Optional note rendered above the fields (from template.formIntro
	 *  or page-level prefill context). */
	intro?: string;
	/** Submit button label override. Default 'Draft' / 'Save changes'. */
	submitLabel?: string;
}

const SEED_PLACEHOLDERS = new Set([
	'Allocation rationale pending — edit this memo before signing.',
	'Disposition rationale pending — edit this resolution before signing.',
]);

/**
 * Schema-driven form. Walks the supplied TemplateField list, renders
 * each field, collects values, converts cents-backed fields on
 * submit, and dispatches to draftResolution OR updateDocumentVariables.
 *
 * Validation: relied on zod re-validation in the server action.
 * Required-marker + native HTML required attribute are cosmetic
 * here; if the schema and the field meta disagree, the server
 * authoritative.
 */
export function GenericTemplateForm({
	templateId,
	fields,
	initial,
	editingDocumentId,
	source,
	intro,
	submitLabel,
}: Props) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [values, setValues] = useState<Record<string, string>>(() => seedValues(fields, initial ?? {}));

	const setField = (name: string, value: string) => {
		setValues((prev) => ({ ...prev, [name]: value }));
	};

	const onSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		const out: Record<string, unknown> = {};
		// Carry through fields the schema cares about but the form
		// doesn't render (e.g., sourceFindingId hidden back-pointer).
		for (const k of Object.keys(initial ?? {})) {
			if (!fields.some((f) => f.name === k)) {
				out[k] = (initial as Record<string, unknown>)[k];
			}
		}
		for (const f of fields) {
			if (f.visibleWhen && !isVisible(f, values)) {
				// Hidden conditional field — drop from payload so the
				// schema's `.optional().nullable()` accepts it as null.
				out[f.name] = null;
				continue;
			}
			const raw = values[f.name] ?? '';
			out[f.name] = coerceForSubmit(f, raw, setError);
			if (error) return;
		}
		startTransition(async () => {
			if (editingDocumentId) {
				const r = await updateDocumentVariables({
					documentRecordId: editingDocumentId,
					variables: out,
				});
				if (!r.ok) {
					setError(r.error ?? 'Save failed');
					return;
				}
				router.push(`/trust-documents/${editingDocumentId}`);
				return;
			}
			const r = await draftResolution({
				templateId,
				variables: out,
				source,
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

	const visibleFields = fields.filter((f) => isVisible(f, values));

	return (
		<form
			onSubmit={onSubmit}
			className="rounded-xl border border-zinc-300 bg-white p-5 shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/60 dark:ring-white/10"
		>
			{intro && (
				<div className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-200">
					{intro}
				</div>
			)}

			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				{visibleFields.map((f) => (
					<FieldRow
						key={f.name}
						field={f}
						value={values[f.name] ?? ''}
						onChange={(v) => setField(f.name, v)}
						disabled={pending}
					/>
				))}
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
							: (submitLabel ?? 'Draft')}
				</button>
			</div>
		</form>
	);
}

function FieldRow({
	field,
	value,
	onChange,
	disabled,
}: {
	field: TemplateField;
	value: string;
	onChange: (v: string) => void;
	disabled: boolean;
}) {
	const required = field.required !== false;
	const span = field.span === 2 ? 'md:col-span-2' : '';
	const labelEl = (
		<span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
			{field.label}
			{required && <span className="text-red-600"> *</span>}
		</span>
	);

	const inputCls = 'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900';

	let input: React.ReactNode;
	switch (field.widget) {
		case 'textarea':
			input = (
				<textarea
					value={value}
					onChange={(e) => onChange(e.target.value)}
					required={required}
					disabled={disabled}
					rows={field.rows ?? 3}
					placeholder={field.placeholder}
					className={inputCls}
				/>
			);
			break;
		case 'date':
			input = (
				<input
					type="date"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					required={required}
					disabled={disabled}
					className={inputCls}
				/>
			);
			break;
		case 'integer':
			input = (
				<input
					type="number"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					required={required}
					disabled={disabled}
					placeholder={field.placeholder}
					step={1}
					className={inputCls}
				/>
			);
			break;
		case 'dollars':
			input = (
				<input
					type="number"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					required={required}
					disabled={disabled}
					placeholder={field.placeholder}
					step="0.01"
					{...(field.signed ? {} : { min: '0' })}
					className={inputCls}
				/>
			);
			break;
		case 'select':
			input = (
				<select
					value={value}
					onChange={(e) => onChange(e.target.value)}
					required={required}
					disabled={disabled}
					className={inputCls}
				>
					{!value && <option value="">— Select —</option>}
					{(field.options ?? []).map((opt) => (
						<option key={opt.value} value={opt.value}>
							{opt.label}
						</option>
					))}
				</select>
			);
			break;
		case 'text':
		default:
			input = (
				<input
					type="text"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					required={required}
					disabled={disabled}
					placeholder={field.placeholder}
					className={inputCls}
				/>
			);
			break;
	}

	return (
		<label className={`flex flex-col gap-1 ${span}`}>
			{labelEl}
			{input}
		</label>
	);
}

function seedValues(
	fields: readonly TemplateField[],
	initial: Record<string, unknown>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const f of fields) {
		const raw = initial[f.name];
		if (raw == null) {
			// Date default to today for date widgets when otherwise empty.
			if (f.widget === 'date') out[f.name] = new Date().toISOString().slice(0, 10);
			else out[f.name] = '';
			continue;
		}
		if (f.widget === 'dollars' && typeof raw === 'number') {
			out[f.name] = (raw / 100).toFixed(2);
		} else if (typeof raw === 'string' && SEED_PLACEHOLDERS.has(raw)) {
			// Seeded placeholder from an auto-draft — drop it so the
			// field reads as empty and the user has to write real
			// content. (allocationJustification, dispositionRationale.)
			out[f.name] = '';
		} else {
			out[f.name] = String(raw);
		}
	}
	return out;
}

function isVisible(field: TemplateField, values: Record<string, string>): boolean {
	const cond = field.visibleWhen;
	if (!cond) return true;
	const raw = values[cond.field] ?? '';
	if ('in' in cond) {
		return cond.in.includes(raw);
	}
	// `gt` form — interpret the dependent field's value as a number.
	// Dollars widgets store as decimal strings; integer widgets store
	// as int strings; parseFloat covers both. Empty / non-numeric ⇒
	// treat as 0 (hidden).
	const n = Number.parseFloat(raw);
	return Number.isFinite(n) && n > cond.gt;
}

function coerceForSubmit(
	field: TemplateField,
	raw: string,
	setError: (s: string) => void,
): unknown {
	const trimmed = raw.trim();
	const required = field.required !== false;

	if (!trimmed) {
		if (required) {
			setError(`${field.label} is required`);
			return undefined;
		}
		return null;
	}

	switch (field.widget) {
		case 'dollars': {
			const n = Number.parseFloat(trimmed);
			if (!Number.isFinite(n)) {
				setError(`${field.label} must be a dollar value`);
				return undefined;
			}
			if (!field.signed && n < 0) {
				setError(`${field.label} must be non-negative`);
				return undefined;
			}
			return Math.round(n * 100);
		}
		case 'integer': {
			const n = Number.parseInt(trimmed, 10);
			if (!Number.isFinite(n)) {
				setError(`${field.label} must be a whole number`);
				return undefined;
			}
			return n;
		}
		default:
			return trimmed;
	}
}
