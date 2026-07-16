// TaxFormProvider — the seam every later piece plugs into.
//
// The crawler/job-runner is provider-agnostic: it walks tax_form_crawl_jobs and calls
// these capabilities for each form node:
//
//   acquire(ref)            -> fetch the official blank PDF + instructions for a form/year
//   comprehend(acquired)    -> derive the FormSpec "expertise" (the LLM step)
//   fill({pdfBytes,...})    -> produce the completed PDF (pdf-lib)
//
// Phase 1 ships `PdfFillProvider` (no vendor: official PDFs + pdf-lib). Later we can add
// a CalcApiProvider (vendor math) or an embedded-engine provider (Column Tax / april,
// e-file) behind this same interface without touching the crawler, intake, or UI.
//
// Server-only. The LLM used for comprehension is INJECTED (see Comprehender) so this
// module stays decoupled from any specific AI SDK.

import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";
import type { FormSpec } from "./spec";
import { buildFieldLabelMap } from "./field-labels";

export interface FormRef {
	jurisdiction: string; // 'US' or a state code, e.g. 'CA'
	formCode: string;     // '1040','SCH_C','4562'
	taxYear: number;
}

/** A field discovered in the blank PDF's AcroForm. */
export interface AcroFieldInfo {
	name: string;
	/** pdf-lib field constructor name: 'PDFTextField' | 'PDFCheckBox' | 'PDFRadioGroup' | ... */
	type: string;
	/** The form's printed label nearest this field (left/above), recovered positionally. */
	label?: string;
}

/** The archived blank form + provenance, produced by acquire(). */
export interface AcquiredForm {
	ref: FormRef;
	sourceUrl: string;
	sourceKind: "official" | "provider" | "manual_upload";
	pdfBytes: Uint8Array;
	/** Plain text of the instruction document, when available (fuels comprehension). */
	instructionsText?: string;
	/** SHA-256 of pdfBytes — the integrity key stored in tax_form_sources.sha256. */
	sha256: string;
	pdfVersion?: string;
	fieldDump: AcroFieldInfo[];
}

export type FieldValue = string | number | boolean | null;

export interface FillInput {
	/** The archived blank form bytes (the runner loads these from Storage). */
	pdfBytes: Uint8Array;
	spec: FormSpec;
	/** Resolved values keyed by FormSpec.fields[].key (line computation happens upstream). */
	values: Record<string, FieldValue>;
}

export interface FilledForm {
	pdfBytes: Uint8Array;
	/** Provided values whose key had no matching field in the spec (diagnostics). */
	unmappedKeys: string[];
	/** Spec field keys that were required by a line rule but had no value. */
	missingKeys: string[];
}

/**
 * The injected LLM capability that turns a blank form + instructions into a FormSpec.
 * The runner supplies a concrete implementation (see comprehend.ts); the provider never
 * imports an AI SDK directly.
 */
export type Comprehender = (acquired: AcquiredForm) => Promise<FormSpec>;

export interface TaxFormProvider {
	readonly name: string;
	acquire(ref: FormRef): Promise<AcquiredForm>;
	comprehend(acquired: AcquiredForm): Promise<FormSpec>;
	fill(input: FillInput): Promise<FilledForm>;
}

// ---------------------------------------------------------------------------
// Source resolution: where to fetch the canonical blank PDF for a (form, year).
// ---------------------------------------------------------------------------

/**
 * Resolves the official URL for a federal IRS form PDF, year-aware.
 * Current processing-year forms live under /pub/irs-pdf; prior years under /pub/irs-prior
 * with a `--YEAR` suffix. We can't know the "current" year statically, so callers pass the
 * tax year and we always use the prior-year archive path (it carries every year incl. the
 * most recent filed season). Verified reachable with browser headers (see IRS_FETCH_HEADERS).
 */
export function irsFormUrl(formCode: string, taxYear: number): string {
	const slug = IRS_SLUGS[formCode];
	if (!slug) {
		throw new Error(`No IRS slug registered for form '${formCode}' (add it to IRS_SLUGS)`);
	}
	return `https://www.irs.gov/pub/irs-prior/${slug}--${taxYear}.pdf`;
}

/** IRS form slugs the provider can acquire. Grows as the catalog grows; every business
 *  seed form in intake-tools' ENTITY_SEED_FORM map MUST have an entry here or its return
 *  dead-ends at acquisition. Slugs verified against /pub/irs-prior/<slug>--<year>.pdf. */
const IRS_SLUGS: Record<string, string> = {
	// 1040 (individual) family
	"1040": "f1040",
	SCH_1: "f1040s1",
	SCH_2: "f1040s2",
	SCH_3: "f1040s3",
	SCH_A: "f1040sa",
	SCH_B: "f1040sb",
	SCH_C: "f1040sc",
	SCH_D: "f1040sd",
	SCH_E: "f1040se",
	SCH_SE: "f1040sse",
	"4562": "f4562",
	// Business / entity seed forms (entity-type → seed in ENTITY_SEED_FORM)
	"1065": "f1065",   // partnership
	"1120": "f1120",   // C-corp
	"1120S": "f1120s", // S-corp
	"1041": "f1041",   // trust / estate
	"990": "f990",     // nonprofit
};

/**
 * Form codes (US/federal) the provider can currently ACQUIRE. The comprehender must only
 * emit dependencies whose formCode is in this set — anything else can't be fetched and the
 * crawler would dead-end on it. Grows in lockstep with IRS_SLUGS.
 */
export function knownIrsFormCodes(): string[] {
	return Object.keys(IRS_SLUGS);
}

/**
 * Browser-like headers required to fetch from irs.gov. Without a real User-Agent +
 * Referer the CDN (Akamai) returns 403 — that, not a hard block, was the only obstacle
 * to direct acquisition.
 */
export const IRS_FETCH_HEADERS: Record<string, string> = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	Accept: "application/pdf,*/*",
	"Accept-Language": "en-US,en;q=0.9",
	Referer: "https://www.irs.gov/forms-instructions-and-publications",
};

// ---------------------------------------------------------------------------
// PdfFillProvider — Phase 1, no-vendor implementation.
// ---------------------------------------------------------------------------

export interface PdfFillProviderOptions {
	/** Injected comprehension (LLM) capability. */
	comprehender: Comprehender;
	/** Override the URL resolver (e.g. to add state DOR sources or use a test fixture). */
	resolveUrl?: (ref: FormRef) => string;
	/** Override fetch (tests / fixtures). Defaults to global fetch. */
	fetchImpl?: typeof fetch;
	/** Extra request headers (defaults to IRS_FETCH_HEADERS for irs.gov). */
	headers?: Record<string, string>;
}

export class PdfFillProvider implements TaxFormProvider {
	readonly name = "pdf-fill";
	private readonly comprehender: Comprehender;
	private readonly resolveUrl: (ref: FormRef) => string;
	private readonly fetchImpl: typeof fetch;
	private readonly headers: Record<string, string>;

	constructor(opts: PdfFillProviderOptions) {
		this.comprehender = opts.comprehender;
		this.resolveUrl = opts.resolveUrl ?? ((ref) => {
			if (ref.jurisdiction !== "US") {
				throw new Error(`PdfFillProvider has no source resolver for jurisdiction '${ref.jurisdiction}' yet`);
			}
			return irsFormUrl(ref.formCode, ref.taxYear);
		});
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.headers = opts.headers ?? IRS_FETCH_HEADERS;
	}

	async acquire(ref: FormRef): Promise<AcquiredForm> {
		const url = this.resolveUrl(ref);
		const res = await this.fetchImpl(url, { headers: this.headers });
		if (!res.ok) {
			throw new Error(`Failed to acquire ${ref.formCode} (${ref.taxYear}) from ${url}: HTTP ${res.status}`);
		}
		const pdfBytes = new Uint8Array(await res.arrayBuffer());
		const sha256 = createHash("sha256").update(pdfBytes).digest("hex");

		// IRS PDFs are commonly flagged encrypted with an empty password (usage
		// restrictions, not real protection) — ignoreEncryption lets pdf-lib read them.
		const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

		// Recover each field's printed label positionally (IRS fields have no /TU tooltip),
		// so the comprehender maps against human-readable labels instead of opaque names.
		// Best-effort: a label-extraction failure must not block acquisition.
		let labels = new Map<string, string>();
		try {
			labels = await buildFieldLabelMap(pdfBytes);
		} catch {
			labels = new Map();
		}

		const fieldDump: AcroFieldInfo[] = doc.getForm().getFields().map((f) => {
			const name = f.getName();
			const label = labels.get(name);
			return { name, type: f.constructor.name, ...(label ? { label } : {}) };
		});

		return {
			ref,
			sourceUrl: url,
			sourceKind: "official",
			pdfBytes,
			sha256,
			fieldDump,
		};
	}

	comprehend(acquired: AcquiredForm): Promise<FormSpec> {
		return this.comprehender(acquired);
	}

	fill({ pdfBytes, spec, values }: FillInput): Promise<FilledForm> {
		return fillPdf(pdfBytes, spec, values);
	}
}

/**
 * Stamp resolved values onto a blank form PDF using its FormSpec field map.
 * Pure pdf-lib; no DB/network. The runner loads the archived bytes and calls this.
 */
export async function fillPdf(
	pdfBytes: Uint8Array,
	spec: FormSpec,
	values: Record<string, FieldValue>,
): Promise<FilledForm> {
	const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
	const form = doc.getForm();
	const unmappedKeys: string[] = [];
	const missingKeys: string[] = [];

	const byKey = new Map(spec.fields.map((f) => [f.key, f] as const));

	for (const [key, value] of Object.entries(values)) {
		const mapping = byKey.get(key);
		if (!mapping) {
			unmappedKeys.push(key);
			continue;
		}
		if (value === null || value === undefined) continue;
		try {
			if (mapping.type === "checkbox") {
				const cb = form.getCheckBox(mapping.acroField);
				if (value === true || value === "true" || value === "1") cb.check();
				else cb.uncheck();
			} else if (mapping.type === "radio") {
				const radio = form.getRadioGroup(mapping.acroField);
				if (mapping.radioValue != null) radio.select(mapping.radioValue);
			} else {
				const tf = form.getTextField(mapping.acroField);
				tf.setText(formatValue(value, mapping.type));
			}
		} catch {
			// Field named in the spec wasn't found in this PDF — record and continue.
			unmappedKeys.push(key);
		}
	}

	// Required-by-a-line-rule fields that received no value.
	for (const line of spec.lines) {
		if (line.fieldKey && line.source.kind === "input") {
			const has = Object.prototype.hasOwnProperty.call(values, line.fieldKey);
			if (!has) missingKeys.push(line.fieldKey);
		}
	}

	const out = await doc.save();
	return { pdfBytes: out, unmappedKeys, missingKeys };
}

function formatValue(value: FieldValue, type: string): string {
	if (type === "currency" && typeof value === "number") {
		return value.toFixed(2);
	}
	return String(value);
}
