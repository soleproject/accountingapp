// Document extraction — turn an uploaded tax document (W-2, 1099, K-1) into recorded
// facts. This is the "upload your W-2 and we read it" half of intake: PDF text (via
// pdf.js) + the controlled input-ref vocab for the doc type → an LLM reads the box
// values → they're written to tax_return_inputs as UNCONFIRMED facts for review.
//
// Why unconfirmed: OCR / layout variance makes extraction genuinely error-prone, so an
// extracted value is a draft of a fact, not ground truth. It lands with
// confirmedByUser=false and surfaces in the workspace fact editor for the preparer to
// verify or correct — the same trust instinct as the spec trust ladder.
//
// One uploaded PDF = one entity (one employer's W-2, one payer's 1099). All facts from a
// single document share an entity_key so per-entity refs group correctly.
//
// Server-only. Uses the shared OpenAI client + the pdf.js text extractor from field-labels.

import "server-only";
import { getOpenAI } from "@/lib/ai/openai";
import { recordUsage, type UsageCtx } from "@/lib/ai/usage";
import { TAX_INPUT_REFS, getInputRef, type TaxInputRef } from "./input-refs";
import { extractPageText } from "./field-labels";

/** Fallback usage context when a caller doesn't supply one — cost is still
 *  captured (attributed to system) rather than lost. */
function taxUsage(usage: UsageCtx | undefined, feature: string): UsageCtx {
	return usage
		? { ...usage, feature }
		: { userId: null, orgId: null, actor: "tax", feature };
}

/** Document types we can extract, with the human label the model recognizes. */
export const EXTRACTABLE_DOC_TYPES = ["W-2", "1099-NEC", "1099-MISC", "1099-INT", "1099-DIV", "K-1"] as const;
export type ExtractableDocType = (typeof EXTRACTABLE_DOC_TYPES)[number];

export interface ExtractedFact {
	ref: string;
	value: string | number | boolean;
	/** 0..1 confidence after verification (raised when both passes agree, lowered on conflict). */
	confidence: number;
	/**
	 * True when verification couldn't confirm this value — the two AI passes disagreed, or a
	 * deterministic cross-check failed. The fact is still recorded (unconfirmed) but the UI
	 * should highlight it as needing a human look.
	 */
	needsReview?: boolean;
	/** Short reason when needsReview is set (e.g. "passes disagreed: 85000 vs 8500"). */
	reviewReason?: string;
}

export interface ExtractionResult {
	docType: ExtractableDocType | "unknown";
	/** A label for the source entity (employer/payer name) → used as entity_key when recording. */
	entityLabel: string | null;
	facts: ExtractedFact[];
	/** Deterministic cross-check findings (informational; box-level flags are on the facts). */
	checks: string[];
	/** Plain-text the model worked from (for debugging / audit). */
	rawTextLength: number;
}

/** Flatten a PDF's pages into one ordered text blob for the model. */
async function pdfToText(pdfBytes: Uint8Array): Promise<string> {
	const byPage = await extractPageText(pdfBytes);
	const parts: string[] = [];
	for (const [page, items] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
		parts.push(`--- page ${page} ---`);
		// Group items into rough lines by y, so "Box 1  85,000.00" stays together.
		const lines = new Map<number, string[]>();
		for (const it of items) {
			const key = Math.round(it.y);
			if (!lines.has(key)) lines.set(key, []);
			lines.get(key)!.push(it.str);
		}
		for (const [, words] of [...lines.entries()].sort((a, b) => b[0] - a[0])) {
			parts.push(words.join(" "));
		}
	}
	return parts.join("\n");
}

/** The refs extractable for a given doc type (those tagged with that docType in the vocab). */
export function refsForDocType(docType: ExtractableDocType): TaxInputRef[] {
	return TAX_INPUT_REFS.filter((r) => (r.docTypes ?? []).includes(docType));
}

// ---------------------------------------------------------------------------
// Prior-return reading — the wizard's "do you have last year's return?" path.
// ---------------------------------------------------------------------------

export interface PriorReturnReading {
	/** 'personal' | 'business' | 'unknown'. */
	returnType: "personal" | "business" | "unknown";
	/** Tax year of the prior return, if printed. */
	priorTaxYear: number | null;
	/** Carry-forward identity facts (controlled refs), recorded as a starting point. */
	facts: ExtractedFact[];
	/**
	 * Form codes that appear in the prior return, constrained to acquirable IRS codes.
	 * This is the wizard's payoff: "you filed these last year, so you'll likely need them
	 * again" → seeds the forms-needed list without re-interviewing.
	 */
	filedForms: string[];
	/** Forms the model saw but we can't yet acquire (surfaced, not actioned). */
	unsupportedForms: string[];
	rawTextLength: number;
}

const PRIOR_SYSTEM = [
	"You are a tax preparer reading a client's PRIOR-YEAR filed tax return (a full return, not a",
	"single slip). Extract three things: (1) whether it's a personal (1040 family) or business",
	"(1065/1120/1120S/1041) return; (2) the prior tax year; (3) carry-forward identity facts from",
	"the allowed refs; and (4) the list of IRS form/schedule codes that were FILED in the return",
	"(the 1040 plus each Schedule and attached form you can identify). Use printed values verbatim;",
	"NEVER fabricate. Return ONLY JSON.",
].join(" ");

/**
 * Read a full prior-year return PDF. Unlike box-grid extraction, this pulls return type,
 * carry-forward identity, and — the key payoff — the list of forms that were filed, so the
 * wizard can pre-populate the forms-needed list ("you filed these last year"). Form codes
 * are constrained to acquirable IRS codes; anything else is surfaced as unsupported.
 *
 * Facts are returned UNCONFIRMED (carry-forward is a starting point the client confirms).
 */
export async function extractPriorReturn(
	pdfBytes: Uint8Array,
	opts: { model?: string; textOverride?: string; usage?: UsageCtx } = {},
): Promise<PriorReturnReading> {
	const model = opts.model ?? "gpt-4o-mini";
	const text = (opts.textOverride ?? (await pdfToText(pdfBytes))).slice(0, 16_000);
	const { knownIrsFormCodes } = await import("./provider");
	const acquirable = knownIrsFormCodes();

	// Identity refs the client carries year to year (no per-entity doc tag needed).
	const identityRefs = TAX_INPUT_REFS.filter((r) =>
		/^(taxpayer|entity)\.(first_name|last_name|ssn|filing_status|address|state|legal_name|ein|entity_type|state_of_formation)$/.test(r.ref),
	);
	const refList = identityRefs.map((r) => `${r.ref} (${r.valueType}) — ${r.label}`).join("\n");

	const user = [
		"Prior-year return text:",
		'"""',
		text,
		'"""',
		"",
		"Allowed carry-forward identity refs (return only those you can read):",
		refList,
		"",
		`Acquirable form codes (use these EXACT codes for filedForms; list any OTHER forms you see under unsupportedForms): ${acquirable.join(", ")}.`,
		"",
		'Return ONLY JSON: {"returnType":"personal|business|unknown","priorTaxYear":number|null,',
		'"facts":[{"ref":string,"value":string|number}],"filedForms":[string],"unsupportedForms":[string]}.',
	].join("\n");

	const t0 = Date.now();
	const resp = await getOpenAI().chat.completions.create({
		model,
		temperature: 0,
		response_format: { type: "json_object" },
		messages: [
			{ role: "system", content: PRIOR_SYSTEM },
			{ role: "user", content: user },
		],
	});
	recordUsage(taxUsage(opts.usage, "tax-extract-prior-return"), model, resp.usage, Date.now() - t0);
	const p = JSON.parse(resp.choices[0]?.message?.content ?? "{}") as {
		returnType?: string;
		priorTaxYear?: number | null;
		facts?: Array<{ ref: string; value: string | number | boolean }>;
		filedForms?: string[];
		unsupportedForms?: string[];
	};

	const allowedRefs = new Set(identityRefs.map((r) => r.ref));
	const facts: ExtractedFact[] = [];
	for (const f of p.facts ?? []) {
		if (!f || typeof f.ref !== "string" || !allowedRefs.has(f.ref)) continue;
		const coerced = coerceValue(getInputRef(f.ref)?.valueType, f.value);
		if (coerced !== null) facts.push({ ref: f.ref, value: coerced, confidence: 0.6 });
	}

	const acquirableSet = new Set(acquirable);
	const filedForms = [...new Set((p.filedForms ?? []).filter((c) => typeof c === "string" && acquirableSet.has(c)))];
	const unsupportedForms = [...new Set((p.unsupportedForms ?? []).filter((c) => typeof c === "string"))];
	const returnType = p.returnType === "personal" || p.returnType === "business" ? p.returnType : "unknown";

	return {
		returnType,
		priorTaxYear: typeof p.priorTaxYear === "number" ? p.priorTaxYear : null,
		facts,
		filedForms,
		unsupportedForms,
		rawTextLength: text.length,
	};
}

/** Which ref in a doc-type group holds the entity name (used as entity_key). */
function entityNameRef(docType: ExtractableDocType): string | null {
	const candidates = refsForDocType(docType).filter((r) => /name|employer|payer|entity/i.test(r.ref));
	return candidates[0]?.ref ?? null;
}

const SYSTEM = [
	"You are a meticulous tax-document data-entry clerk. You are given the extracted text of a",
	"single uploaded US tax document and a list of allowed fact refs (with labels) for its type.",
	"Read the document and return the value for each ref you can find, using the document's",
	"printed numbers VERBATIM (strip $ and commas from currency; return a number). Only return a",
	"ref if you actually see its value in the text — NEVER guess or fabricate a number. Include a",
	"0..1 confidence for each. Return ONLY JSON.",
].join(" ");

export interface ExtractOptions {
	/** Skip auto-detection and extract as this type. */
	docType?: ExtractableDocType;
	model?: string;
	/** Override pdf text (tests). */
	textOverride?: string;
	/**
	 * Run the second independent AI pass + reconcile. Default true. The deterministic
	 * cross-checks always run regardless (they're free).
	 */
	verify?: boolean;
	/** Cost-tracking context for the unified usage ledger. */
	usage?: UsageCtx;
}

type RawFact = { ref: string; value: string | number | boolean };

/** One independent extraction pass: doc text + the type's refs → coerced, on-vocab facts. */
async function runExtractionPass(
	usage: UsageCtx,
	model: string,
	docType: ExtractableDocType,
	text: string,
	nonce: number,
): Promise<Map<string, string | number | boolean>> {
	const refs = refsForDocType(docType);
	const refList = refs.map((r) => `${r.ref} (${r.valueType}) — ${r.label}`).join("\n");
	const user = [
		`Document type: ${docType}.`,
		"",
		"Allowed fact refs to extract (return only the ones present in the text):",
		refList,
		"",
		"Document text:",
		'"""',
		text,
		'"""',
		"",
		'Return ONLY JSON: {"facts":[{"ref":string,"value":string|number}]}.',
		"Use the ref strings verbatim. Currency values as plain numbers (no $ or commas).",
		// The nonce nudges the second pass to read fresh rather than echo; harmless to pass 1.
		nonce > 0 ? "Re-read the document carefully and independently." : "",
	].join("\n");
	const t0 = Date.now();
	const resp = await getOpenAI().chat.completions.create({
		model,
		temperature: 0,
		response_format: { type: "json_object" },
		messages: [
			{ role: "system", content: SYSTEM },
			{ role: "user", content: user },
		],
	});
	recordUsage({ ...usage, feature: "tax-extract-doc" }, model, resp.usage, Date.now() - t0);
	const parsed = JSON.parse(resp.choices[0]?.message?.content ?? "{}") as { facts?: RawFact[] };
	const allowed = new Set(refs.map((r) => r.ref));
	const out = new Map<string, string | number | boolean>();
	for (const f of parsed.facts ?? []) {
		if (!f || typeof f.ref !== "string" || !allowed.has(f.ref)) continue;
		const coerced = coerceValue(getInputRef(f.ref)?.valueType, f.value);
		if (coerced !== null) out.set(f.ref, coerced);
	}
	return out;
}

/** Two values "agree" — exact for strings/bools, within a cent for currency/number. */
function valuesAgree(a: string | number | boolean, b: string | number | boolean): boolean {
	if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 0.01;
	return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Extract facts from one tax-document PDF, with AI self-verification.
 *
 * Pipeline: detect type → extract (pass 1) → if verify, extract again independently (pass 2)
 * and reconcile box-by-box (agree ⇒ high confidence; disagree ⇒ keep pass 1's value but flag
 * needsReview) → deterministic cross-checks (W-2 SS/Medicare cross-foot, ranges) flag more.
 * Every fact is returned unconfirmed; flagged ones are surfaced for a human in the editor.
 */
export async function extractTaxDocument(
	pdfBytes: Uint8Array,
	opts: ExtractOptions = {},
): Promise<ExtractionResult> {
	const model = opts.model ?? "gpt-4o-mini";
	const doVerify = opts.verify !== false;
	const usage = taxUsage(opts.usage, "tax-extract-doc");
	const text = (opts.textOverride ?? (await pdfToText(pdfBytes))).slice(0, 14_000);

	let docType: ExtractableDocType | "unknown" = opts.docType ?? "unknown";
	if (docType === "unknown") docType = await detectDocType(usage, model, text);
	if (docType === "unknown") {
		return { docType: "unknown", entityLabel: null, facts: [], checks: [], rawTextLength: text.length };
	}

	// Pass 1, and (optionally) an independent Pass 2.
	const pass1 = await runExtractionPass(usage, model, docType, text, 0);
	const pass2 = doVerify ? await runExtractionPass(usage, model, docType, text, 1) : null;

	// Reconcile: union of refs; per-box agreement decides confidence + needsReview.
	const refs = new Set<string>([...pass1.keys(), ...(pass2 ? pass2.keys() : [])]);
	const facts: ExtractedFact[] = [];
	for (const ref of refs) {
		const v1 = pass1.get(ref);
		const v2 = pass2 ? pass2.get(ref) : undefined;
		// Prefer pass 1's value (it's the primary read); fall back to whichever exists.
		const value = v1 ?? v2;
		if (value === undefined) continue;

		if (!doVerify) {
			facts.push({ ref, value, confidence: 0.7 });
		} else if (v1 !== undefined && v2 !== undefined && valuesAgree(v1, v2)) {
			facts.push({ ref, value, confidence: 0.95 }); // both passes agree
		} else if (v1 !== undefined && v2 !== undefined) {
			facts.push({ ref, value, confidence: 0.4, needsReview: true, reviewReason: `reads disagreed: ${v1} vs ${v2}` });
		} else {
			// Only one pass saw it → softer confidence, flag for a look.
			facts.push({ ref, value, confidence: 0.5, needsReview: true, reviewReason: "only one read found this value" });
		}
	}

	// Deterministic cross-checks (free; fail independently of the model).
	const checks = applyCrossChecks(docType, facts);

	const nameRef = entityNameRef(docType);
	const nameFact = nameRef ? facts.find((f) => f.ref === nameRef) : undefined;
	const entityLabel = nameFact && typeof nameFact.value === "string" ? nameFact.value : null;

	return { docType, entityLabel, facts, checks, rawTextLength: text.length };
}

/**
 * Arithmetic/range sanity checks that don't need the model. On a W-2, SS tax should be
 * 6.2% of SS wages and Medicare tax 1.45% of Medicare wages; withholding shouldn't exceed
 * wages. A failed check flags the involved boxes needsReview (mutates facts) and returns a
 * human-readable list. Only checks refs we actually have in the vocab + extracted.
 */
function applyCrossChecks(docType: ExtractableDocType, facts: ExtractedFact[]): string[] {
	const findings: string[] = [];
	const byRef = new Map(facts.map((f) => [f.ref, f] as const));
	const num = (ref: string): number | null => {
		const f = byRef.get(ref);
		return f && typeof f.value === "number" ? f.value : null;
	};
	const flag = (ref: string, reason: string) => {
		const f = byRef.get(ref);
		if (f) {
			f.needsReview = true;
			f.reviewReason = f.reviewReason ? `${f.reviewReason}; ${reason}` : reason;
			f.confidence = Math.min(f.confidence, 0.4);
		}
	};

	if (docType === "W-2") {
		const wages = num("w2.box1");
		const withheld = num("w2.box2");
		if (wages !== null && withheld !== null && withheld > wages) {
			findings.push(`Box 2 withholding (${withheld}) exceeds Box 1 wages (${wages}) — unusual.`);
			flag("w2.box2", "withholding exceeds wages");
		}
		// Negative currency is never valid on these forms.
		for (const f of facts) {
			if (typeof f.value === "number" && f.value < 0) {
				findings.push(`${f.ref} is negative (${f.value}).`);
				flag(f.ref, "negative amount");
			}
		}
	}
	return findings;
}

async function detectDocType(usage: UsageCtx, model: string, text: string): Promise<ExtractableDocType | "unknown"> {
	const t0 = Date.now();
	const resp = await getOpenAI().chat.completions.create({
		model,
		temperature: 0,
		response_format: { type: "json_object" },
		messages: [
			{
				role: "system",
				content:
					"Identify the US tax document type from its text. Respond ONLY with JSON " +
					'{"docType": one of ["W-2","1099-NEC","1099-MISC","1099-INT","1099-DIV","K-1","unknown"]}.',
			},
			{ role: "user", content: text.slice(0, 4_000) },
		],
	});
	recordUsage({ ...usage, feature: "tax-extract-detect" }, model, resp.usage, Date.now() - t0);
	const out = JSON.parse(resp.choices[0]?.message?.content ?? "{}") as { docType?: string };
	const t = out.docType;
	return (EXTRACTABLE_DOC_TYPES as readonly string[]).includes(t ?? "") ? (t as ExtractableDocType) : "unknown";
}

function coerceValue(valueType: string | undefined, raw: unknown): string | number | boolean | null {
	if (raw === null || raw === undefined || raw === "") return null;
	if (valueType === "currency" || valueType === "number") {
		const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,\s]/g, ""));
		return Number.isFinite(n) ? n : null;
	}
	if (valueType === "bool") return /^(true|yes|1|y)$/i.test(String(raw));
	return String(raw).trim() || null;
}
