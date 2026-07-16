import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Insurance Authorization Resolution.
 *
 * UTC §809 — duty to protect trust property. Includes carrying
 * reasonable insurance against insurable risks. UPIA §501 charges
 * insurance premiums to income; §502 lets the trustee charge a
 * portion to corpus when the policy benefits future generations
 * (e.g., a permanent life-insurance premium on a lifetime beneficiary
 * for the benefit of remainder beneficiaries).
 *
 * Without this resolution: any uninsured loss is a §809 breach; any
 * over-insurance with corpus dollars is a §502 allocation challenge.
 *
 * Covers ANY policy the trust pays for: property/hazard, general
 * liability, umbrella, D&O for trustees, errors & omissions, key-
 * person life, valuable items / fine art, cyber, and even bond /
 * fiduciary policies on the trustee.
 */

const VARIABLES_SCHEMA = z.object({
	/** Coverage type. */
	coverageType: z.enum([
		'property_hazard',
		'general_liability',
		'umbrella',
		'trustee_eo',           // E&O / errors and omissions
		'trustee_bond',          // fiduciary bond / surety
		'life_insurance',
		'valuable_items_fine_art',
		'cyber',
		'workers_comp',
		'other',
	]),
	/** Coverage-type narrative when 'other'. */
	otherCoverageDescription: z.string().optional().nullable(),
	/** What the policy covers (the trust asset / interest insured). */
	insuredInterest: z.string().min(1),
	/** Insurance carrier / broker. */
	carrierName: z.string().min(1),
	/** Policy number. */
	policyNumber: z.string().min(1),
	/** Effective date. */
	effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Expiration date. */
	expirationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Coverage limits — total dollar amount of coverage. */
	coverageLimitCents: z.number().int().nonnegative(),
	/** Deductible. */
	deductibleCents: z.number().int().nonnegative(),
	/** Annual premium. */
	annualPremiumCents: z.number().int().nonnegative(),
	/** Premium payment cadence. */
	premiumCadence: z.enum(['annual', 'semi_annual', 'quarterly', 'monthly', 'single_premium']),
	/** Named insured language as it appears on the dec page. */
	namedInsured: z.string().min(1),
	/** UPIA allocation. */
	upiaAllocation: z.enum(['income_only', 'corpus_only', 'split', 'income_default_801']),
	/** Required for split — allocation narrative. */
	allocationNarrative: z.string().optional().nullable(),
	/** Selection / due-diligence: why this carrier and these limits. */
	selectionRationale: z.string().min(1),
});

type InsuranceVariables = z.infer<typeof VARIABLES_SCHEMA>;

const styles = StyleSheet.create({
	page: {
		paddingTop: 56,
		paddingBottom: 64,
		paddingHorizontal: 56,
		fontFamily: 'Helvetica',
		fontSize: 10.5,
		lineHeight: 1.45,
		color: '#1f2937',
	},
	title: {
		fontFamily: 'Helvetica-Bold',
		fontSize: 16,
		textAlign: 'center',
		marginBottom: 4,
		color: '#0f172a',
		letterSpacing: 1,
	},
	subtitle: {
		fontSize: 10,
		textAlign: 'center',
		color: '#64748b',
		marginBottom: 18,
	},
	hr: {
		borderBottomWidth: 1,
		borderBottomColor: '#0f172a',
		marginBottom: 14,
	},
	intro: { marginBottom: 12, textAlign: 'justify' },
	emph: { fontFamily: 'Helvetica-Bold' },
	sectionHeader: {
		marginTop: 14,
		marginBottom: 6,
		paddingBottom: 3,
		borderBottomWidth: 0.5,
		borderBottomColor: '#475569',
		fontFamily: 'Helvetica-Bold',
		fontSize: 10.5,
		color: '#0f172a',
		textTransform: 'uppercase',
		letterSpacing: 0.4,
	},
	body: { fontSize: 10.5, color: '#0f172a', marginBottom: 8, textAlign: 'justify' },
	keyValueBlock: {
		marginVertical: 8,
		paddingVertical: 8,
		paddingHorizontal: 12,
		backgroundColor: '#f1f5f9',
		borderRadius: 4,
	},
	keyValueRow: { flexDirection: 'row', marginBottom: 3 },
	keyValueKey: {
		width: 165,
		fontFamily: 'Helvetica-Bold',
		fontSize: 9,
		color: '#475569',
		textTransform: 'uppercase',
		letterSpacing: 0.4,
	},
	keyValueValue: { flex: 1, fontSize: 10, color: '#0f172a' },
	signaturesHeader: {
		marginTop: 22,
		marginBottom: 6,
		fontSize: 10,
		letterSpacing: 1.5,
		color: '#0f172a',
		fontFamily: 'Helvetica-Bold',
	},
	sigBlock: { marginTop: 16 },
	sigLineRule: {
		borderBottomWidth: 0.75,
		borderBottomColor: '#0f172a',
		marginBottom: 4,
		marginTop: 28,
	},
	sigName: {
		fontSize: 10.5,
		fontFamily: 'Helvetica-Bold',
		color: '#0f172a',
		marginBottom: 2,
	},
	sigLabel: { fontSize: 9.5, color: '#64748b' },
	sigMeta: { fontSize: 8.5, color: '#64748b', marginTop: 2 },
	footer: {
		position: 'absolute',
		bottom: 32,
		left: 56,
		right: 56,
		fontSize: 8,
		color: '#94a3b8',
		textAlign: 'center',
		borderTopWidth: 0.5,
		borderTopColor: '#cbd5e1',
		paddingTop: 6,
	},
});

const COVERAGE_LABEL: Record<InsuranceVariables['coverageType'], string> = {
	property_hazard: 'Property / hazard insurance',
	general_liability: 'General liability',
	umbrella: 'Umbrella (excess liability)',
	trustee_eo: 'Trustee errors and omissions (E&O)',
	trustee_bond: 'Fiduciary bond / surety',
	life_insurance: 'Life insurance',
	valuable_items_fine_art: 'Valuable items / fine art floater',
	cyber: 'Cyber liability',
	workers_comp: 'Workers\' compensation',
	other: 'Other coverage',
};

const CADENCE_LABEL: Record<InsuranceVariables['premiumCadence'], string> = {
	annual: 'Annual',
	semi_annual: 'Semi-annual',
	quarterly: 'Quarterly',
	monthly: 'Monthly',
	single_premium: 'Single premium (paid in full)',
};

const ALLOCATION_LABEL: Record<InsuranceVariables['upiaAllocation'], string> = {
	income_default_801: 'Income — UPIA §501 default for ordinary insurance premiums',
	income_only: 'Income (100%)',
	corpus_only: 'Corpus (100%) — extraordinary policy benefiting remainder',
	split: 'Split between income and corpus (see narrative)',
};

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function insuranceAuthorizationPdf(args: RenderArgs<InsuranceVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const stateClause = trust.governingState
		? ` This Resolution is executed under the laws of ${trust.governingState}.`
		: '';

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>INSURANCE AUTHORIZATION RESOLUTION</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · {COVERAGE_LABEL[v.coverageType]} · Effective {formatDate(v.effectiveDate)}
				</Text>
				<View style={styles.hr} />

				<Text style={styles.intro}>
					The undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
					{trust.ein ? ` (EIN ${trust.ein})` : ''}, in fulfillment of the duty to protect trust property under Uniform Trust Code §809, hereby authorizes the Trust to procure and maintain the insurance coverage described below.{stateClause}
				</Text>

				<Text style={styles.sectionHeader}>1. Coverage</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Coverage type</Text>
						<Text style={styles.keyValueValue}>{COVERAGE_LABEL[v.coverageType]}{v.coverageType === 'other' && v.otherCoverageDescription ? ` — ${v.otherCoverageDescription}` : ''}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Insured interest</Text>
						<Text style={styles.keyValueValue}>{v.insuredInterest}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Carrier</Text>
						<Text style={styles.keyValueValue}>{v.carrierName}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Policy number</Text>
						<Text style={styles.keyValueValue}>{v.policyNumber}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Policy period</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.effectiveDate)} – {formatDate(v.expirationDate)}</Text>
					</View>
				</View>

				<Text style={styles.sectionHeader}>2. Limits and economics</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Coverage limit</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.coverageLimitCents)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Deductible</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.deductibleCents)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Annual premium</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.annualPremiumCents)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Premium cadence</Text>
						<Text style={styles.keyValueValue}>{CADENCE_LABEL[v.premiumCadence]}</Text>
					</View>
				</View>

				<Text style={styles.sectionHeader}>3. Named insured</Text>
				<Text style={styles.body}>
					The policy shall identify the named insured as: <Text style={styles.emph}>{v.namedInsured}</Text>. The Trustee shall confirm that the dec page bears this language verbatim and shall correct any discrepancy with the carrier before binding.
				</Text>

				<Text style={styles.sectionHeader}>4. Selection &amp; reasonableness</Text>
				<Text style={styles.body}>{v.selectionRationale}</Text>

				<Text style={styles.sectionHeader}>5. UPIA allocation of premium</Text>
				<Text style={styles.body}>{ALLOCATION_LABEL[v.upiaAllocation]}</Text>
				{v.upiaAllocation === 'split' && v.allocationNarrative && (
					<Text style={styles.body}>{v.allocationNarrative}</Text>
				)}

				<Text style={styles.sectionHeader}>6. Trustee&rsquo;s determination</Text>
				<Text style={styles.body}>
					The Trustee has determined that this coverage is reasonable in nature, scope, and cost; is consistent with the duty under §809 to protect trust property; and is appropriately allocated between income and corpus under the Uniform Principal and Income Act. The Trustee shall review this coverage at renewal and document any material changes.
				</Text>

				<Text style={styles.signaturesHeader}>SIGNATURE</Text>

				<View style={styles.sigBlock}>
					<View style={styles.sigLineRule} />
					<Text style={styles.sigName}>{trustee?.signedName ?? trustee?.expectedName ?? 'Trustee'}</Text>
					<Text style={styles.sigLabel}>Trustee of {trustLabel}</Text>
					{trustee?.signedAt && (
						<Text style={styles.sigMeta}>
							Signed {trustee.signedAt}{trustee.signedIp ? ` · IP ${trustee.signedIp}` : ''}
						</Text>
					)}
				</View>

				<Text style={styles.footer}>
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template insurance-authorization v1
				</Text>
			</Page>
		</Document>
	);
}

export const insuranceAuthorizationTemplate: TemplateDefinition<InsuranceVariables> = {
	id: 'insurance-authorization',
	version: '1',
	label: 'Insurance Authorization Resolution',
	description:
		'UTC §809 duty-to-insure record for any policy the trust pays for: property/hazard, GL, umbrella, trustee E&O / bond, life, valuable items, cyber. Captures carrier, limits, premium, named-insured language, and UPIA premium allocation.',
	category: 'operating',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: insuranceAuthorizationPdf,
	formFields: [
		{
			name: 'coverageType',
			label: 'Coverage type',
			widget: 'select',
			options: [
				{ value: 'property_hazard', label: 'Property / hazard' },
				{ value: 'general_liability', label: 'General liability' },
				{ value: 'umbrella', label: 'Umbrella (excess liability)' },
				{ value: 'trustee_eo', label: 'Trustee E&O' },
				{ value: 'trustee_bond', label: 'Fiduciary bond / surety' },
				{ value: 'life_insurance', label: 'Life insurance' },
				{ value: 'valuable_items_fine_art', label: 'Valuable items / fine art' },
				{ value: 'cyber', label: 'Cyber liability' },
				{ value: 'workers_comp', label: 'Workers\' comp' },
				{ value: 'other', label: 'Other' },
			],
		},
		{
			name: 'otherCoverageDescription',
			label: 'Other coverage description',
			widget: 'text',
			required: false,
			visibleWhen: { field: 'coverageType', in: ['other'] },
		},
		{
			name: 'insuredInterest',
			label: 'Insured interest (what is covered)',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "Single-family home at 123 Main St" or "Trustee\'s acts as fiduciary of [Trust]"',
			span: 2,
		},
		{ name: 'carrierName', label: 'Carrier', widget: 'text' },
		{ name: 'policyNumber', label: 'Policy number', widget: 'text' },
		{ name: 'effectiveDate', label: 'Effective date', widget: 'date' },
		{ name: 'expirationDate', label: 'Expiration date', widget: 'date' },
		{ name: 'coverageLimitCents', label: 'Coverage limit ($)', widget: 'dollars', cents: true },
		{ name: 'deductibleCents', label: 'Deductible ($)', widget: 'dollars', cents: true },
		{ name: 'annualPremiumCents', label: 'Annual premium ($)', widget: 'dollars', cents: true },
		{
			name: 'premiumCadence',
			label: 'Premium cadence',
			widget: 'select',
			options: [
				{ value: 'annual', label: 'Annual' },
				{ value: 'semi_annual', label: 'Semi-annual' },
				{ value: 'quarterly', label: 'Quarterly' },
				{ value: 'monthly', label: 'Monthly' },
				{ value: 'single_premium', label: 'Single premium' },
			],
		},
		{
			name: 'namedInsured',
			label: 'Named insured (verbatim for dec page)',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "Jane Doe, as Trustee of the Smith Family Beneficial Trust dated January 1, 2024"',
			span: 2,
		},
		{
			name: 'selectionRationale',
			label: 'Selection rationale',
			widget: 'textarea',
			rows: 3,
			placeholder: 'Why this carrier and these limits. Address: carrier ratings (AM Best, S&P), competitive quotes obtained, replacement-cost or limits analysis, fit with the asset profile.',
			span: 2,
		},
		{
			name: 'upiaAllocation',
			label: 'UPIA premium allocation',
			widget: 'select',
			options: [
				{ value: 'income_default_801', label: 'Income — UPIA §501 default' },
				{ value: 'income_only', label: '100% income' },
				{ value: 'corpus_only', label: '100% corpus' },
				{ value: 'split', label: 'Split (narrative below)' },
			],
		},
		{
			name: 'allocationNarrative',
			label: 'Allocation narrative',
			widget: 'textarea',
			rows: 2,
			required: false,
			placeholder: 'Required when split — describe the income/corpus allocation.',
			span: 2,
			visibleWhen: { field: 'upiaAllocation', in: ['split'] },
		},
	],
};
