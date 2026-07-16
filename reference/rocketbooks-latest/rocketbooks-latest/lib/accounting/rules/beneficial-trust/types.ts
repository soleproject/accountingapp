/**
 * Beneficial-trust posting rules — shared types.
 *
 * The evaluator returns a Result containing findings (zero or more). A
 * finding with severity='block' aborts posting; severity='warn' allows
 * posting but surfaces a message that goes both to the server log AND
 * gets appended to the journal entry's memo so it's visible in the GL.
 *
 * Codes are stable, machine-readable identifiers — UI surfaces can map
 * them to actions ("dismiss", "open K-1 wizard", "tag beneficiary").
 */

export type TrustFindingSeverity = 'block' | 'warn';

export type TrustFindingCode =
	// Account-eligibility (per-line)
	| 'TRUST_815_NO_QUALIFYING_BENEFICIARY'
	| 'TRUST_815_WARN_VERIFY_BENEFICIARY'
	| 'TRUST_815_REROUTED_TO_DEMAND_NOTE'
	| 'TRUST_820_NO_QUALIFYING_BENEFICIARY'
	| 'TRUST_820_WARN_VERIFY_BENEFICIARY'
	| 'TRUST_820_REROUTED_TO_DEMAND_NOTE'
	| 'TRUST_450_BUSINESS_INCOME_BLOCKED'
	| 'TRUST_515_VERIFY_501C3'
	| 'TRUST_605_VERIFY_TRUST_OWNED_VEHICLE'
	| 'TRUST_635_RECIPIENT_REQUIRED'
	| 'TRUST_710_ATTRIBUTION_REQUIRED'
	| 'TRUST_710_REROUTED_TO_FOOD'
	| 'TRUST_710_REROUTED_TO_DEMAND_NOTE'
	| 'TRUST_DISPOSAL_WITH_OUTSTANDING_LOAN'
	| 'TRUST_505_705_LIKELY_MISROUTED'
	// Distribution & K-1 / 1099 workflow (per-line)
	| 'TRUST_310_DEMAND_NOTE_NOT_EXHAUSTED'
	| 'TRUST_310_FLAG_K1_ISSUANCE'
	| 'TRUST_455_FLAG_K1_ISSUANCE'
	| 'TRUST_510_FLAG_1099_ISSUANCE'
	// Posting-shape & capitalization (per-line)
	| 'TRUST_ASSET_REPOST_REVIEW'
	// Validation gates (per-line + per-JE)
	| 'TRUST_NO_RECEIPT_POSSIBLE_DISTRIBUTION'
	| 'TRUST_NON_TRUST_CATEGORY_USED'
	| 'TRUST_BENEFICIARY_LINKAGE_REQUIRED'
	| 'TRUST_DEMAND_NOTE_MISSING_NOTE'
	// Deferred (data-infra required) — flagged so we don't silently skip
	| 'TRUST_DEFERRED_LOAN_SPLIT_NEEDED'
	| 'TRUST_DEFERRED_RENTAL_NET_NEEDED'
	| 'TRUST_DEFERRED_PERSONAL_USE_LEASE'
	// Income vs corpus classification — every deposit landing on the
	// corpus equity account (or a capital-gains account) needs an
	// explicit user decision before it counts as DNI / shows up on K-1.
	| 'TRUST_DEPOSIT_NEEDS_CORPUS_OR_INCOME_CLASSIFICATION'
	| 'TRUST_CAPITAL_GAIN_NEEDS_HOLDING_PERIOD'
	// Decisioned audits for the corpus/income flow
	| 'TRUST_DEPOSIT_CLASSIFIED_AS_CORPUS'
	| 'TRUST_DEPOSIT_CLASSIFIED_AS_INCOME'
	| 'TRUST_DEPOSIT_SPLIT_CORPUS_AND_INCOME'
	| 'TRUST_CAPITAL_GAIN_CLASSIFIED_SHORT_TERM'
	| 'TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_INCOME'
	| 'TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_CORPUS'
	// Decisioned audit for the 505/705 tax recategorization
	| 'TRUST_TAXES_RECATEGORIZED'
	// Tag-only resolution audits — emitted when an in-place beneficiary
	// tag clears the triggering open code, so every "decision" leaves
	// a visible Decisioned trail.
	| 'TRUST_BENEFICIARY_TAGGED'
	| 'TRUST_815_BENE_CONFIRMED_QUALIFYING'
	| 'TRUST_820_BENE_CONFIRMED_QUALIFYING'
	| 'TRUST_635_RECIPIENT_TAGGED'
	// No-receipt resolution audits
	| 'TRUST_RECEIPT_ATTACHED'
	| 'TRUST_NO_RECEIPT_REROUTED_TO_DEMAND_NOTE'
	// Loan-split linking audit
	| 'TRUST_LOAN_PAYMENT_LINKED_TO_SCHEDULE'
	// 310 demand-note application audit
	| 'TRUST_310_APPLIED_TO_DEMAND_NOTE'
	// K-1 queued for issuance (minimal: audit only, no wizard page yet)
	| 'TRUST_310_K1_QUEUED'
	// 605 vehicle reroute when not trust-owned
	| 'TRUST_605_REROUTED_TO_DEMAND_NOTE'
	// 605 line tagged to a trust-owned fixed_asset (vehicle confirmed)
	| 'TRUST_605_TAGGED_TO_VEHICLE'
	// 515 recipient verified as a registered 501(c)(3) charity
	| 'TRUST_515_RECIPIENT_VERIFIED'
	// 455 K-1 source acknowledged as received and retained
	| 'TRUST_455_K1_ACKNOWLEDGED'
	// 510 trustee comp queued for year-end 1099-MISC issuance
	| 'TRUST_510_1099_QUEUED'
	// Asset 125-160 confirmed as a genuine purchase (not maintenance)
	| 'TRUST_ASSET_PURCHASE_CONFIRMED'
	// Non-trust account confirmed appropriate (no reclassification)
	| 'TRUST_NON_TRUST_KEPT'
	// Demand-note backing promissory note confirmed on file (off-system)
	| 'TRUST_DEMAND_NOTE_CONFIRMED'
	// Trustee personal-use lease confirmed configured externally
	| 'TRUST_PERSONAL_USE_LEASE_CONFIGURED'
	// Disposal-with-outstanding-loan resolutions
	| 'TRUST_DISPOSAL_LOAN_ASSUMED_BY_BUYER'
	| 'TRUST_DISPOSAL_LOAN_PAID_FROM_PROCEEDS'
	| 'TRUST_DISPOSAL_LOAN_REASSIGNED'
	// Asset-repost resolution (moves a non-purchase posting off an
	// asset account onto the proper expense account)
	| 'TRUST_ASSET_RECLASSIFIED_TO_EXPENSE'
	// Trustee resolution / documentation request — consumed by the
	// Trust Documentation module's doc-generation pipeline. Single
	// generic code with documentType in metadata so we don't have to
	// add a new audit code every time a new template lands.
	| 'TRUST_DOCUMENTATION_REQUESTED'
	// 450 reclassification to 455 (when an LLC/S-Corp + K-1 actually exists)
	| 'TRUST_450_RECLASSIFIED_TO_K1'
	// NON_TRUST_CATEGORY recategorization
	| 'TRUST_NON_TRUST_RECATEGORIZED'
	// Rental income linked to a property's sub-ledger
	| 'TRUST_RENTAL_LINKED_TO_PROPERTY'
	// Tag memory: property/asset auto-tagged from prior history (decisioned)
	| 'TRUST_TAG_AUTO_APPLIED'
	// Tag memory: prior tag found at near-but-not-exact amount (open suggestion)
	| 'TRUST_TAG_SUGGESTED'
	// Property-relevant expense (505/650/680/685/725) posted untagged on an
	// org with active rental properties or fixed assets (open)
	| 'TRUST_PROPERTY_EXPENSE_UNTAGGED';

export interface TrustFinding {
	code: TrustFindingCode;
	severity: TrustFindingSeverity;
	message: string;
	metadata?: Record<string, unknown>;
}

/**
 * Inputs the evaluator needs from a pending journal-entry creation. Maps
 * 1:1 to the shape of `CreateJournalEntryInput` in posting.ts, plus
 * sourceType/sourceId (used for the receipt-presence gate on
 * transaction-sourced entries).
 */
export interface TrustEvaluationInput {
	organizationId: string;
	date: string;
	memo: string | null;
	sourceType: string | null;
	sourceId: string | null;
	lines: TrustEvaluationLineInput[];
}

export interface TrustEvaluationLineInput {
	accountId: string;
	debit: number;
	credit: number;
	contactId: string | null;
	memo: string | null;
	/** Per-line beneficiary tag (Phase 4d) — drives precise rule enforcement
	 *  for 815/820 eligibility, 310 K-1 routing, etc. Null for lines that
	 *  don't touch a per-beneficiary account or aren't tagged yet. */
	beneficiaryId?: string | null;
}

export interface TrustEvaluationResult {
	/** All findings produced. UI can group/display them. */
	findings: TrustFinding[];
	/** True iff at least one finding has severity='block'. */
	blocked: boolean;
	/** Concatenated block-finding messages (for error throwing). */
	blockMessage: string | null;
	/** All warn-finding messages joined with " · " — gets appended to JE memo. */
	memoSuffix: string | null;
}
