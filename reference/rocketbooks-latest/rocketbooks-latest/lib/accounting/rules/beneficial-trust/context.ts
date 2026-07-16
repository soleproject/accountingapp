import type { TrustFinding, TrustEvaluationInput, TrustEvaluationResult } from './types';

export type { TrustFinding, TrustEvaluationInput, TrustEvaluationResult };

export interface TrustAccountSummary {
	id: string;
	accountNumber: string;
	accountName: string;
	gaapType: string;
	accountType: string | null;
	detailType: string | null;
	systemGenerated: boolean | null;
}

export interface TrustBeneficiarySummary {
	id: string;
	fullName: string;
	dateOfBirth: string | null;
	/** Live flag — what the user has checked TODAY. The rule engine reads
	 *  this for human-readable notes only; the qualifying check uses the
	 *  point-in-time fields below. */
	isIncapacitated: boolean;
	incapacitatedSince: string | null;
	notIncapacitatedSince: string | null;
	legalGuardianContactId: string | null;
	demandNoteAccountId: string | null;
	ageYears: number | null;
	/** True iff the beneficiary was on the incapacitated side of the most
	 *  recent transition as of the JE date being evaluated. Computed by
	 *  loadAggregateContext using isIncapacitatedAsOf. */
	incapacitatedAtJeDate: boolean;
}

export interface TrustContactSummary {
	id: string;
	contactName: string;
	/** Type-tag slugs from contacts.type_tags. The trust rules check for
	 *  the string "trustee" here when deciding whether a 710 M&E line has
	 *  been attributed to a trustee. */
	typeTags: string[];
}

/**
 * Per-line context. Each line of the JE is evaluated against the rules
 * with this shape. Rule modules that operate on a single line take this
 * type as input.
 */
export interface TrustLineContext {
	organizationId: string;
	date: string;
	account: TrustAccountSummary;
	/** Convenience: debit + credit (always positive). */
	amount: number;
	/** Raw debit / credit values from the line, used by rules that care
	 *  about direction (deposit vs withdrawal). */
	debit: number;
	credit: number;
	contactId: string | null;
	contact: TrustContactSummary | null;
	/** Line memo if set; otherwise the JE-level memo; otherwise empty string. */
	memo: string;
	beneficiaries: TrustBeneficiarySummary[];
	/** Per-line beneficiary tag (Phase 4d) — set when the user has linked
	 *  this line to a specific beneficiary, null otherwise. */
	beneficiaryId: string | null;
	/** The beneficiary resolved from beneficiaryId, or null when no tag. */
	linkedBeneficiary: TrustBeneficiarySummary | null;
}

/**
 * JE-level context. Rules that depend on the whole entry (rather than
 * any single line) take this. Currently just the no-receipt-withdrawal
 * gate, which only fires when sourceType='transaction'.
 */
export interface TrustJournalEntryContext {
	organizationId: string;
	date: string;
	memo: string;
	sourceType: string | null;
	sourceId: string | null;
	/** Inferred from line shape when sourceType='transaction'; otherwise null. */
	type: 'deposit' | 'withdrawal' | null;
	/** True only when sourceType='transaction' AND a receipt application exists for the source transaction id. */
	hasReceipt: boolean;
}
