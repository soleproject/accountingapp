// FormSpec — the structured "expertise" an AI agent derives for a single tax form
// (one jurisdiction + form_code + tax year). Persisted as JSONB in tax_form_specs.spec
// (see db/schema/tax.ts and db/migrations/0097_tax_returns.sql).
//
// The crawler reads `triggers` (is this form required?) and `dependencies` (what other
// forms does it pull in?) to walk the form graph. The fill engine reads `fields`
// (semantic name -> physical AcroForm field) and `lines` (where each value comes from).
//
// A spec is learned once per (jurisdiction, form_code, tax_year) and reused for every
// client — it contains NO client-specific data, only knowledge about the blank form.

/** Bump when the FormSpec shape changes in a non-backward-compatible way. */
export const FORM_SPEC_SCHEMA_VERSION = 1;

export type TaxJurisdiction = string; // 'US' or a two-letter state code, e.g. 'CA'

export type FieldType =
	| "text"
	| "number"
	| "currency"
	| "checkbox"
	| "date"
	| "radio";

/** Maps a stable semantic key to the physical AcroForm field in the PDF. */
export interface FieldMapping {
	/** Semantic key, e.g. 'taxpayer.ssn' or 'line_1z_wages'. */
	key: string;
	/** Exact AcroForm field id present in the source PDF. */
	acroField: string;
	/** 0-based page index. */
	page: number;
	type: FieldType;
	/** For checkbox/radio: the on-value to set. */
	radioValue?: string;
}

/** Where a single line's value comes from. */
export type LineSource =
	| { kind: "input"; ref: string }                                  // a collected fact (input-refs.ts)
	| { kind: "formula"; expr: string; refs: string[] }               // computed from other line ids
	| { kind: "carry"; fromForm: string; fromLine: string }           // pulled from another form's line
	| { kind: "constant"; value: number | string };

export type ValueType = "currency" | "number" | "text" | "bool";

/** Line-by-line logic for the form. */
export interface LineRule {
	/** Line id, e.g. 'line_9'. */
	id: string;
	label: string;
	/** Which FieldMapping.key this line writes into, if any. */
	fieldKey?: string;
	source: LineSource;
	valueType: ValueType;
}

/** A fact this form needs, sourced from intake answers or uploaded documents. */
export interface InputRequirement {
	/** Controlled-vocabulary ref, e.g. 'w2.box1' (validated against input-refs.ts). */
	ref: string;
	label: string;
	/** Document types that typically carry this value, e.g. ['W-2','1099-NEC']. */
	docTypes?: string[];
	required: boolean;
}

/** Condition under which the form (or a dependency) is required. Empty string = always. */
export interface Trigger {
	description: string;
	/** Boolean expression over input refs and line ids; '' means unconditional. */
	condition: string;
}

export type FormRelationship = "attaches" | "carries_to" | "supports" | "state_of";

/** How many copies of a dependency a return may hold. */
export type Multiplicity = "one" | "per_entity";

/** A reference from this form to another form (drives the recursive crawl). */
export interface Dependency {
	formCode: string;
	jurisdiction: TaxJurisdiction; // may differ from the parent (federal -> state)
	relationship: FormRelationship;
	/** When the dependency fires; '' means always. */
	condition: string;
	/** Value flow from this form's lines into the referenced form's lines. */
	carryMap?: Array<{ fromLine: string; toLine: string }>;
	multiplicity: Multiplicity;
}

/** A tie-out / sanity check run during the verify step. */
export interface Validation {
	description: string;
	/** Boolean assertion over line ids that must hold; failure flags the form. */
	assert: string;
}

export interface FormSpec {
	schemaVersion: number; // === FORM_SPEC_SCHEMA_VERSION at creation time
	formCode: string;
	jurisdiction: TaxJurisdiction;
	taxYear: number;
	title: string;

	fields: FieldMapping[];
	lines: LineRule[];
	inputs: InputRequirement[];
	triggers: Trigger[];
	dependencies: Dependency[];
	validations: Validation[];

	/** Links back to the archived source PDF the spec was derived from. */
	provenance: { sourceId: string; sha256: string };
	/** Model self-rated 0..1; informs initial placement on the trust ladder. */
	confidence: number;
}

/** Trust ladder for a persisted spec (mirrors tax_form_specs.trust_status). */
export type SpecTrustStatus = "learned" | "verified" | "locked" | "deprecated";
