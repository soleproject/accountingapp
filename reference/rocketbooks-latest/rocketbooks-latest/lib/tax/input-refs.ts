// Controlled vocabulary for tax input refs.
//
// A FormSpec.inputs[].ref and a tax_return_inputs.ref must both come from this
// registry, so document-extraction and form specs always agree on what a fact is
// called. Refs are namespaced `<group>.<field>` (e.g. 'w2.box1'). Document-sourced
// groups mirror the boxes of the underlying IRS information return; derived groups
// hold values the system computes or the client answers directly.
//
// This is knowledge, not client data — adding a ref here is how the vocabulary grows.

export interface TaxInputRef {
	/** Namespaced key, e.g. 'w2.box1'. Stored verbatim in tax_return_inputs.ref. */
	ref: string;
	label: string;
	valueType: "currency" | "number" | "text" | "bool" | "date";
	/** Document types this typically comes from; omit for client-answered facts. */
	docTypes?: string[];
	/**
	 * True when a return may hold several values for this ref (e.g. multiple W-2s,
	 * multiple Schedule C businesses). Such rows are disambiguated by entity_key.
	 */
	perEntity?: boolean;
}

export const TAX_INPUT_REFS: TaxInputRef[] = [
	// --- Taxpayer identity (client-answered) -------------------------------
	{ ref: "taxpayer.first_name", label: "Taxpayer first name", valueType: "text" },
	{ ref: "taxpayer.last_name", label: "Taxpayer last name", valueType: "text" },
	{ ref: "taxpayer.ssn", label: "Taxpayer SSN", valueType: "text" },
	{ ref: "taxpayer.filing_status", label: "Filing status", valueType: "text" },
	{ ref: "taxpayer.address", label: "Mailing address", valueType: "text" },
	{ ref: "taxpayer.state", label: "Resident state", valueType: "text" },
	{ ref: "taxpayer.dependents_count", label: "Number of dependents", valueType: "number" },

	// --- Business / entity identity (client-answered) ----------------------
	{ ref: "entity.legal_name", label: "Entity legal name", valueType: "text" },
	{ ref: "entity.ein", label: "Employer Identification Number", valueType: "text" },
	{ ref: "entity.entity_type", label: "Entity type", valueType: "text" },
	{ ref: "entity.state_of_formation", label: "State of formation", valueType: "text" },
	{ ref: "entity.address", label: "Entity mailing address", valueType: "text" },
	{ ref: "entity.principal_business_activity", label: "Principal business activity", valueType: "text" },
	{ ref: "entity.business_code", label: "Business activity / product code", valueType: "text" },
	{ ref: "entity.date_incorporated", label: "Date incorporated / formed", valueType: "date" },

	// --- Business / entity return line items (1065 / 1120 / 1120S) ----------
	{ ref: "entity.gross_receipts", label: "Gross receipts or sales", valueType: "currency" },
	{ ref: "entity.cogs", label: "Cost of goods sold", valueType: "currency" },
	{ ref: "entity.salaries_wages", label: "Salaries and wages", valueType: "currency" },
	{ ref: "entity.total_deductions", label: "Total deductions", valueType: "currency" },
	{ ref: "entity.ordinary_business_income", label: "Ordinary business income (loss)", valueType: "currency" },
	{ ref: "entity.number_of_owners", label: "Number of partners / shareholders (K-1 count)", valueType: "number" },

	// --- W-2 (per employer) ------------------------------------------------
	{ ref: "w2.employer_name", label: "W-2 employer name", valueType: "text", docTypes: ["W-2"], perEntity: true },
	{ ref: "w2.box1", label: "W-2 box 1 — wages", valueType: "currency", docTypes: ["W-2"], perEntity: true },
	{ ref: "w2.box2", label: "W-2 box 2 — federal income tax withheld", valueType: "currency", docTypes: ["W-2"], perEntity: true },
	{ ref: "w2.box17", label: "W-2 box 17 — state income tax", valueType: "currency", docTypes: ["W-2"], perEntity: true },

	// --- 1099-NEC / 1099-MISC (per payer) ----------------------------------
	{ ref: "1099nec.payer_name", label: "1099-NEC payer name", valueType: "text", docTypes: ["1099-NEC"], perEntity: true },
	{ ref: "1099nec.box1", label: "1099-NEC box 1 — nonemployee compensation", valueType: "currency", docTypes: ["1099-NEC"], perEntity: true },
	{ ref: "1099misc.box3", label: "1099-MISC box 3 — other income", valueType: "currency", docTypes: ["1099-MISC"], perEntity: true },

	// --- 1099-INT / 1099-DIV ----------------------------------------------
	{ ref: "1099int.box1", label: "1099-INT box 1 — interest income", valueType: "currency", docTypes: ["1099-INT"], perEntity: true },
	{ ref: "1099div.box1a", label: "1099-DIV box 1a — ordinary dividends", valueType: "currency", docTypes: ["1099-DIV"], perEntity: true },

	// --- Schedule C business (per business) --------------------------------
	{ ref: "business.name", label: "Business name", valueType: "text", perEntity: true },
	{ ref: "business.gross_receipts", label: "Business gross receipts", valueType: "currency", perEntity: true },
	{ ref: "business.total_expenses", label: "Business total expenses", valueType: "currency", perEntity: true },
	{ ref: "business.net_profit", label: "Business net profit", valueType: "currency", perEntity: true },

	// --- K-1 (per entity) --------------------------------------------------
	{ ref: "k1.entity_name", label: "K-1 issuing entity", valueType: "text", docTypes: ["K-1"], perEntity: true },
	{ ref: "k1.ordinary_income", label: "K-1 ordinary business income", valueType: "currency", docTypes: ["K-1"], perEntity: true },

	// --- Deductions (client-answered / derived) ----------------------------
	{ ref: "deductions.use_standard", label: "Use standard deduction", valueType: "bool" },
	{ ref: "deductions.itemized_total", label: "Itemized deductions total", valueType: "currency" },
];

const REF_SET = new Set(TAX_INPUT_REFS.map((r) => r.ref));
const REF_BY_KEY = new Map(TAX_INPUT_REFS.map((r) => [r.ref, r] as const));

/** True if `ref` is part of the controlled vocabulary. */
export function isKnownInputRef(ref: string): boolean {
	return REF_SET.has(ref);
}

export function getInputRef(ref: string): TaxInputRef | undefined {
	return REF_BY_KEY.get(ref);
}
