// openAiComprehender — the injected LLM capability that turns an acquired blank form
// (its AcroForm field list + recovered labels + optionally instructions) into a FormSpec.
// This is the "becomes an expert" step. Output starts at trust_status='learned' (draft) —
// a preparer promotes it.
//
// Two-pass design for accuracy:
//   PASS 1 (map):    produce the FormSpec — fields, lines, inputs, triggers, dependencies.
//   PASS 2 (verify): re-examine ONLY the field→acroField mappings against each field's
//                    printed label, and emit a corrected mapping list. This catches the
//                    common failure (mapping SSN/income to the wrong opaque field name).
// Both passes are defensively post-filtered: every emitted acroField must actually exist
// in the form, and dependency formCodes must be acquirable.
//
// Server-only. Uses the shared OpenAI client (@/lib/ai/openai).

import { getOpenAI } from "@/lib/ai/openai";
import { recordUsage, type UsageCtx } from "@/lib/ai/usage";
import type { AcquiredForm, Comprehender } from "./provider";
import { knownIrsFormCodes } from "./provider";
import type { FormSpec, FieldMapping } from "./spec";
import { FORM_SPEC_SCHEMA_VERSION } from "./spec";
import { TAX_INPUT_REFS } from "./input-refs";

const MAP_SYSTEM = [
	"You are a senior tax-form analyst with deep knowledge of US federal tax forms.",
	"Given a blank IRS form's AcroForm fields — each shown as `acroFieldName [type] :: printed label` —",
	"produce a FormSpec JSON with two distinct jobs, held to different standards:",
	"(1) FIELD MAPPING — map the form's lines/inputs to AcroForm field NAMES. The printed",
	"label is your ground truth: match a line to the field whose label describes it. Use the",
	"acroField NAME verbatim (the token before [type], e.g. `topmostSubform[0].Page1[0].f1_05[0]`),",
	"NOT the label. STRONGLY prefer an allowed input ref as the `key` — only invent a snake_case",
	"key when no allowed ref fits (an invented key can never be filled, so use them sparingly).",
	"RESPECT THE RETURN TYPE: `taxpayer.*` refs are for INDIVIDUAL (1040) forms only — never map",
	"them on a business/entity return (1065/1120/1120S/1041), which use `entity.*` refs for the",
	"name/EIN/address/income. Map each input ref to AT MOST ONE field — if you can't tell which of",
	"several candidate fields is the right one for a ref, map none of them rather than all. Be",
	"CONSERVATIVE: only map when the label makes the match clear; skip a field rather than guess.",
	"(2) DEPENDENCY GRAPH — list the other forms this form pulls in. Here be THOROUGH: under-",
	"listing dependencies is a worse error than over-listing them.",
	"Return ONLY JSON.",
].join(" ");

const VERIFY_SYSTEM = [
	"You are a meticulous tax-form QA reviewer. You are given a form's AcroForm fields (each",
	"with its printed label) and a proposed list of field mappings. Audit EACH mapping: does the",
	"acroField's printed label actually match what the mapping's key claims? Return a corrected",
	"mappings array — fix the acroField when a better-matching field exists, drop a mapping when",
	"no field on the form matches its key, and add a mapping when an allowed input ref clearly",
	"matches an unmapped field's label. Only use acroField names present in the provided list.",
	"Return ONLY JSON: {\"fields\":[...]} using the same field-mapping shape.",
].join(" ");

export interface ComprehenderOptions {
	model?: string;
	/** Set false to skip the verify/repair pass (faster, used in some tests). Default true. */
	verify?: boolean;
	/** Cost-tracking context for the unified usage ledger. Form-spec learning is
	 *  global/system work, so this defaults to a system context when omitted. */
	usage?: UsageCtx;
}

function fieldLines(acquired: AcquiredForm): string {
	return acquired.fieldDump
		.map((f) => `${f.name} [${f.type}]${f.label ? ` :: ${f.label}` : ""}`)
		.join("\n");
}

const FIELD_SHAPE =
	'{"key":string,"acroField":string,"page":number,"type":"text|number|currency|checkbox|date|radio","radioValue"?:string}';

export function openAiComprehender(opts: ComprehenderOptions = {}): Comprehender {
	const model = opts.model ?? "gpt-4o-mini";
	const doVerify = opts.verify !== false;
	const usage: UsageCtx = opts.usage ?? { userId: null, orgId: null, actor: "tax", feature: "tax-comprehend" };

	return async (acquired: AcquiredForm): Promise<FormSpec> => {
		const refList = TAX_INPUT_REFS.map((r) => `${r.ref} — ${r.label}`).join("\n");
		const fields = fieldLines(acquired);
		const instr = (acquired.instructionsText ?? "").slice(0, 12_000);
		const acquirableCodes = knownIrsFormCodes();
		const validAcro = new Set(acquired.fieldDump.map((f) => f.name));

		// ---- PASS 1: map ----
		const user = [
			`Form: ${acquired.ref.formCode} (${acquired.ref.jurisdiction}, tax year ${acquired.ref.taxYear}).`,
			"",
			"AcroForm fields — `acroFieldName [type] :: printed label`:",
			fields || "(none found)",
			"",
			"Allowed input refs (use these exact strings for field keys, {source:{kind:'input',ref}}, and in conditions):",
			refList,
			instr ? `\nInstructions excerpt:\n${instr}` : "",
			"",
			"=== DEPENDENCIES — read carefully ===",
			"List every OTHER form this form commonly attaches, carries values to, or is supported by.",
			"HARD RULES for the `dependencies` array:",
			`- formCode MUST be one of these acquirable codes (omit any dependency you can't express with one): ${acquirableCodes.join(", ")}.`,
			`- NEVER list this form itself (${acquired.ref.formCode}) as its own dependency.`,
			"- A return NEVER attaches another ENTITY-LEVEL return. 1040, 1065, 1120, 1120S, 1041,",
			"  and 990 are mutually-exclusive return types — they are alternatives, not parents of",
			"  each other. E.g. an 1120S does NOT attach an 1120; a 1065 does NOT attach a 1040.",
			"  Only list SCHEDULES and supporting forms (SCH_*, 4562) as dependencies.",
			"- jurisdiction is 'US' for all of these.",
			"- relationship: 'attaches' (a schedule attached to the return), 'carries_to' (a value",
			"  flows into a parent line), 'supports' (a form backing another, e.g. 4562 supports",
			"  Schedule C/E or a business return), or 'state_of' (state mirror of a federal form).",
			"- multiplicity: 'per_entity' when there can be several (one Schedule C per business,",
			"  one Schedule E per property); otherwise 'one'.",
			"- condition: a boolean over the allowed input refs using has(ref) and comparisons",
			"  (>, <, >=, <=, ==, !=) joined with && / || / !. Empty string \"\" means always.",
			"  Write conditions over INPUT REFS, never over line ids.",
			"",
			"Reference dependency patterns (apply the set matching THIS form's family):",
			"Form 1040 (individual):",
			'  - SCH_C  attaches, per_entity — "has(business.name) || has(1099nec.box1)"',
			'  - SCH_SE attaches, per_entity — "has(business.net_profit) || has(1099nec.box1)"',
			'  - SCH_B  attaches, one — "has(1099int.box1) || has(1099div.box1a)"',
			'  - SCH_E  attaches, per_entity — "has(k1.ordinary_income)"',
			'  - SCH_1  attaches, one — "has(business.name) || has(k1.ordinary_income)"',
			'  - SCH_2  attaches, one — "has(business.net_profit) || has(1099nec.box1)"',
			'  - SCH_A  attaches, one — "deductions.use_standard == false"',
			'  - 4562   supports, one — "has(business.name)"',
			"Form 1065 (partnership) / 1120 (C-corp) / 1120S (S-corp) — business returns:",
			'  - 4562   supports, one — "has(entity.gross_receipts)"  (depreciation backing the return)',
			"  - (Schedules K-1 are PER-OWNER and not yet acquirable — OMIT them for now.)",
			"  - Do NOT attach any individual-level schedule (SCH_C/SE/A/B/E) to a business return.",
			"If none of the patterns fit this form, return an empty dependencies array.",
			"",
			"Return ONLY JSON of shape:",
			`{"title":string,"fields":[${FIELD_SHAPE}],`,
			'"lines":[{"id":string,"label":string,"fieldKey"?:string,"source":{"kind":"input","ref":string}|{"kind":"formula","expr":string,"refs":string[]}|{"kind":"carry","fromForm":string,"fromLine":string}|{"kind":"constant","value":number|string},"valueType":"currency|number|text|bool"}],',
			'"inputs":[{"ref":string,"label":string,"docTypes"?:string[],"required":boolean}],',
			'"triggers":[{"description":string,"condition":string}],',
			'"dependencies":[{"formCode":string,"jurisdiction":string,"relationship":"attaches|carries_to|supports|state_of","condition":string,"carryMap"?:[{"fromLine":string,"toLine":string}],"multiplicity":"one|per_entity"}],',
			'"validations":[{"description":string,"assert":string}],"confidence":number}',
		].join("\n");

		const t0 = Date.now();
		const resp = await getOpenAI().chat.completions.create({
			model,
			temperature: 0,
			response_format: { type: "json_object" },
			messages: [
				{ role: "system", content: MAP_SYSTEM },
				{ role: "user", content: user },
			],
		});
		recordUsage({ ...usage, feature: "tax-comprehend-map" }, model, resp.usage, Date.now() - t0);
		const p = JSON.parse(resp.choices[0]?.message?.content ?? "{}") as Partial<FormSpec> & { confidence?: number };

		// Keep only mappings whose acroField actually exists on the form, then dedupe.
		let mappedFields = dedupeMappings((p.fields ?? []).filter((f) => validAcro.has(f.acroField)));

		// ---- PASS 2: verify / repair the mappings ----
		if (doVerify && acquired.fieldDump.some((f) => f.label)) {
			try {
				mappedFields = dedupeMappings(await verifyMappings(usage, model, acquired, refList, fields, mappedFields, validAcro));
			} catch {
				// Verification is best-effort; keep pass-1 mappings on failure.
			}
		}

		// Dependency post-filter (defense in depth — the prompt forbids these too):
		//  • must reference an acquirable form,
		//  • never the form itself (self-dependency → infinite/degenerate crawl),
		//  • never another entity-level return (those are alternative return TYPES, not
		//    sub-forms — an 1120S attaching an 1120 would fill a whole wrong return).
		const acquirable = new Set(acquirableCodes);
		const ENTITY_RETURNS = new Set(["1040", "1065", "1120", "1120S", "1041", "990"]);
		const self = acquired.ref.formCode;
		const deps = (p.dependencies ?? []).filter((d) => {
			if (d.jurisdiction === "US" && !acquirable.has(d.formCode)) return false;
			if (d.formCode === self) return false;
			if (ENTITY_RETURNS.has(self) && ENTITY_RETURNS.has(d.formCode)) return false;
			return true;
		});

		return {
			schemaVersion: FORM_SPEC_SCHEMA_VERSION,
			formCode: acquired.ref.formCode,
			jurisdiction: acquired.ref.jurisdiction,
			taxYear: acquired.ref.taxYear,
			title: p.title ?? acquired.ref.formCode,
			fields: mappedFields,
			lines: p.lines ?? [],
			inputs: p.inputs ?? [],
			triggers: p.triggers ?? [],
			dependencies: deps,
			validations: p.validations ?? [],
			provenance: { sourceId: "", sha256: acquired.sha256 }, // sourceId set by the runner
			confidence: typeof p.confidence === "number" ? p.confidence : 0.3,
		};
	};
}

/**
 * Enforce one-field-per-key and one-key-per-field. A semantic key mapped to several fields
 * (or a field claimed by several keys) means the model guessed — and `fillPdf` would stamp
 * one value into many boxes (or pick a box arbitrarily). Dropping ALL of an ambiguous set is
 * safer than guessing: a blank box is caught at preparer review, a wrong box silently lands
 * a value where it doesn't belong. Unique mappings pass through untouched.
 */
function dedupeMappings(fields: FieldMapping[]): FieldMapping[] {
	const byKey = new Map<string, number>();
	const byAcro = new Map<string, number>();
	for (const f of fields) {
		byKey.set(f.key, (byKey.get(f.key) ?? 0) + 1);
		byAcro.set(f.acroField, (byAcro.get(f.acroField) ?? 0) + 1);
	}
	return fields.filter((f) => byKey.get(f.key) === 1 && byAcro.get(f.acroField) === 1);
}

async function verifyMappings(
	usage: UsageCtx,
	model: string,
	acquired: AcquiredForm,
	refList: string,
	fields: string,
	proposed: FieldMapping[],
	validAcro: Set<string>,
): Promise<FieldMapping[]> {
	const user = [
		`Form: ${acquired.ref.formCode} (tax year ${acquired.ref.taxYear}).`,
		"",
		"AcroForm fields — `acroFieldName [type] :: printed label`:",
		fields,
		"",
		"Allowed input refs (preferred keys):",
		refList,
		"",
		"Proposed mappings to audit:",
		JSON.stringify(proposed),
		"",
		`Return ONLY JSON {"fields":[${FIELD_SHAPE}]} with the corrected mappings.`,
	].join("\n");

	const t0 = Date.now();
	const resp = await getOpenAI().chat.completions.create({
		model,
		temperature: 0,
		response_format: { type: "json_object" },
		messages: [
			{ role: "system", content: VERIFY_SYSTEM },
			{ role: "user", content: user },
		],
	});
	recordUsage({ ...usage, feature: "tax-comprehend-verify" }, model, resp.usage, Date.now() - t0);
	const out = JSON.parse(resp.choices[0]?.message?.content ?? "{}") as { fields?: FieldMapping[] };
	const verified = (out.fields ?? []).filter((f) => f && typeof f.acroField === "string" && validAcro.has(f.acroField));
	// If verification returned nothing usable, fall back to the proposed set.
	return verified.length ? verified : proposed;
}
