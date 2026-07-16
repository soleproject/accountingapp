// Minimal line-rule evaluator for Phase 1 of the vertical slice.
//
// Turns collected facts (keyed by controlled input refs) into field values keyed by
// FormSpec.fields[].key, which fillPdf() then stamps onto the PDF.
//
// Phase 1 resolves two sources: direct field-key matches and {kind:'input'}/{kind:'constant'}
// line rules. {kind:'formula'} and {kind:'carry'} are deferred to the compute/calc-engine
// phase — they require an expression evaluator and cross-form value flow, which is exactly
// the boundary where a calc-API provider plugs in behind the seam.

import type { FormSpec } from "./spec";
import type { FieldValue } from "./provider";

export interface ComputeResult {
	values: Record<string, FieldValue>;
	/** Line ids skipped because their source kind isn't supported yet (diagnostics). */
	deferred: string[];
}

export function resolveFieldValues(
	spec: FormSpec,
	inputs: Record<string, FieldValue>,
): ComputeResult {
	const values: Record<string, FieldValue> = {};
	const deferred: string[] = [];
	const has = (obj: Record<string, unknown>, k: string) =>
		Object.prototype.hasOwnProperty.call(obj, k);

	// Direct: a field whose semantic key is itself a provided input ref (e.g. 'taxpayer.ssn').
	for (const f of spec.fields) {
		if (has(inputs, f.key)) values[f.key] = inputs[f.key];
	}

	// Line rules.
	for (const line of spec.lines) {
		if (!line.fieldKey) continue;
		const src = line.source;
		if (src.kind === "input") {
			if (has(inputs, src.ref)) values[line.fieldKey] = inputs[src.ref];
		} else if (src.kind === "constant") {
			values[line.fieldKey] = src.value;
		} else {
			deferred.push(line.id); // formula | carry — handled in a later phase
		}
	}

	return { values, deferred };
}
