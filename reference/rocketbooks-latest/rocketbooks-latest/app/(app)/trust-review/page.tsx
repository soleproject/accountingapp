import Link from 'next/link';
import { and, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	trustReviewFindings,
	trustBeneficiaries,
	journalEntries,
	journalEntryLines,
	chartOfAccounts,
	contacts,
	loans,
	loanAmortizationSchedules,
	rentalProperties,
	transactions,
	users,
	assetCategories,
	fixedAssets,
} from '@/db/schema/schema';
import { loadAllDimensionOptions } from '@/lib/tags/dimensions';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getOrgFeature } from '@/lib/accounting/get-org-feature';
import { resolveVendorClassifications } from '@/lib/accounting/vendor-classification';
import { TrustReviewFilters } from './_components/TrustReviewFilters';
import { type BeneficiaryOption } from './_components/BeneficiaryPickerInline';
import { type FindingRowData } from './_components/FindingsTable';
import { FindingGroup } from './_components/FindingGroup';

const VALID_VIEWS = ['open', 'decisioned', 'dismissed', 'all', 'types'] as const;
type ViewFilter = (typeof VALID_VIEWS)[number];

/**
 * Codes that represent a past *action* (audit trail of "we already did
 * X to this JE"), not a pending issue. They land in their own
 * "Decisioned" tab instead of cluttering "Open" — the user has already
 * dealt with them; this view is the record of what was decided.
 */
const DECISIONED_CODES = [
	'TRUST_710_REROUTED_TO_FOOD',
	'TRUST_710_REROUTED_TO_DEMAND_NOTE',
	'TRUST_710_ATTRIBUTED_TO_TRUSTEE',
	'TRUST_815_REROUTED_TO_DEMAND_NOTE',
	'TRUST_820_REROUTED_TO_DEMAND_NOTE',
	'TRUST_DEPOSIT_CLASSIFIED_AS_CORPUS',
	'TRUST_DEPOSIT_CLASSIFIED_AS_INCOME',
	'TRUST_DEPOSIT_SPLIT_CORPUS_AND_INCOME',
	'TRUST_CAPITAL_GAIN_CLASSIFIED_SHORT_TERM',
	'TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_INCOME',
	'TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_CORPUS',
	'TRUST_TAXES_RECATEGORIZED',
	'TRUST_BENEFICIARY_TAGGED',
	'TRUST_815_BENE_CONFIRMED_QUALIFYING',
	'TRUST_820_BENE_CONFIRMED_QUALIFYING',
	'TRUST_635_RECIPIENT_TAGGED',
	'TRUST_RECEIPT_ATTACHED',
	'TRUST_NO_RECEIPT_REROUTED_TO_DEMAND_NOTE',
	'TRUST_LOAN_PAYMENT_LINKED_TO_SCHEDULE',
	'TRUST_310_APPLIED_TO_DEMAND_NOTE',
	'TRUST_310_K1_QUEUED',
	'TRUST_605_REROUTED_TO_DEMAND_NOTE',
	'TRUST_605_TAGGED_TO_VEHICLE',
	'TRUST_515_RECIPIENT_VERIFIED',
	'TRUST_455_K1_ACKNOWLEDGED',
	'TRUST_510_1099_QUEUED',
	'TRUST_ASSET_PURCHASE_CONFIRMED',
	'TRUST_NON_TRUST_KEPT',
	'TRUST_DEMAND_NOTE_CONFIRMED',
	'TRUST_PERSONAL_USE_LEASE_CONFIGURED',
	'TRUST_DISPOSAL_LOAN_ASSUMED_BY_BUYER',
	'TRUST_DISPOSAL_LOAN_PAID_FROM_PROCEEDS',
	'TRUST_DISPOSAL_LOAN_REASSIGNED',
	'TRUST_ASSET_RECLASSIFIED_TO_EXPENSE',
	'TRUST_DOCUMENTATION_REQUESTED',
	'TRUST_450_RECLASSIFIED_TO_K1',
	'TRUST_NON_TRUST_RECATEGORIZED',
	'TRUST_RENTAL_LINKED_TO_PROPERTY',
	'TRUST_TAG_AUTO_APPLIED',
] as const;
const DECISIONED_CODE_SET: ReadonlySet<string> = new Set(DECISIONED_CODES);

interface PageProps {
	searchParams: Promise<{
		view?: string;
		q?: string;
		code?: string;
		severity?: string;
		contactId?: string;
		start?: string;
		end?: string;
	}>;
}

const SEVERITY_PALETTE: Record<string, string> = {
	warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
	block: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

type CodeGroup =
	| 'Account eligibility'
	| 'Distribution / K-1 / 1099 workflow'
	| 'Posting shape & capitalization'
	| 'Validation gates'
	| 'Deferred (data infra required)';

interface CodeCatalogEntry {
	code: string;
	severity: 'warn' | 'block';
	group: CodeGroup;
	label: string;
	description: string;
}

/**
 * Catalog of every beneficial-trust finding code the rules engine can emit.
 * Source of truth for the page's group headers AND the Warning Types
 * reference tab. Keep in sync with TrustFindingCode in
 * lib/accounting/rules/beneficial-trust/types.ts when adding new rules.
 */
const CODE_CATALOG: readonly CodeCatalogEntry[] = [
	// Account eligibility (9)
	{ code: 'TRUST_815_NO_QUALIFYING_BENEFICIARY', severity: 'warn', group: 'Account eligibility', label: 'Food (815) — non-qualifying beneficiary (manual JE)', description: 'A direct JE post (bypassing the categorize flow) landed on 815 with an adult non-incapacitated tagged beneficiary. Categorize-flow posts auto-reroute to the demand note; this one slipped through. Recategorize to the beneficiary\'s 26x demand note, or re-tag with a qualifying beneficiary.' },
	{ code: 'TRUST_815_WARN_VERIFY_BENEFICIARY', severity: 'warn', group: 'Account eligibility', label: 'Food (815) — verify recipient is a qualifying beneficiary', description: 'At least one qualifying beneficiary exists; confirm this food expense is for them, not for an adult non-incapacitated party.' },
	{ code: 'TRUST_815_REROUTED_TO_DEMAND_NOTE', severity: 'warn', group: 'Account eligibility', label: 'Food (815) — rerouted to demand note (non-qualifying)', description: 'User picked 815 for an adult non-incapacitated beneficiary; the post was redirected to that beneficiary\'s 26x demand note instead. Review whether this should remain as a non-qualifying advance or be reclassified.' },
	{ code: 'TRUST_820_NO_QUALIFYING_BENEFICIARY', severity: 'warn', group: 'Account eligibility', label: 'Clothing (820) — non-qualifying beneficiary (manual JE)', description: 'A direct JE post landed on 820 with a non-qualifying tagged beneficiary. Recategorize to the beneficiary\'s 26x demand note or re-tag with a qualifying beneficiary.' },
	{ code: 'TRUST_820_WARN_VERIFY_BENEFICIARY', severity: 'warn', group: 'Account eligibility', label: 'Clothing (820) — verify recipient is a qualifying beneficiary', description: 'Confirm the clothing expense recipient is a qualifying beneficiary.' },
	{ code: 'TRUST_820_REROUTED_TO_DEMAND_NOTE', severity: 'warn', group: 'Account eligibility', label: 'Clothing (820) — rerouted to demand note (non-qualifying)', description: 'User picked 820 for an adult non-incapacitated beneficiary; the post was redirected to that beneficiary\'s 26x demand note instead. Review the non-qualifying advance.' },
	{ code: 'TRUST_450_BUSINESS_INCOME_BLOCKED', severity: 'block', group: 'Account eligibility', label: 'Business income (450) — blocked: must route via K-1', description: 'Beneficial trusts may not receive business income directly. Route the business activity through an LLC/S-Corp and post the resulting K-1 to account 455.' },
	{ code: 'TRUST_515_VERIFY_501C3', severity: 'warn', group: 'Account eligibility', label: 'Charitable (515) — verify recipient is 501(c)(3)', description: 'Charitable contribution posted. Verify the recipient is a registered 501(c)(3) and retain the tax receipt.' },
	{ code: 'TRUST_605_VERIFY_TRUST_OWNED_VEHICLE', severity: 'warn', group: 'Account eligibility', label: 'Vehicle expense (605) — verify trust-owned + mileage log', description: 'Vehicle expenses are deductible only on trust-owned vehicles. If shared with the trustee, attach mileage log + reimburse personal-use miles at the IRS rate.' },
	{ code: 'TRUST_635_RECIPIENT_REQUIRED', severity: 'warn', group: 'Account eligibility', label: 'Medical (635) — named recipient required', description: 'Medical/wellness expense posted without a named recipient. Invoice + identified beneficiary required for deductibility.' },
	{ code: 'TRUST_710_ATTRIBUTION_REQUIRED', severity: 'warn', group: 'Account eligibility', label: 'Meals & Entertainment (710) — needs beneficiary or trustee attribution', description: 'M&E line posted with no beneficiary tag and no contact marked as a trustee. Either tag a beneficiary (recategorize to 815 if it\'s qualifying food/clothing for a minor or incapacitated beneficiary) or set a contact whose typeTags include "trustee" to attribute the admin meal.' },
	{ code: 'TRUST_710_REROUTED_TO_FOOD', severity: 'warn', group: 'Account eligibility', label: 'M&E (710) — rerouted to 815 Food (qualifying beneficiary)', description: 'Tagged 710 line with a qualifying beneficiary (under 21 OR incapacitated at the JE date) was rerouted to 815 Food. Audit trail only; the new posting is on 815, the original 710 line is reversed.' },
	{ code: 'TRUST_710_REROUTED_TO_DEMAND_NOTE', severity: 'warn', group: 'Account eligibility', label: 'M&E (710) — rerouted to demand note (non-qualifying beneficiary)', description: 'Tagged 710 line with an adult, non-incapacitated beneficiary was rerouted to that beneficiary\'s 26x demand note — adult-beneficiary meals book as non-qualifying personal advances, not trust admin expense.' },
	{ code: 'TRUST_710_ATTRIBUTED_TO_TRUSTEE', severity: 'warn', group: 'Account eligibility', label: 'M&E (710) — attributed to trustee (admin meal)', description: 'A 710 line was attributed to a trustee contact (single or split across multiple trustees) so the rules engine treats it as a deductible administrative meal expense. Audit trail only.' },
	{ code: 'TRUST_505_705_LIKELY_MISROUTED', severity: 'warn', group: 'Account eligibility', label: 'Taxes (505 vs 705) — likely miscategorized', description: 'The transaction description suggests the tax type doesn\'t match the account chosen. Property tax → 505; non-property (vehicle, sales, use) → 705.' },

	// Distribution / K-1 / 1099 workflow (4)
	{ code: 'TRUST_310_FLAG_K1_ISSUANCE', severity: 'warn', group: 'Distribution / K-1 / 1099 workflow', label: 'Distribution (310) — K-1 issuance required', description: 'Taxable distribution flagged. Confirm this is a real draw (not a reimbursement) and prepare a K-1 for the recipient.' },
	{ code: 'TRUST_310_DEMAND_NOTE_NOT_EXHAUSTED', severity: 'warn', group: 'Distribution / K-1 / 1099 workflow', label: 'Distribution (310) — verify demand-note exhaustion', description: 'Demand-note exhaustion check is deferred to a future phase. Verify manually that the recipient\'s 265.x balance is exhausted before posting.' },
	{ code: 'TRUST_455_FLAG_K1_ISSUANCE', severity: 'warn', group: 'Distribution / K-1 / 1099 workflow', label: 'K-1 income (455) — retain source K-1', description: 'K-1 pass-through income posted. Retain the source K-1 form and reconcile at year-end.' },
	{ code: 'TRUST_510_FLAG_1099_ISSUANCE', severity: 'warn', group: 'Distribution / K-1 / 1099 workflow', label: 'Trustee compensation (510) — 1099-MISC required', description: 'Trustee compensation requires a 1099-MISC at year-end. Tag the trustee contact for issuance.' },

	// Posting shape & capitalization (2)
	{ code: 'TRUST_ASSET_REPOST_REVIEW', severity: 'warn', group: 'Posting shape & capitalization', label: 'Asset account — possible non-purchase posting', description: 'Asset account (125-160) already has prior posts. Asset accounts should only record the ORIGINAL purchase price (cost basis); maintenance, repairs, insurance must route to expense accounts.' },
	{ code: 'TRUST_DISPOSAL_WITH_OUTSTANDING_LOAN', severity: 'warn', group: 'Posting shape & capitalization', label: 'Asset disposed with outstanding linked loan(s)', description: 'A fixed asset was disposed while a loan secured by it still had a non-zero balance. Disposal doesn\'t pay the loan off automatically — confirm whether the buyer assumed the debt, the trustee paid off the loan from proceeds, or the loan needs to be reassigned/written off.' },

	// Validation gates (3)
	{ code: 'TRUST_NO_RECEIPT_POSSIBLE_DISTRIBUTION', severity: 'warn', group: 'Validation gates', label: 'Withdrawal without receipt — possible taxable distribution', description: 'Withdrawal posted with no receipt attached. If not backed by a vendor expense, may need to be reclassified as a taxable distribution (account 310).' },
	{ code: 'TRUST_NON_TRUST_CATEGORY_USED', severity: 'warn', group: 'Validation gates', label: 'Non-trust category used', description: 'Posted to an account that isn\'t part of the beneficial-trust chart of accounts. Re-categorize to a trust-specific account if one fits.' },
	{ code: 'TRUST_BENEFICIARY_LINKAGE_REQUIRED', severity: 'warn', group: 'Validation gates', label: 'Beneficiary linkage required', description: 'Posted to a per-beneficiary account (815/820/310/635) without tagging which beneficiary it\'s for. Tag the recipient — needed for K-1 issuance, age/capacity checks, and demand-note tracking.' },
	{ code: 'TRUST_DEMAND_NOTE_MISSING_NOTE', severity: 'warn', group: 'Validation gates', label: 'Demand note — backing promissory note missing', description: 'Demand-note activity recorded on 260 (Trustee) or 265.x (Beneficiary) without a backing promissory note on file. IRS / UTC best practice requires a master note per borrower so advances aren\'t recharacterized as taxable distributions. One warning surfaces per borrower at a time; resolve by attaching or drafting a master note, or dismiss if intentional.' },

	// Deferred — fire when posting hits an account whose rule needs infra not yet built (3)
	{ code: 'TRUST_DEFERRED_LOAN_SPLIT_NEEDED', severity: 'warn', group: 'Deferred (data infra required)', label: 'Loan payment (250) — principal/interest split deferred', description: 'Loan payment posted to 250 without principal/interest split. Spec requires every payment to split using the loan\'s amortization schedule. Loan-management UI is not yet wired.' },
	{ code: 'TRUST_DEFERRED_RENTAL_NET_NEEDED', severity: 'warn', group: 'Deferred (data infra required)', label: 'Rental income (430) — net-only enforcement deferred', description: 'Rental income posted to 430. Spec requires NET-only posting from a per-property sub-register. Per-property tagging is not yet wired.' },
	{ code: 'TRUST_DEFERRED_PERSONAL_USE_LEASE', severity: 'warn', group: 'Deferred (data infra required)', label: 'Personal-use lease (440) — auto-monthly deferred', description: 'Trustee personal-use lease income posted. Automatic monthly posting from personal_use_lease_agreements is not yet wired — confirm a written lease agreement exists.' },

	// Income vs corpus classification — needs explicit user decision on
	// every deposit that touches corpus equity or capital-gain accounts.
	{ code: 'TRUST_DEPOSIT_NEEDS_CORPUS_OR_INCOME_CLASSIFICATION', severity: 'warn', group: 'Account eligibility', label: 'Deposit — needs corpus or income classification', description: 'A deposit landed on the trust\'s equity (corpus) account. Confirm whether this is principal (return of corpus, additional contribution, inherited principal) or income misposted to equity (which should hit a 4xx income account instead).' },
	{ code: 'TRUST_CAPITAL_GAIN_NEEDS_HOLDING_PERIOD', severity: 'warn', group: 'Account eligibility', label: 'Capital gain — confirm holding period', description: 'Capital gain posted. Confirm short-term (≤ 1 year → 420) vs long-term (> 1 year → 425). If the trust instrument routes long-term gains to corpus, optionally reroute to the corpus account.' },
	{ code: 'TRUST_DEPOSIT_CLASSIFIED_AS_CORPUS', severity: 'warn', group: 'Account eligibility', label: 'Deposit — classified as corpus', description: 'Audit trail of a deposit confirmed (or rerouted to) the corpus equity account. Not distributable as DNI; does not appear on K-1.' },
	{ code: 'TRUST_DEPOSIT_CLASSIFIED_AS_INCOME', severity: 'warn', group: 'Account eligibility', label: 'Deposit — classified as income', description: 'Audit trail of a deposit confirmed (or rerouted from corpus to) a 4xx income account. Counts toward DNI; may trigger K-1.' },
	{ code: 'TRUST_DEPOSIT_SPLIT_CORPUS_AND_INCOME', severity: 'warn', group: 'Account eligibility', label: 'Deposit — split between corpus and income', description: 'Audit trail of a mixed deposit (e.g. loan repayment with both principal and interest portions) split between the corpus equity account and a 4xx income account.' },
	{ code: 'TRUST_CAPITAL_GAIN_CLASSIFIED_SHORT_TERM', severity: 'warn', group: 'Account eligibility', label: 'Capital gain — classified short-term (420)', description: 'Audit trail of a capital gain confirmed as short-term (held ≤ 1 year). Posted to 420 and treated as ordinary income for DNI.' },
	{ code: 'TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_INCOME', severity: 'warn', group: 'Account eligibility', label: 'Capital gain — classified long-term, to income (425)', description: 'Audit trail of a capital gain confirmed as long-term and held in income (425). Distributable; preferential tax rates apply.' },
	{ code: 'TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_CORPUS', severity: 'warn', group: 'Account eligibility', label: 'Capital gain — classified long-term, to corpus', description: 'Audit trail of a long-term capital gain rerouted from income to the corpus equity account per the trust instrument. Not distributable as DNI.' },
	{ code: 'TRUST_TAXES_RECATEGORIZED', severity: 'warn', group: 'Account eligibility', label: 'Taxes — recategorized between 505 and 705', description: 'Audit trail of a tax line moved between 505 Property Taxes and 705 Non-Property Taxes after the description-vs-account mismatch warning.' },
	{ code: 'TRUST_BENEFICIARY_TAGGED', severity: 'warn', group: 'Validation gates', label: 'Beneficiary tagged on per-bene account', description: 'Audit trail of a JE line tagged with a beneficiary, clearing the linkage-required warning.' },
	{ code: 'TRUST_815_BENE_CONFIRMED_QUALIFYING', severity: 'warn', group: 'Account eligibility', label: 'Food (815) — qualifying beneficiary confirmed', description: 'Audit trail of a 815 line tagged with a qualifying beneficiary (under 21 or incapacitated). Stays on 815 as a deductible food/clothing expense.' },
	{ code: 'TRUST_820_BENE_CONFIRMED_QUALIFYING', severity: 'warn', group: 'Account eligibility', label: 'Clothing (820) — qualifying beneficiary confirmed', description: 'Audit trail of a 820 line tagged with a qualifying beneficiary (under 21 or incapacitated). Stays on 820 as a deductible food/clothing expense.' },
	{ code: 'TRUST_635_RECIPIENT_TAGGED', severity: 'warn', group: 'Account eligibility', label: 'Medical (635) — recipient tagged', description: 'Audit trail of a 635 line tagged with a named beneficiary recipient.' },
	{ code: 'TRUST_RECEIPT_ATTACHED', severity: 'warn', group: 'Validation gates', label: 'Receipt attached — no-receipt warning cleared', description: 'Audit trail of a receipt application that cleared a withdrawal-without-receipt warning. The new JE on the transaction posts with full receipt metadata.' },
	{ code: 'TRUST_NO_RECEIPT_REROUTED_TO_DEMAND_NOTE', severity: 'warn', group: 'Validation gates', label: 'No receipt — rerouted to demand note', description: 'Audit trail of a withdrawal without a receipt that was reclassified as a personal advance against the responsible party\'s 26x demand note rather than treated as a trust expense.' },
	{ code: 'TRUST_LOAN_PAYMENT_LINKED_TO_SCHEDULE', severity: 'warn', group: 'Deferred (data infra required)', label: 'Loan payment linked to schedule', description: 'Audit trail of an undifferentiated 250 Notes Payable JE that was reposted as a proper 3-line P/I/bank entry, linked to a specific loan + amortization-schedule row.' },
	{ code: 'TRUST_310_APPLIED_TO_DEMAND_NOTE', severity: 'warn', group: 'Distribution / K-1 / 1099 workflow', label: 'Distribution (310) — applied to demand note', description: 'Audit trail of a 310 distribution where the beneficiary still owed the trust on a 26x demand note: portion of the distribution (up to the outstanding balance) was credited against the demand note instead of treated as a taxable draw; any residual stayed on 310 and triggers K-1 issuance separately.' },
	{ code: 'TRUST_310_K1_QUEUED', severity: 'warn', group: 'Distribution / K-1 / 1099 workflow', label: 'K-1 queued for issuance', description: 'Audit trail of a 310 distribution flagged for K-1 issuance. The CPA can query all open TRUST_310_K1_QUEUED findings at year-end to assemble the K-1 batch — each carries the beneficiary id, amount, and source JE id in metadata. (A dedicated K-1 wizard page is deferred to a future slice.)' },
	{ code: 'TRUST_605_REROUTED_TO_DEMAND_NOTE', severity: 'warn', group: 'Account eligibility', label: 'Vehicle expense (605) — rerouted to demand note (not trust-owned)', description: 'Audit trail of a 605 vehicle expense reclassified as a personal advance against a beneficiary or trustee 26x demand note because the vehicle isn\'t titled to the trust.' },
	{ code: 'TRUST_605_TAGGED_TO_VEHICLE', severity: 'warn', group: 'Account eligibility', label: 'Vehicle expense (605) — tagged to trust-owned vehicle', description: 'Audit trail of a 605 line confirmed as a trust-owned vehicle expense and tagged to a specific fixed_assets row (the vehicle). The line stays on 605; downstream reporting groups expenses per vehicle.' },
	{ code: 'TRUST_515_RECIPIENT_VERIFIED', severity: 'warn', group: 'Account eligibility', label: 'Charitable (515) — recipient verified as 501(c)(3)', description: 'Audit trail of a 515 charitable contribution where the recipient contact was confirmed as a registered 501(c)(3). The contact gets stamped \'charity_501c3\' so future 515 postings to the same vendor auto-clear.' },
	{ code: 'TRUST_455_K1_ACKNOWLEDGED', severity: 'warn', group: 'Distribution / K-1 / 1099 workflow', label: 'K-1 income (455) — source K-1 acknowledged', description: 'Audit trail of a 455 K-1 income line where the user confirmed they have the source K-1 form on file.' },
	{ code: 'TRUST_510_1099_QUEUED', severity: 'warn', group: 'Distribution / K-1 / 1099 workflow', label: 'Trustee compensation (510) — 1099-MISC queued', description: 'Audit trail of a 510 trustee-compensation line tagged with the trustee contact and queued for year-end 1099-MISC issuance.' },
	{ code: 'TRUST_ASSET_PURCHASE_CONFIRMED', severity: 'warn', group: 'Posting shape & capitalization', label: 'Asset — confirmed as genuine purchase', description: 'Audit trail of a posting to a 125-160 asset account that the user confirmed is a real additional purchase (not maintenance/repairs in disguise). The line stays as-is.' },
	{ code: 'TRUST_NON_TRUST_KEPT', severity: 'warn', group: 'Validation gates', label: 'Non-trust category — kept as-is', description: 'Audit trail of a posting to a non-BCOA account that the user confirmed is appropriate (no reclassification needed).' },
	{ code: 'TRUST_DEMAND_NOTE_CONFIRMED', severity: 'warn', group: 'Validation gates', label: 'Demand note — backing promissory note confirmed', description: 'Audit trail of a demand-note posting where the user confirmed a master promissory note exists on file (off-system).' },
	{ code: 'TRUST_PERSONAL_USE_LEASE_CONFIGURED', severity: 'warn', group: 'Deferred (data infra required)', label: 'Personal-use lease — confirmed configured externally', description: 'Audit trail of a 440 personal-use lease posting where the user confirmed a written lease agreement exists outside the system.' },
	{ code: 'TRUST_DISPOSAL_LOAN_ASSUMED_BY_BUYER', severity: 'warn', group: 'Posting shape & capitalization', label: 'Asset disposed — loan assumed by buyer', description: 'Audit trail of a disposal-with-outstanding-loan finding resolved by recording that the buyer assumed the underlying loan.' },
	{ code: 'TRUST_DISPOSAL_LOAN_PAID_FROM_PROCEEDS', severity: 'warn', group: 'Posting shape & capitalization', label: 'Asset disposed — loan paid from proceeds', description: 'Audit trail of a disposal-with-outstanding-loan finding resolved by recording that the loan was paid off from disposal proceeds.' },
	{ code: 'TRUST_DISPOSAL_LOAN_REASSIGNED', severity: 'warn', group: 'Posting shape & capitalization', label: 'Asset disposed — loan reassigned to another asset', description: 'Audit trail of a disposal-with-outstanding-loan finding resolved by reassigning the loan to a different fixed asset (the new collateral).' },
	{ code: 'TRUST_ASSET_RECLASSIFIED_TO_EXPENSE', severity: 'warn', group: 'Posting shape & capitalization', label: 'Asset — reclassified off asset account to expense', description: 'Audit trail of a posting moved off a 125-160 asset account to the proper expense account (685 R&M, 605 vehicle, 650 insurance, etc.) — recovering from an asset-account misuse.' },
	{ code: 'TRUST_DOCUMENTATION_REQUESTED', severity: 'warn', group: 'Account eligibility', label: 'Trustee resolution / documentation requested', description: 'Audit trail of a Trust Review row that needs a document generated by the Trust Documentation module (Personal-Use Lease Agreement, mileage log, etc). The trust-docs pipeline picks up these audits and routes them through its template engine.' },
	{ code: 'TRUST_450_RECLASSIFIED_TO_K1', severity: 'warn', group: 'Account eligibility', label: 'Business income (450) — reclassified to K-1 (455)', description: 'Audit trail of a 450 direct business-income deposit moved to 455 K-1 income (i.e. routed through an operating LLC/S-Corp K-1 instead of posted directly to the trust).' },
	{ code: 'TRUST_NON_TRUST_RECATEGORIZED', severity: 'warn', group: 'Validation gates', label: 'Non-trust category — recategorized to BCOA', description: 'Audit trail of a JE line moved off a non-trust account onto a beneficial-trust chart-of-accounts entry.' },
	{ code: 'TRUST_RENTAL_LINKED_TO_PROPERTY', severity: 'warn', group: 'Deferred (data infra required)', label: 'Rental income (430) — linked to property', description: 'Audit trail of a 430 rental-income line tagged to a specific rental property for sub-ledger roll-up. The per-property sub-ledger (gross income − expenses) ties out to the net posted on 430.' },

	// Tag memory (auto-tagging from prior history)
	{ code: 'TRUST_TAG_AUTO_APPLIED', severity: 'warn', group: 'Deferred (data infra required)', label: 'Tag auto-applied from prior history', description: 'Audit trail of a JE line auto-tagged (rental property / fixed asset) because a prior transaction with the same vendor, account, and amount carried that tag. Reverse from the transaction\'s Tags panel if wrong.' },
	{ code: 'TRUST_TAG_SUGGESTED', severity: 'warn', group: 'Deferred (data infra required)', label: 'Tag suggested — needs confirmation', description: 'A prior transaction with the same vendor and account was tagged, but the amount differs (within 5%). Confirm or change the suggested tag on the transaction\'s Tags panel.' },
	{ code: 'TRUST_PROPERTY_EXPENSE_UNTAGGED', severity: 'warn', group: 'Deferred (data infra required)', label: 'Property-relevant expense — untagged', description: 'Withdrawal landed on a property-relevant account (505 Property Tax, 650 Insurance, 680 Rent, 685 R&M, 725 Utilities) but isn\'t tagged to a rental property or fixed asset yet. Tag it so the per-property / per-asset sub-ledger ties out.' },
] as const;

const CODE_BY_KEY: ReadonlyMap<string, CodeCatalogEntry> = new Map(
	CODE_CATALOG.map((c) => [c.code, c]),
);

function codeLabel(code: string): string {
	return CODE_BY_KEY.get(code)?.label ?? code;
}

function ageYearsFromDob(dob: string, asOfDate: string): number | null {
	try {
		const birth = new Date(dob);
		const as = new Date(asOfDate);
		if (Number.isNaN(birth.getTime()) || Number.isNaN(as.getTime())) return null;
		let years = as.getUTCFullYear() - birth.getUTCFullYear();
		const m = as.getUTCMonth() - birth.getUTCMonth();
		if (m < 0 || (m === 0 && as.getUTCDate() < birth.getUTCDate())) years--;
		return years;
	} catch {
		return null;
	}
}

const GROUP_ORDER: readonly CodeGroup[] = [
	'Account eligibility',
	'Distribution / K-1 / 1099 workflow',
	'Posting shape & capitalization',
	'Validation gates',
	'Deferred (data infra required)',
];

type FindingRow = FindingRowData;

export default async function TrustReviewPage({ searchParams }: PageProps) {
	const orgId = await getCurrentOrgId();
	const sp = await searchParams;
	const view: ViewFilter = (VALID_VIEWS as readonly string[]).includes(sp.view ?? '')
		? (sp.view as ViewFilter)
		: 'open';

	const q = (sp.q ?? '').trim();
	const codeFilter = (sp.code ?? '').trim();
	const severityFilter = (sp.severity ?? '').trim();
	const contactIdFilter = (sp.contactId ?? '').trim();
	const startFilter = (sp.start ?? '').trim();
	const endFilter = (sp.end ?? '').trim();

	const trustEnabled = await getOrgFeature(orgId, 'beneficial_trust');

	// Build the where conditions list. and() ignores undefined entries so we
	// can append each filter conditionally without nesting. Each view also
	// partitions by code:
	//   open        → NOT dismissed AND code NOT IN decisioned set
	//   decisioned  → NOT dismissed AND code IN decisioned set
	//   dismissed   → dismissed (any code)
	//   all         → no extra filter
	const conditions = [eq(trustReviewFindings.organizationId, orgId)];
	if (view === 'open') {
		conditions.push(isNull(trustReviewFindings.dismissedAt));
		conditions.push(notInArray(trustReviewFindings.code, [...DECISIONED_CODES]));
	} else if (view === 'decisioned') {
		conditions.push(isNull(trustReviewFindings.dismissedAt));
		conditions.push(inArray(trustReviewFindings.code, [...DECISIONED_CODES]));
	} else if (view === 'dismissed') {
		// Dismissed audit-trail rows from the decisioned codes (re-decided
		// reroutes/trustees) are noise in this view — they're already
		// superseded by a newer audit on the new JE. Excluded here so
		// Dismissed only surfaces rule-engine warnings the user (or the
		// system) chose to set aside. The "All" tab is the escape hatch.
		conditions.push(isNotNull(trustReviewFindings.dismissedAt));
		conditions.push(notInArray(trustReviewFindings.code, [...DECISIONED_CODES]));
	}
	if (codeFilter) conditions.push(eq(trustReviewFindings.code, codeFilter));
	if (severityFilter) conditions.push(eq(trustReviewFindings.severity, severityFilter));
	if (q) {
		// Match on either the finding message or the JE memo.
		const pattern = `%${q.replace(/[%_]/g, '\\$&')}%`;
		conditions.push(
			or(
				ilike(trustReviewFindings.message, pattern),
				ilike(journalEntries.memo, pattern),
			)!,
		);
	}
	if (startFilter) conditions.push(gte(journalEntries.date, startFilter));
	if (endFilter) conditions.push(lte(journalEntries.date, endFilter));
	if (contactIdFilter) {
		conditions.push(
			sql`EXISTS (SELECT 1 FROM journal_entry_lines jel WHERE jel.journal_entry_id = ${trustReviewFindings.journalEntryId} AND jel.contact_id = ${contactIdFilter})`,
		);
	}
	const where = and(...conditions);

	const [
		[openCount],
		[decisionedCount],
		[dismissedCount],
		[decisionedDismissedCount],
		rows,
		codeCounts,
		filterContacts,
		trusteeRows,
		charityRows,
		beneficiaryRows,
		incomeAccountRows,
		corpusAccountRows,
		loanRows,
		nextLoanRows,
		expenseAccountRows,
		allAccountRows,
		rentalPropertyRows,
	] = await Promise.all([
		db
			.select({ n: count() })
			.from(trustReviewFindings)
			.where(
				and(
					eq(trustReviewFindings.organizationId, orgId),
					isNull(trustReviewFindings.dismissedAt),
					notInArray(trustReviewFindings.code, [...DECISIONED_CODES]),
				),
			),
		db
			.select({ n: count() })
			.from(trustReviewFindings)
			.where(
				and(
					eq(trustReviewFindings.organizationId, orgId),
					isNull(trustReviewFindings.dismissedAt),
					inArray(trustReviewFindings.code, [...DECISIONED_CODES]),
				),
			),
		db
			.select({ n: count() })
			.from(trustReviewFindings)
			.where(
				and(
					eq(trustReviewFindings.organizationId, orgId),
					isNotNull(trustReviewFindings.dismissedAt),
					notInArray(trustReviewFindings.code, [...DECISIONED_CODES]),
				),
			),
		// Dismissed audit-trail rows from decisioned codes — excluded from
		// the Dismissed tab but still part of the All total so the tab
		// counter doesn't undercount what the All view actually renders.
		db
			.select({ n: count() })
			.from(trustReviewFindings)
			.where(
				and(
					eq(trustReviewFindings.organizationId, orgId),
					isNotNull(trustReviewFindings.dismissedAt),
					inArray(trustReviewFindings.code, [...DECISIONED_CODES]),
				),
			),
		// Skip the heavy findings query when on the Warning Types reference tab.
		view === 'types'
			? Promise.resolve([] as Array<Omit<FindingRow, 'jeAmount' | 'jeContactName'>>)
			: db
					.select({
						id: trustReviewFindings.id,
						code: trustReviewFindings.code,
						severity: trustReviewFindings.severity,
						message: trustReviewFindings.message,
						metadata: trustReviewFindings.metadata,
						createdAt: trustReviewFindings.createdAt,
						dismissedAt: trustReviewFindings.dismissedAt,
						dismissedNote: trustReviewFindings.dismissedNote,
						dismissedByEmail: users.email,
						journalEntryId: trustReviewFindings.journalEntryId,
						jeDate: journalEntries.date,
						jeMemo: journalEntries.memo,
						jeSourceType: journalEntries.sourceType,
						jeSourceId: journalEntries.sourceId,
					})
					.from(trustReviewFindings)
					.leftJoin(journalEntries, eq(trustReviewFindings.journalEntryId, journalEntries.id))
					.leftJoin(users, eq(trustReviewFindings.dismissedByUserId, users.id))
					.where(where)
					.orderBy(desc(trustReviewFindings.createdAt)),
		// Per-code counts for the Warning Types reference tab. Cheap GROUP BY.
		db
			.select({
				code: trustReviewFindings.code,
				openN: sql<number>`count(*) filter (where ${trustReviewFindings.dismissedAt} is null)::int`,
				totalN: sql<number>`count(*)::int`,
			})
			.from(trustReviewFindings)
			.where(eq(trustReviewFindings.organizationId, orgId))
			.groupBy(trustReviewFindings.code),
		// Contacts that actually appear on JEs with findings — drives the
		// Contact filter dropdown. Targeted query keeps the list short and
		// relevant rather than dumping every contact in the org.
		db
			.selectDistinct({ id: contacts.id, contactName: contacts.contactName })
			.from(contacts)
			.innerJoin(journalEntryLines, eq(journalEntryLines.contactId, contacts.id))
			.innerJoin(trustReviewFindings, eq(trustReviewFindings.journalEntryId, journalEntryLines.journalEntryId))
			.where(eq(trustReviewFindings.organizationId, orgId))
			.orderBy(contacts.contactName),
		// Trustee contacts — any contact with 'trustee' in typeTags. Drives
		// the per-row Assign Trustee action on the 710 group. Casting to
		// jsonb because contacts.type_tags is `json` (not jsonb) so the `?`
		// key-exists operator isn't applicable directly.
		db
			.select({ id: contacts.id, contactName: contacts.contactName })
			.from(contacts)
			.where(
				and(
					eq(contacts.organizationId, orgId),
					eq(contacts.isActive, true),
					sql`${contacts.typeTags}::jsonb ? 'trustee'`,
				),
			)
			.orderBy(contacts.contactName),
		// 501(c)(3) tagged contacts — drives the Pick-Charity dropdown on
		// the 515 verify-recipient finding.
		db
			.select({ id: contacts.id, contactName: contacts.contactName })
			.from(contacts)
			.where(
				and(
					eq(contacts.organizationId, orgId),
					eq(contacts.isActive, true),
					sql`${contacts.typeTags}::jsonb ? 'charity_501c3'`,
				),
			)
			.orderBy(contacts.contactName),
		// Beneficiaries for the inline tagger on LINKAGE_REQUIRED findings.
		db
			.select({
				id: trustBeneficiaries.id,
				fullName: trustBeneficiaries.fullName,
				dateOfBirth: trustBeneficiaries.dateOfBirth,
				isIncapacitated: trustBeneficiaries.isIncapacitated,
			})
			.from(trustBeneficiaries)
			.where(eq(trustBeneficiaries.organizationId, orgId))
			.orderBy(trustBeneficiaries.fullName),
		// 4xx income accounts — drives the inline reclassify picker on
		// TRUST_DEPOSIT_NEEDS_CORPUS_OR_INCOME_CLASSIFICATION findings.
		db
			.select({
				id: chartOfAccounts.id,
				accountNumber: chartOfAccounts.accountNumber,
				accountName: chartOfAccounts.accountName,
			})
			.from(chartOfAccounts)
			.where(
				and(
					eq(chartOfAccounts.organizationId, orgId),
					inArray(chartOfAccounts.accountType, ['income', 'other_income']),
				),
			)
			.orderBy(chartOfAccounts.accountNumber),
		// Corpus equity account — gates the "→ Corpus" option on the
		// capital-gain classifier (some orgs don't have one configured).
		db
			.select({ id: chartOfAccounts.id })
			.from(chartOfAccounts)
			.where(
				and(
					eq(chartOfAccounts.organizationId, orgId),
					eq(chartOfAccounts.accountType, 'equity'),
					notInArray(chartOfAccounts.detailType, [
						'trust_distributions_to_beneficiaries',
						'retained_earnings',
					]),
				),
			)
			.limit(1),
		// Active loans for the LinkPaymentToLoan picker on
		// TRUST_DEFERRED_LOAN_SPLIT_NEEDED rows.
		db
			.select({
				id: loans.id,
				displayName: loans.displayName,
			})
			.from(loans)
			.where(and(eq(loans.organizationId, orgId), eq(loans.status, 'active')))
			.orderBy(loans.displayName),
		// Next unposted schedule row per loan — used to preview the auto-
		// linked payment in the picker label.
		db
			.select({
				loanId: loanAmortizationSchedules.loanId,
				paymentNumber: loanAmortizationSchedules.paymentNumber,
				dueDate: loanAmortizationSchedules.dueDate,
				principalAmount: loanAmortizationSchedules.principalAmount,
				interestAmount: loanAmortizationSchedules.interestAmount,
			})
			.from(loanAmortizationSchedules)
			.innerJoin(loans, eq(loans.id, loanAmortizationSchedules.loanId))
			.where(
				and(
					eq(loans.organizationId, orgId),
					eq(loans.status, 'active'),
					isNull(loanAmortizationSchedules.postedJournalEntryId),
				),
			)
			.orderBy(loanAmortizationSchedules.loanId, loanAmortizationSchedules.paymentNumber),
		// Expense accounts — drives the inline picker on
		// TRUST_ASSET_REPOST_REVIEW (move from asset to expense).
		db
			.select({
				id: chartOfAccounts.id,
				accountNumber: chartOfAccounts.accountNumber,
				accountName: chartOfAccounts.accountName,
			})
			.from(chartOfAccounts)
			.where(
				and(
					eq(chartOfAccounts.organizationId, orgId),
					inArray(chartOfAccounts.accountType, ['expenses', 'other_expense']),
				),
			)
			.orderBy(chartOfAccounts.accountNumber),
		// Every account on the org — drives the broad picker on
		// TRUST_NON_TRUST_CATEGORY_USED (the destination can be any trust
		// category, so we don't pre-filter).
		db
			.select({
				id: chartOfAccounts.id,
				accountNumber: chartOfAccounts.accountNumber,
				accountName: chartOfAccounts.accountName,
				accountType: chartOfAccounts.accountType,
			})
			.from(chartOfAccounts)
			.where(eq(chartOfAccounts.organizationId, orgId))
			.orderBy(chartOfAccounts.accountNumber),
		// Active rental properties — drives the picker on
		// TRUST_DEFERRED_RENTAL_NET_NEEDED. The new tag-memory findings
		// use loadAllDimensionOptions instead (it's the registry-driven
		// path) but this dedicated rental-property list stays for the
		// legacy TRUST_DEFERRED_RENTAL_NET_NEEDED action.
		db
			.select({
				id: rentalProperties.id,
				displayName: rentalProperties.displayName,
			})
			.from(rentalProperties)
			.where(and(eq(rentalProperties.organizationId, orgId), eq(rentalProperties.status, 'active')))
			.orderBy(rentalProperties.displayName),
	]);

	// Generic tag-dimension picker data for the new tag-memory finding
	// actions. Adding a new dimension is a one-line addition to
	// lib/tags/dimensions.ts; nothing here needs to change.
	const tagDimensionData = await loadAllDimensionOptions(orgId);

	const openN = openCount?.n ?? 0;
	const decisionedN = decisionedCount?.n ?? 0;
	const dismissedN = dismissedCount?.n ?? 0;
	const decisionedDismissedN = decisionedDismissedCount?.n ?? 0;
	const allN = openN + decisionedN + dismissedN + decisionedDismissedN;
	const codeCountsByCode = new Map(codeCounts.map((c) => [c.code, c]));
	const incomeAccounts = incomeAccountRows.map((a) => ({
		id: a.id,
		accountNumber: a.accountNumber,
		accountName: a.accountName,
	}));
	const expenseAccounts = expenseAccountRows.map((a) => ({
		id: a.id,
		accountNumber: a.accountNumber,
		accountName: a.accountName,
	}));
	const allAccounts = allAccountRows.map((a) => ({
		id: a.id,
		accountNumber: a.accountNumber,
		accountName: a.accountName,
		accountType: a.accountType,
	}));
	const rentalPropertyPicks = rentalPropertyRows.map((r) => ({
		id: r.id,
		displayName: r.displayName,
	}));
	const tagDimensions = tagDimensionData.map(({ dimension, options }) => ({
		entityType: dimension.entityType,
		label: dimension.label,
		shortLabel: dimension.shortLabel,
		emoji: dimension.emoji,
		options,
	}));
	const corpusAvailable = corpusAccountRows.length > 0;

	// Build per-loan "next unposted payment" lookup so the picker can show
	// "Chase auto loan — #14 2026-06-01 · $599.55" inline.
	const nextByLoan = new Map<string, { paymentNumber: number; dueDate: string; total: number }>();
	for (const r of nextLoanRows) {
		if (!nextByLoan.has(r.loanId)) {
			nextByLoan.set(r.loanId, {
				paymentNumber: r.paymentNumber,
				dueDate: r.dueDate,
				total: Number(r.principalAmount) + Number(r.interestAmount),
			});
		}
	}
	const loanPicks = loanRows.map((l) => {
		const next = nextByLoan.get(l.id);
		return {
			id: l.id,
			displayName: l.displayName,
			nextPaymentNumber: next?.paymentNumber ?? null,
			nextDueDate: next?.dueDate ?? null,
			nextTotal: next?.total ?? null,
		};
	});

	// Beneficiary picker options — same age/incapacitated math as the rules
	// engine so the picker can gray out non-qualifying choices on 815/820
	// findings.
	const today = new Date().toISOString().slice(0, 10);
	const beneficiaryOptions: BeneficiaryOption[] = beneficiaryRows.map((b) => {
		const ageYears = b.dateOfBirth ? ageYearsFromDob(b.dateOfBirth, today) : null;
		const qualifies = b.isIncapacitated || (ageYears !== null && ageYears < 21);
		const ageNote = b.isIncapacitated
			? 'incapacitated'
			: ageYears !== null
				? `age ${ageYears}`
				: 'DOB unknown';
		return { id: b.id, fullName: b.fullName, qualifies, ageNote };
	});

	// Enrich findings with per-JE summary (amount + a representative contact).
	// One batch GROUP BY query covers every JE referenced in the result set.
	// Amount = SUM(debit) across the JE's lines (== SUM(credit) for balanced
	// entries) which gives the total transaction value.
	const uniqueJeIds = Array.from(new Set(rows.map((r) => r.journalEntryId)));
	const jeSummaries = uniqueJeIds.length > 0
		? await db
				.select({
					journalEntryId: journalEntryLines.journalEntryId,
					amount: sql<string>`sum(${journalEntryLines.debit})::text`,
					contactName: sql<string | null>`max(${contacts.contactName})`,
				})
				.from(journalEntryLines)
				.leftJoin(contacts, eq(journalEntryLines.contactId, contacts.id))
				.where(inArray(journalEntryLines.journalEntryId, uniqueJeIds))
				.groupBy(journalEntryLines.journalEntryId)
		: [];
	const summaryByJe = new Map(jeSummaries.map((s) => [s.journalEntryId, s]));

	// For transaction-sourced JEs, prefer the source transaction's vendor
	// contact as the display name. The per-line `max(contactName)` above
	// would otherwise drift whenever a trust action retags a line (e.g.
	// trustee attribution sets the 710 line's contactId to the trustee, so
	// max() across [vendor, trustee] starts returning whichever sorts
	// later — flipping "Apple Inc" rows to "Trustee" after attribution).
	// Vendor identity is the stable display anchor; line contacts are
	// posting-side concerns.
	const txnVendorRows = uniqueJeIds.length > 0
		? await db
				.select({
					journalEntryId: journalEntries.id,
					vendorName: contacts.contactName,
					vendorContactId: contacts.id,
				})
				.from(journalEntries)
				.innerJoin(
					transactions,
					and(
						eq(transactions.id, journalEntries.sourceId),
						eq(journalEntries.sourceType, 'transaction'),
					),
				)
				.leftJoin(contacts, eq(transactions.contactId, contacts.id))
				.where(inArray(journalEntries.id, uniqueJeIds))
		: [];
	const vendorByJe = new Map(
		txnVendorRows
			.filter((r) => r.vendorName)
			.map((r) => [
				r.journalEntryId,
				{ name: r.vendorName as string, id: r.vendorContactId as string },
			]),
	);

	const enrichedRows: FindingRow[] = rows.map((r) => {
		const s = summaryByJe.get(r.journalEntryId);
		const vendor = vendorByJe.get(r.journalEntryId);
		return {
			...r,
			jeAmount: s?.amount ? Number(s.amount) : null,
			jeContactName: vendor?.name ?? s?.contactName ?? null,
			jeContactId: vendor?.id ?? null,
		};
	});

	// Vendor-type classifications for contacts that appear on
	// TRUST_DEFERRED_LOAN_SPLIT_NEEDED rows. Used to bucket the loan-payment
	// group into Loans / Credit Cards / Leases / Unclassified.
	const loanPaymentContactIds = Array.from(
		new Set(
			enrichedRows
				.filter((r) => r.code === 'TRUST_DEFERRED_LOAN_SPLIT_NEEDED' && r.jeContactId)
				.map((r) => r.jeContactId as string),
		),
	);
	const vendorClassByContact = await resolveVendorClassifications(
		orgId,
		loanPaymentContactIds,
	);
	const vendorClassificationByContact: Record<string, {
		vendorType: 'loan' | 'credit_card' | 'lease' | 'unclassified';
		contactId: string;
		contactName: string;
		loans: Array<{ id: string; displayName: string }>;
	}> = {};
	for (const [k, v] of vendorClassByContact) {
		vendorClassificationByContact[k] = v;
	}

	// All CC + lease accounts on the org. The "Not a Loan" menu shows the
	// Credit Card option as an eye-icon dropdown over this list (parallel to
	// the existing "Other" full-CoA picker) plus a "+ add new" icon for
	// instant account creation. Same shape for Lease (defaults match 680
	// Rents & Leases detail_type 'rent_or_lease_buildings').
	const [creditCardAccountRows, leaseAccountRows, vehicleRows] = await Promise.all([
		db
			.select({
				id: chartOfAccounts.id,
				accountNumber: chartOfAccounts.accountNumber,
				accountName: chartOfAccounts.accountName,
				accountType: chartOfAccounts.accountType,
			})
			.from(chartOfAccounts)
			.where(
				and(
					eq(chartOfAccounts.organizationId, orgId),
					eq(chartOfAccounts.detailType, 'credit_card'),
				),
			)
			.orderBy(chartOfAccounts.accountNumber),
		db
			.select({
				id: chartOfAccounts.id,
				accountNumber: chartOfAccounts.accountNumber,
				accountName: chartOfAccounts.accountName,
				accountType: chartOfAccounts.accountType,
			})
			.from(chartOfAccounts)
			.where(
				and(
					eq(chartOfAccounts.organizationId, orgId),
					eq(chartOfAccounts.detailType, 'rent_or_lease_buildings'),
				),
			)
			.orderBy(chartOfAccounts.accountNumber),
		// Trust-owned vehicles — drives the Pick-Vehicle dropdown on the
		// 605 finding. Filtered to active assets in the Vehicles asset
		// category (case-insensitive, since the seed uses 'Vehicles').
		db
			.select({
				id: fixedAssets.id,
				name: fixedAssets.name,
				assetNumber: fixedAssets.assetNumber,
				inServiceDate: fixedAssets.inServiceDate,
			})
			.from(fixedAssets)
			.innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
			.where(
				and(
					eq(fixedAssets.organizationId, orgId),
					eq(fixedAssets.status, 'active'),
					sql`lower(${assetCategories.name}) = 'vehicles'`,
				),
			)
			.orderBy(fixedAssets.name),
	]);

	// Group findings by code. Order groups by total count desc (most common
	// issues surface first), but within each group keep the createdAt DESC
	// ordering from the query.
	const groupsByCode = new Map<string, FindingRow[]>();
	for (const r of enrichedRows) {
		const list = groupsByCode.get(r.code);
		if (list) list.push(r);
		else groupsByCode.set(r.code, [r]);
	}
	const groups = Array.from(groupsByCode.entries())
		.map(([code, items]) => ({ code, items }))
		.sort((a, b) => b.items.length - a.items.length);

	return (
		<div className="flex flex-col gap-4">
			<header className="flex items-end justify-between">
				<div>
					<h1 className="text-2xl font-semibold">Trust Review</h1>
					<p className="text-sm text-zinc-500 dark:text-zinc-400">
						{trustEnabled
							? `${openN.toLocaleString()} open · ${decisionedN.toLocaleString()} decisioned · ${dismissedN.toLocaleString()} dismissed · ${groups.length} warning type${groups.length === 1 ? '' : 's'}`
							: 'Beneficial-trust accounting is not enabled on this organization.'}
					</p>
				</div>
			</header>

			{!trustEnabled && (
				<div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
					This queue surfaces postings flagged by the beneficial-trust rules
					engine (815/820 eligibility, 450 business-income blocks, K-1 / 1099
					issuance reminders, no-receipt warnings, etc.). It only applies when
					the organization&rsquo;s parent Enterprise has the Entity Type
					Onboarding toggle on AND the org is set to a trust entity type.
				</div>
			)}

			{trustEnabled && (
				<div className="flex items-center gap-2 text-sm">
					<ViewTab href="/trust-review?view=open" active={view === 'open'} label="Open" count={openN} />
					<ViewTab href="/trust-review?view=decisioned" active={view === 'decisioned'} label="Decisioned" count={decisionedN} />
					<ViewTab href="/trust-review?view=dismissed" active={view === 'dismissed'} label="Dismissed" count={dismissedN} />
					<ViewTab href="/trust-review?view=all" active={view === 'all'} label="All" count={allN} />
					<ViewTab href="/trust-review?view=types" active={view === 'types'} label="Warning Types" count={CODE_CATALOG.length} />
				</div>
			)}

			{trustEnabled && view !== 'types' && (
				<TrustReviewFilters
					codes={CODE_CATALOG.map((c) => ({ code: c.code, label: c.label }))}
					contacts={filterContacts}
					selected={{
						q,
						code: codeFilter,
						severity: severityFilter,
						contactId: contactIdFilter,
						start: startFilter,
						end: endFilter,
					}}
					preserve={{ view }}
				/>
			)}

			{view === 'types' ? (
				<WarningTypesReference codeCountsByCode={codeCountsByCode} />
			) : groups.length === 0 ? (
				<div className="rounded-lg border border-zinc-200 bg-white p-10 text-center text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
					{view === 'open'
						? 'No open findings. Postings on this org are passing the beneficial-trust rules.'
						: view === 'decisioned'
							? 'No decisioned findings yet. Postings rerouted via the per-row actions will show here.'
							: view === 'dismissed'
								? 'No dismissed findings yet.'
								: 'No findings recorded yet.'}
				</div>
			) : (
				<div className="flex flex-col gap-2">
					{groups.map((g) => (
						<FindingGroup
							key={g.code}
							code={g.code}
							codeLabel={codeLabel(g.code)}
							items={g.items}
							beneficiaryOptions={beneficiaryOptions}
							trusteeOptions={trusteeRows}
							incomeAccounts={incomeAccounts}
							expenseAccounts={expenseAccounts}
							allAccounts={allAccounts}
							corpusAvailable={corpusAvailable}
							loans={loanPicks}
							rentalProperties={rentalPropertyPicks}
							tagDimensions={tagDimensions}
							vendorClassificationByContact={vendorClassificationByContact}
							creditCardAccounts={creditCardAccountRows}
							leaseAccounts={leaseAccountRows}
							vehicles={vehicleRows.map((v) => ({
								id: v.id,
								name: v.name,
								sublabel: v.assetNumber
									? `#${v.assetNumber} · in service ${v.inServiceDate}`
									: `in service ${v.inServiceDate}`,
							}))}
							charities={charityRows}
							kind={
								view === 'dismissed'
									? 'dismissed'
									: DECISIONED_CODE_SET.has(g.code)
										? 'decisioned'
										: 'pending'
							}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function WarningTypesReference({
	codeCountsByCode,
}: {
	codeCountsByCode: Map<string, { openN: number; totalN: number }>;
}) {
	// Group catalog entries by their `group` field, preserving GROUP_ORDER.
	const byGroup = new Map<CodeGroup, CodeCatalogEntry[]>();
	for (const g of GROUP_ORDER) byGroup.set(g, []);
	for (const entry of CODE_CATALOG) {
		byGroup.get(entry.group)!.push(entry);
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
				Reference list of every rule the beneficial-trust engine can fire.
				Counts are scoped to this organization: <strong>open</strong> = not yet
				dismissed; <strong>total</strong> = all-time, including dismissed.
				A <SeverityPill severity="block" /> rule rejects the posting outright;{' '}
				<SeverityPill severity="warn" /> allows it but flags here.
			</div>

			{GROUP_ORDER.map((groupName) => {
				const items = byGroup.get(groupName) ?? [];
				if (items.length === 0) return null;
				return (
					<section key={groupName} className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
						<header className="border-b border-zinc-200 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
							{groupName} <span className="ml-1 normal-case tracking-normal text-zinc-400">· {items.length}</span>
						</header>
						<table className="w-full text-sm">
							<thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
								<tr>
									<th className="px-4 py-2 font-medium">Severity</th>
									<th className="px-4 py-2 font-medium">Code</th>
									<th className="px-4 py-2 font-medium">Description</th>
									<th className="px-4 py-2 text-right font-medium">On this org</th>
								</tr>
							</thead>
							<tbody>
								{items.map((entry) => {
									const counts = codeCountsByCode.get(entry.code);
									const openN = counts?.openN ?? 0;
									const totalN = counts?.totalN ?? 0;
									return (
										<tr
											key={entry.code}
											className={`border-t border-zinc-100 dark:border-zinc-800 ${
												totalN === 0 ? 'opacity-70' : ''
											}`}
										>
											<td className="px-4 py-2 align-top">
												<SeverityPill severity={entry.severity} />
											</td>
											<td className="px-4 py-2 align-top">
												<div className="font-medium text-zinc-800 dark:text-zinc-200">{entry.label}</div>
												<div className="mt-0.5 font-mono text-xs text-zinc-500">{entry.code}</div>
											</td>
											<td className="px-4 py-2 align-top text-zinc-700 dark:text-zinc-300">
												<div className="max-w-2xl">{entry.description}</div>
											</td>
											<td className="px-4 py-2 align-top text-right tabular-nums">
												{totalN === 0 ? (
													<span className="text-xs text-zinc-400">never fired</span>
												) : (
													<div>
														<div className="text-zinc-800 dark:text-zinc-200">
															<strong>{openN.toLocaleString()}</strong> open
														</div>
														<div className="text-xs text-zinc-500">
															{totalN.toLocaleString()} total
														</div>
													</div>
												)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</section>
				);
			})}
		</div>
	);
}

function ViewTab({
	href,
	active,
	label,
	count,
}: {
	href: string;
	active: boolean;
	label: string;
	count: number;
}) {
	return (
		<Link
			href={href}
			aria-pressed={active}
			className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
				active
					? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
					: 'border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900'
			}`}
		>
			{label} <span className="ml-1 text-xs opacity-75">{count.toLocaleString()}</span>
		</Link>
	);
}

function SeverityPill({ severity }: { severity: string }) {
	const cls = SEVERITY_PALETTE[severity.toLowerCase()] ?? SEVERITY_PALETTE.warn;
	return (
		<span
			className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${cls}`}
		>
			{severity}
		</span>
	);
}
