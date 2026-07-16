/**
 * Smoke-test every resolution template by invoking its renderPdf
 * with realistic synthetic variables. The goal is to surface runtime
 * errors before a user hits them — bad StyleSheet keys, undefined
 * field accesses inside conditional warning blocks, broken
 * date-format calls, etc.
 *
 * For each template we:
 *   1. Build a synthetic variables object matching the template's
 *      zod schema (verified by .parse — if the schema rejects, the
 *      synthetic data was wrong).
 *   2. Call renderResolutionPdf with the synthetic args.
 *   3. Verify the returned buffer is non-empty.
 *
 * Optional: pass --write to dump each rendered PDF to
 * ./tmp/smoke-tests/<template-id>.pdf for visual inspection.
 *
 * Usage:
 *   tsx scripts/smoke-test-templates.ts
 *   tsx scripts/smoke-test-templates.ts --write
 */

import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Signer, TrustHeader } from '@/lib/resolutions/types';

// Bootstrap a no-op `server-only` resolution so tsx can import the
// resolution modules outside Next.js. Next ships its own copy under
// node_modules/next/dist/compiled/server-only/empty.js. Copying that
// empty stub into a top-level node_modules/server-only/ lets Node's
// resolver pick it up. The registry / render modules are loaded via
// dynamic import inside main() AFTER this bootstrap runs.
function bootstrapServerOnlyStub() {
	const stubDir = join(process.cwd(), 'node_modules', 'server-only');
	const stubIndex = join(stubDir, 'index.js');
	const stubPkg = join(stubDir, 'package.json');
	const nextEmpty = join(process.cwd(), 'node_modules', 'next', 'dist', 'compiled', 'server-only', 'empty.js');
	const nextPkg = join(process.cwd(), 'node_modules', 'next', 'dist', 'compiled', 'server-only', 'package.json');
	if (!existsSync(nextEmpty)) return;
	if (!existsSync(stubDir)) mkdirSync(stubDir, { recursive: true });
	if (!existsSync(stubPkg)) copyFileSync(nextPkg, stubPkg);
	// Always overwrite index.js with the empty (no-op) variant — the
	// upstream index.js throws by design, which kills the script.
	copyFileSync(nextEmpty, stubIndex);
}

const writeFiles = process.argv.includes('--write');

const SYNTHETIC_TRUST: TrustHeader = {
	organizationId: 'smoke-test-org',
	trustName: 'The Smoke Test Beneficial Trust',
	effectiveDate: '2024-01-01',
	governingState: 'Texas',
	situsState: 'Texas',
	ein: '87-1234567',
	grantorName: 'Jane Q. Grantor',
	defaultSigningAuthority: 'sole',
};

const SYNTHETIC_SIGNERS: Signer[] = [
	{
		id: 'signer-trustee-1',
		role: 'Trustee',
		expectedName: 'John A. Trustee',
		signedName: 'John A. Trustee',
		signedAt: '2026-05-25T15:30:00Z',
		signedIp: '198.51.100.42',
	},
	{
		id: 'signer-other-1',
		role: 'Borrower',
		expectedName: 'Sarah B. Beneficiary',
		signedName: null,
		signedAt: null,
		signedIp: null,
	},
	{
		id: 'signer-dissent-1',
		role: 'Dissenting Co-Trustee',
		expectedName: 'Mike X. Dissenter',
		signedName: 'Mike X. Dissenter',
		signedAt: '2026-05-25T16:00:00Z',
		signedIp: '198.51.100.99',
	},
];

const TODAY = '2026-05-25';

/**
 * Synthetic variables per template id. When a template id isn't
 * here, the smoke test is skipped with a warning — keeps the script
 * honest about what's actually being tested.
 */
const SYNTHETIC_VARIABLES: Record<string, Record<string, unknown>> = {
	'bill-of-sale': {
		sellerName: 'Jane Q. Grantor',
		sellerAddress: '100 Main St, Austin, TX 78701',
		assetDescription: '2019 Ford F-150 · VIN 1FTEW1EP5JKE12345',
		assetType: 'vehicle',
		considerationCents: 32_500_00,
		paymentTerms: 'demand_note',
		transferDate: TODAY,
		demandNoteAccountLabel: '210.1 Grantor Demand Note Payable',
	},
	'distribution-authorization': {
		beneficiaryName: 'Sarah B. Beneficiary',
		beneficiaryRelationship: 'Daughter',
		amountCents: 15_000_00,
		distributionDate: TODAY,
		taxYear: 2026,
		purpose: 'Health, education, maintenance, and support',
		sourceAccountLabel: '110.0 Trust Operating',
		character: 'income',
		standardApplied: 'HEMS',
		hemsCategory: 'health',
		otherResourcesConsidered: true,
		hemsFindings: 'Beneficiary lacks sufficient other resources to cover this medical expense. Reviewed beneficiary\'s most recent income statement and prior distributions.',
	},
	'asset-acquisition-resolution': {
		assetDescription: '2021 Honda CR-V',
		vendorName: 'ABC Auto Sales',
		vendorAddress: '500 Commerce Blvd, Austin, TX 78704',
		costCents: 28_750_00,
		fundingSource: 'cash',
		acquisitionDate: TODAY,
		businessPurpose: 'Vehicle acquired to support routine trust-property maintenance trips and beneficiary medical-appointment transportation.',
	},
	'schedule-a': {
		revision: 1,
		asOfDate: TODAY,
		assets: [
			{
				name: 'Initial cash contribution',
				categoryName: 'Cash',
				acquisitionType: 'contributed',
				costBasisCents: 100_000_00,
				fmvCents: 100_000_00,
				inServiceDate: '2024-01-01',
				assetNumber: null,
				serialNumber: null,
				location: null,
			},
		],
	},
	'capital-gain-to-corpus-memo': {
		assetDescription: 'Apple Inc. (AAPL) — 200 shares',
		amountCents: 12_400_00,
		gainDate: TODAY,
		taxYear: 2026,
		holdingPeriodNote: 'Acquired 2020-03-15, sold 2026-05-20 — long-term',
		allocationJustification: 'Capital gain allocated to corpus under UPIA §404.',
		instrumentCitation: 'Section 6.2 of the Trust Agreement',
	},
	'declaration-of-extraordinary-dividend': {
		taxYear: 2025,
		periodEndDate: '2025-12-31',
		items: [
			{ accountNumber: '410', accountName: 'Interest income', incomeCents: 4_500_00, distributedCents: 2_000_00, retainedCents: 2_500_00 },
		],
	},
	'beneficiary-receipt-and-release': {
		beneficiaryName: 'Sarah B. Beneficiary',
		beneficiaryRelationship: 'Daughter',
		amountCents: 15_000_00,
		distributionDate: TODAY,
		taxYear: 2026,
		character: 'income',
		authorizationDocumentId: null,
	},
	'asset-disposition-resolution': {
		assetDescription: '2018 Toyota Camry',
		dispositionDate: TODAY,
		buyerName: 'XYZ Trade-In Inc.',
		buyerAddress: null,
		method: 'sale',
		proceedsCents: 14_000_00,
		feesCents: 200_00,
		costBasisCents: 22_000_00,
		accumulatedDepreciationCents: 9_500_00,
		gainOrLossCents: 1_300_00,
		holdingPeriodNote: 'Acquired 2018-06-12, disposed 2026-05-25',
		dispositionRationale: 'Disposed pursuant to fleet refresh plan.',
	},
	'annual-beneficiary-accounting': {
		taxYear: 2025,
		periodStartDate: '2025-01-01',
		periodEndDate: '2025-12-31',
		assetBalances: [
			{ accountNumber: '110', accountName: 'Operating cash', balanceCents: 50_000_00 },
		],
		liabilityBalances: [],
		receipts: [
			{ accountNumber: '410', accountName: 'Interest income', amountCents: 4_500_00 },
		],
		disbursements: [
			{ accountNumber: '510', accountName: 'Bank fees', amountCents: 240_00 },
		],
		distributions: [
			{ beneficiaryName: 'Sarah B. Beneficiary', amountCents: 15_000_00, distributionCount: 1 },
		],
		trusteeCompensationCents: 5_000_00,
	},
	'extraordinary-dividend-characterization': {
		receiptDescription: 'Special dividend from Acme Holdings, Inc. — one-time declaration',
		payer: 'Acme Holdings, Inc.',
		sourceAccountLabel: '410 Dividend Income',
		amountCents: 25_000_00,
		receiptDate: TODAY,
		taxYear: 2026,
		extraordinaryReason: 'one_time_special',
		characterizationRationale: 'Board\'s press release dated 2026-04-15 declares the distribution as a one-time special dividend not part of the issuer\'s ordinary dividend stream. Allocated to corpus under UPIA §404.',
		supportingEvidence: 'Press release URL on file; 1099-DIV box 1a value matches.',
	},
	'promissory-note': {
		borrowerName: 'Sarah B. Beneficiary',
		borrowerRelationship: 'beneficiary',
		borrowerAddress: '200 Oak Ln, Austin, TX 78704',
		principalCents: 50_000_00,
		annualRatePercent: 5.0,
		afrConfirmed: 'yes',
		noteDate: TODAY,
		maturityDate: '2027-05-25',
		paymentSchedule: 'demand',
		collateral: null,
		spendthriftAnalysis: 'Loan does not impair the spendthrift protection because terms are arm\'s-length and at-AFR.',
		sourceAccountLabel: '265.1 Sarah Beneficiary Demand Note',
		purpose: 'Working capital advance, repayable on demand.',
	},
	'conflict-of-interest-waiver': {
		transactionDescription: 'Sale of vacant lot from Trustee personally to the Trust',
		transactionDate: TODAY,
		amountCents: 75_000_00,
		counterpartyName: 'John A. Trustee (individual capacity)',
		relationship: 'trustee_self',
		conflictDescription: 'Trustee is on both sides of the transaction.',
		fairnessEvidence: 'Independent appraisal by Smith Appraisal Co. dated 2026-04-10 supports the $75k price; two comparable lots within 1 mile sold at $73k and $77k in Q1 2026.',
		beneficiaryConsent: 'obtained',
		courtApproval: 'not_required',
		instrumentAuthority: null,
		fairnessDetermination: 'Transaction is fair to the Trust on the appraisal + comparables; beneficiary written consent on file.',
	},
	'investment-policy-statement': {
		trustPurposes: 'Preservation of capital for current beneficiaries with growth for future generations.',
		timeHorizonYears: 20,
		distributionRatePercent: 4.0,
		riskTolerance: 'moderate',
		targetAllocation: '60% equities / 30% fixed income / 5% real estate / 5% cash, ±10% per asset class',
		permittedAssetClasses: 'US large-cap, US small-cap, international developed, IG bonds, REITs, cash',
		prohibitedInvestments: 'Margin, naked options, single positions > 25%',
		rebalancingPolicy: 'Rebalance when any asset class drifts ±5% from target; review quarterly.',
		benchmark: '60/40 stock/bond blended index',
		reviewCadence: 'annual',
		delegatedToManager: 'no',
		managerName: null,
		effectiveDate: TODAY,
	},
	'real-estate-purchase': {
		propertyAddress: '450 Elm Street, Austin, TX 78704',
		legalDescription: 'Lot 4, Block B, Travis Heights Subdivision, recorded in Vol. 12 Pg. 345 of the Travis County Plat Records',
		propertyType: 'single_family_residential',
		intendedUse: 'rental_income',
		purchasePriceCents: 425_000_00,
		cashPortionCents: 125_000_00,
		financedPortionCents: 300_000_00,
		lenderName: 'First Texas Bank',
		closingDate: TODAY,
		sellerName: 'Robert Q. Seller',
		sellerIsRelatedParty: 'no',
		titleVesting: 'John A. Trustee, as Trustee of the Smoke Test Beneficial Trust dated January 1, 2024',
		sourceOfFunds: 'Wire from Trust operating account at First Texas Bank.',
		valuationEvidence: 'Independent appraisal at $430k, three comparable sales between $420–$435k.',
		prudentInvestorAnalysis: 'Property fits IPS real-estate allocation (target 5%) with expected 6.5% cap rate.',
		titleInsurance: 'Old Republic Title — owner\'s policy at full purchase price.',
		propertyInsurance: 'Travelers — $500k dwelling, $1M liability, Trustee named insured.',
		recordingInstructions: 'Record warranty deed with Travis County Clerk; trust certificate to accompany.',
		dueOnSaleAcknowledgment: 'acknowledged_acceleration_risk',
	},
	'real-estate-sale': {
		propertyAddress: '450 Elm Street, Austin, TX 78704',
		legalDescription: 'Lot 4, Block B, Travis Heights Subdivision',
		propertyType: 'single_family_residential',
		salePriceCents: 520_000_00,
		sellingExpensesCents: 31_200_00,
		adjustedBasisCents: 395_000_00,
		accumulatedDepreciationCents: 30_000_00,
		closingDate: TODAY,
		acquisitionDate: '2022-03-15',
		buyerName: 'Mary Q. Buyer',
		buyerIsRelatedParty: 'no',
		saleRationale: 'Market conditions favor sale; proceeds will be redeployed per IPS.',
		proceedsDisposition: 'Wire to Trust operating account; held as cash pending reinvestment.',
		titleTransferInstructions: 'Execute special warranty deed; recorded by escrow agent.',
		section121Analysis: '§121 does not apply to a non-grantor irrevocable trust.',
	},
	'section-663b-65-day-election': {
		priorTaxYear: 2025,
		estimatedDniRetainedCents: 50_000_00,
		estimatedTaxSavingsCents: 12_000_00,
		electionAmountCents: 25_000_00,
		distributionsCovered: '2026-02-14 — Sarah B. Beneficiary — $12,500; 2026-03-01 — Sarah B. Beneficiary — $12,500',
		rationale: 'Bracket differential between trust-level (37%) and beneficiary marginal (24%) yields ~$3,250/year savings.',
		electionDeadline: '2026-03-06',
		electionDate: '2026-02-15',
		returnPreparerName: 'Smith CPA LLP',
	},
	'professional-engagement': {
		professionalName: 'Smith CPA LLP',
		professionalRole: 'cpa_tax_preparer',
		effectiveDate: TODAY,
		isDelegation: 'no_advisory_only',
		scopeOfWork: 'Preparation of Form 1041 + K-1s for tax year 2026; quarterly estimated tax planning.',
		feeArrangement: '$5,000 flat for 1041 prep; hourly at $250 for planning.',
		estimatedAnnualCostCents: 8_000_00,
		chargeAllocation: 'income',
		allocationNarrative: null,
		engagementTerm: 'annual',
		selectionRationale: 'Licensed CPA in Texas, 20 years trust-and-estate experience, references from three peer trusts.',
		conflictScreen: 'no_conflict_disclosed',
		engagementLetterReference: 'Engagement letter dated 2026-05-01, archived in trust documentation.',
	},
	'utc-813-initial-notice': {
		triggerEventDate: '2024-01-01',
		triggerEvent: 'trust_creation',
		qualifiedBeneficiaryNames: 'Sarah B. Beneficiary\nMichael R. Beneficiary\nThe Future Generations Class (presumptive remainder)',
		noticeDeadline: '2024-03-01',
		noticeDate: '2024-02-15',
		trusteeContactAddress: '300 Trustee Way, Austin, TX 78704',
		trusteeContactDetails: 'trustee@example.com · (512) 555-0142',
		compensationDisclosure: 'Trustee receives $5,000 annual compensation per the Trustee Compensation Resolution dated 2024-01-15.',
		deliveryMethod: 'certified_mail',
		exclusionsNoted: null,
	},
	'trustee-compensation': {
		periodStart: '2026-01-01',
		periodEnd: '2026-12-31',
		resolutionDate: TODAY,
		compensationMethod: 'flat_annual',
		methodDetails: '$5,000 flat annual fee, paid quarterly.',
		totalCompensationCents: 5_000_00,
		upiaAllocation: 'income_50_corpus_50',
		allocationNarrative: null,
		instrumentAuthority: 'silent',
		instrumentCitation: null,
		reasonablenessAnalysis: 'Trustee skill (20 years investment experience), time (~50 hrs/yr), complexity (multi-asset trust including RE), comparable fees (institutional fiduciary minimums $7,500/yr for similar AUM).',
		coTrusteeConsent: 'no_co_trustees',
		conflictWaiverPaired: 'no_relying_on_708',
	},
	'lease-resolution': {
		propertyAddress: '450 Elm Street, Austin, TX 78704',
		propertyDescription: '3BR/2BA single-family home',
		tenantName: 'Alex T. Tenant',
		tenantIsRelatedParty: 'no',
		leaseType: 'residential',
		termStart: '2026-06-01',
		termEnd: '2027-06-01',
		isMonthToMonth: 'no',
		monthlyRentCents: 2_400_00,
		securityDepositCents: 2_400_00,
		lateFeePolicy: '$50 if rent is more than 5 days late',
		utilitiesArrangement: 'tenant_pays_all',
		utilitiesNarrative: null,
		marketRateEvidence: 'Three comparable 3BR/2BA homes within 1 mile renting for $2,300–$2,500/mo per Zillow pulled 2026-05-20.',
		propertyManagerName: null,
		leaseDocumentReference: 'Standard residential lease (TAA form) dated 2026-05-20, archived.',
	},
	'insurance-authorization': {
		coverageType: 'property_hazard',
		otherCoverageDescription: null,
		insuredInterest: '450 Elm Street, Austin, TX 78704 — single-family home',
		carrierName: 'Travelers Insurance',
		policyNumber: 'TX-PH-2026-00451',
		effectiveDate: '2026-06-01',
		expirationDate: '2027-06-01',
		coverageLimitCents: 500_000_00,
		deductibleCents: 2_500_00,
		annualPremiumCents: 1_400_00,
		premiumCadence: 'annual',
		namedInsured: 'John A. Trustee, as Trustee of the Smoke Test Beneficial Trust dated January 1, 2024',
		upiaAllocation: 'income_default_801',
		allocationNarrative: null,
		selectionRationale: 'Travelers carries A+ AM Best rating; competitive quote vs. State Farm + USAA; coverage limit set at replacement cost per appraisal.',
	},
	'co-trustee-dissent': {
		actionDate: '2026-05-20',
		dissentDate: '2026-05-21',
		actionDescription: 'Majority approved distribution to a non-qualified beneficiary in excess of HEMS standard.',
		actionReference: 'Distribution Authorization #DA-2026-018 dated 2026-05-20',
		majorityTrusteeNames: 'John A. Trustee\nAlice Z. Co-Trustee',
		dissentReasons: 'Distribution exceeds HEMS standard as applied to this beneficiary; no documented showing of other resources insufficient.',
		timingNarrative: 'communicated_at_action',
		timingExplanation: null,
		furtherAction: 'will_take_no_part_in_implementation',
		furtherActionNarrative: null,
	},
	'litigation-authorization': {
		posture: 'defend_against_claim',
		matterTitle: 'Plaintiff v. Smoke Test Trust, Cause No. 2026-CV-1234',
		courtOrForum: 'Travis County District Court, Texas',
		counterparty: 'Aggrieved Vendor LLC',
		counterpartyIsRelatedParty: 'no',
		amountAtStakeCents: 75_000_00,
		authorizedAction: 'Defend the claim, conduct discovery, attempt mediation; settle for up to $25k without further authorization.',
		counselName: 'Smith Defense Law LLP',
		counselEngagementReference: 'Engagement letter dated 2026-05-15; Professional Engagement Resolution on file.',
		budgetCents: 50_000_00,
		decisionBasis: 'Counsel assesses 70% probability of dismissal or summary judgment for the Trust. Mediation viable.',
		adrConsidered: 'agreed_to_proceed',
		adrNarrative: 'Court-mandated mediation scheduled for 2026-08-15.',
		beneficiaryNotice: 'notice_given',
		noticeNarrative: 'Notice delivered to qualified beneficiaries on 2026-05-18 via certified mail.',
		upiaAllocation: 'corpus_extraordinary',
		allocationNarrative: null,
	},
	'decanting-resolution': {
		statutoryBasis: 'state_statute',
		authorityCitation: 'Tex. Prop. Code §112.071–.087',
		effectiveDate: TODAY,
		recipientTrustName: 'The Smoke Test Beneficial Trust II',
		recipientTrustEffectiveDate: TODAY,
		recipientTrustStatus: 'created_for_decanting',
		decantingPurpose: 'Modernize administrative provisions and add a directed-trustee structure separating investment from distribution decisions.',
		changeCategories: 'Administrative — directed trustee structure; Situs — change of administrative situs to DE',
		materialChangesNarrative: 'From → To: § 4.1 Single trustee → Investment Trustee + Distribution Trustee; § 9 Texas situs → Delaware situs.',
		beneficialInterestsChanged: 'no_administrative_only',
		beneficialInterestsAnalysis: 'Identical beneficiaries with identical interests in both Source and Recipient. No change in current/remainder allocation.',
		taxAnalysis: 'No gift / GST consequences (no beneficial-interest change). Trust remains non-grantor for income-tax purposes. Confirmed with Smith Tax Counsel LLP.',
		beneficiaryNotice: 'notice_given',
		noticeNarrative: 'Statutory notice delivered to all qualified beneficiaries on 2026-04-15; 60-day period expired 2026-06-14.',
		assetTransferDescription: 'All trust assets transferred via assignment + bank account re-titling.',
	},
};

interface Result {
	templateId: string;
	pass: boolean;
	durationMs: number;
	error?: string;
	bufferBytes?: number;
}

type RegistryFns = {
	listTemplates: typeof import('@/lib/resolutions/registry').listTemplates;
	getTemplate: typeof import('@/lib/resolutions/registry').getTemplate;
	renderResolutionPdf: typeof import('@/lib/resolutions/render').renderResolutionPdf;
};

async function runOne(deps: RegistryFns, templateId: string): Promise<Result> {
	const t0 = Date.now();
	try {
		const template = deps.getTemplate(templateId);
		if (!template) {
			return { templateId, pass: false, durationMs: Date.now() - t0, error: 'Template not found in registry' };
		}
		const vars = SYNTHETIC_VARIABLES[templateId];
		if (!vars) {
			return { templateId, pass: false, durationMs: Date.now() - t0, error: 'No synthetic variables defined' };
		}
		const buf = await deps.renderResolutionPdf({
			templateId,
			variables: vars,
			trust: SYNTHETIC_TRUST,
			signers: SYNTHETIC_SIGNERS,
			draftedAt: '2026-05-26T12:00:00Z',
		});
		if (buf.length === 0) {
			return { templateId, pass: false, durationMs: Date.now() - t0, error: 'Empty buffer' };
		}
		if (writeFiles) {
			mkdirSync('./tmp/smoke-tests', { recursive: true });
			writeFileSync(join('./tmp/smoke-tests', `${templateId}.pdf`), buf);
		}
		return { templateId, pass: true, durationMs: Date.now() - t0, bufferBytes: buf.length };
	} catch (err) {
		return {
			templateId,
			pass: false,
			durationMs: Date.now() - t0,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

async function main() {
	// Bootstrap MUST run before importing the resolution modules — they
	// `import 'server-only'` at the top of every file.
	bootstrapServerOnlyStub();
	const registry = await import('@/lib/resolutions/registry');
	const render = await import('@/lib/resolutions/render');
	const deps: RegistryFns = {
		listTemplates: registry.listTemplates,
		getTemplate: registry.getTemplate,
		renderResolutionPdf: render.renderResolutionPdf,
	};

	const templates = deps.listTemplates();
	console.log(`Smoke-testing ${templates.length} templates${writeFiles ? ' (writing PDFs to ./tmp/smoke-tests/)' : ''}\n`);

	const results: Result[] = [];
	for (const t of templates) {
		const r = await runOne(deps, t.id);
		results.push(r);
		const status = r.pass ? '✓' : '✗';
		const size = r.bufferBytes ? ` ${(r.bufferBytes / 1024).toFixed(1)}kb` : '';
		console.log(`  ${status} ${t.id.padEnd(40)} ${r.durationMs}ms${size}${r.error ? `  — ${r.error}` : ''}`);
	}

	const passed = results.filter((r) => r.pass).length;
	const failed = results.filter((r) => !r.pass);
	console.log(`\n${passed}/${results.length} passed`);
	if (failed.length > 0) {
		console.log('\nFailures:');
		for (const f of failed) {
			console.log(`  ${f.templateId}: ${f.error}`);
		}
		process.exit(1);
	}
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
