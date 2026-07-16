import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Real Estate Purchase Resolution.
 *
 * Acquiring real property is one of the most consequential acts a
 * trustee can take. This resolution backs the trustee's decision
 * against multiple lines of challenge:
 *   - UPIA prudent-investor analysis (why this property fits the
 *     IPS, how it diversifies, the underwriting)
 *   - Vesting / title — proper "Trustee of X Trust, dated Y"
 *     vesting language is what keeps the property out of the
 *     trustee's personal estate
 *   - Due-on-sale acknowledgment when the trust is taking title
 *     to financed property
 *   - Allocation between corpus (purchase price + improvements) and
 *     income (insurance, taxes, repairs) under UPIA §501–502
 *   - Insurance + property manager engagement (separate resolutions
 *     follow, but the decision is captured here)
 */

const VARIABLES_SCHEMA = z.object({
	/** Common street address of the property. */
	propertyAddress: z.string().min(1),
	/** Full legal description as recorded (lot/block/sub or metes &
	 *  bounds). */
	legalDescription: z.string().min(1),
	/** Property type. */
	propertyType: z.enum([
		'single_family_residential',
		'multifamily_residential',
		'commercial',
		'land',
		'mixed_use',
		'industrial',
		'other',
	]),
	/** Intended use of the property by the trust. */
	intendedUse: z.enum([
		'rental_income',
		'beneficiary_residence',
		'long_term_appreciation',
		'business_operation',
		'mixed',
	]),
	/** Purchase price in cents. */
	purchasePriceCents: z.number().int().nonnegative(),
	/** Cash portion of the consideration. */
	cashPortionCents: z.number().int().nonnegative(),
	/** Financed portion (if any). */
	financedPortionCents: z.number().int().nonnegative(),
	/** Lender name if financed. */
	lenderName: z.string().optional().nullable(),
	/** Closing date. */
	closingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Seller name. */
	sellerName: z.string().min(1),
	/** Whether the seller is a related party — if yes, paired
	 *  Conflict of Interest Waiver is required. */
	sellerIsRelatedParty: z.enum(['yes', 'no']),
	/** Exact vesting language to be used on the deed. */
	titleVesting: z.string().min(1),
	/** Source of acquisition funds (which trust account, sale
	 *  of which asset, or contribution to corpus). */
	sourceOfFunds: z.string().min(1),
	/** Independent appraisal / BPO / comparable sales evidence
	 *  supporting purchase price. */
	valuationEvidence: z.string().min(1),
	/** Prudent-investor analysis tying purchase to IPS. */
	prudentInvestorAnalysis: z.string().min(1),
	/** Title insurance — policy issuer and coverage. */
	titleInsurance: z.string().min(1),
	/** Property/hazard insurance carrier and coverage. */
	propertyInsurance: z.string().min(1),
	/** Recording instructions — county + recording method. */
	recordingInstructions: z.string().min(1),
	/** Due-on-sale acknowledgment when seller-financing or assumption.
	 *  Garn-St Germain Act §341(d)(8) carve-out applies to revocable
	 *  trusts only — non-grantor irrevocable trusts trigger DOS. */
	dueOnSaleAcknowledgment: z.enum(['no_financing', 'not_applicable_cash', 'acknowledged_acceleration_risk', 'lender_consent_obtained']).optional().nullable(),
});

type PurchaseVariables = z.infer<typeof VARIABLES_SCHEMA>;

const styles = StyleSheet.create({
	page: {
		paddingTop: 56,
		paddingBottom: 64,
		paddingHorizontal: 56,
		fontFamily: 'Helvetica',
		fontSize: 10.5,
		lineHeight: 1.4,
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
		width: 150,
		fontFamily: 'Helvetica-Bold',
		fontSize: 9,
		color: '#475569',
		textTransform: 'uppercase',
		letterSpacing: 0.4,
	},
	keyValueValue: { flex: 1, fontSize: 10, color: '#0f172a' },
	warningBlock: {
		marginVertical: 10,
		paddingVertical: 8,
		paddingHorizontal: 12,
		borderLeftWidth: 3,
		borderLeftColor: '#b45309',
		backgroundColor: '#fef3c7',
	},
	warningText: { fontSize: 9.5, color: '#78350f', lineHeight: 1.45 },
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

const PROPERTY_TYPE_LABEL: Record<PurchaseVariables['propertyType'], string> = {
	single_family_residential: 'Single-family residential',
	multifamily_residential: 'Multifamily residential',
	commercial: 'Commercial',
	land: 'Vacant land',
	mixed_use: 'Mixed-use',
	industrial: 'Industrial',
	other: 'Other',
};

const INTENDED_USE_LABEL: Record<PurchaseVariables['intendedUse'], string> = {
	rental_income: 'Rental income production',
	beneficiary_residence: 'Beneficiary residence (subject to separate use agreement)',
	long_term_appreciation: 'Long-term appreciation',
	business_operation: 'Business operation',
	mixed: 'Mixed use',
};

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function realEstatePurchasePdf(args: RenderArgs<PurchaseVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const stateClause = trust.governingState
		? ` This Resolution is executed under the laws of ${trust.governingState}.`
		: '';
	const financed = v.financedPortionCents > 0;
	const relatedParty = v.sellerIsRelatedParty === 'yes';

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>REAL ESTATE PURCHASE RESOLUTION</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · {formatDate(v.closingDate)}
				</Text>
				<View style={styles.hr} />

				<Text style={styles.intro}>
					The undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
					{trust.effectiveDate ? `, established ${formatDate(trust.effectiveDate)}` : ''}
					{trust.ein ? `, EIN ${trust.ein}` : ''}, having determined this acquisition to be consistent with the purposes of the Trust and the prudent-investor rule, hereby resolves to acquire the real property described below.{stateClause}
				</Text>

				<Text style={styles.sectionHeader}>1. Property</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Address</Text>
						<Text style={styles.keyValueValue}>{v.propertyAddress}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Property type</Text>
						<Text style={styles.keyValueValue}>{PROPERTY_TYPE_LABEL[v.propertyType]}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Intended use</Text>
						<Text style={styles.keyValueValue}>{INTENDED_USE_LABEL[v.intendedUse]}</Text>
					</View>
				</View>
				<Text style={styles.body}>
					<Text style={styles.emph}>Legal description: </Text>{v.legalDescription}
				</Text>

				<Text style={styles.sectionHeader}>2. Consideration</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Purchase price</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.purchasePriceCents)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Cash portion</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.cashPortionCents)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Financed portion</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.financedPortionCents)}{v.lenderName ? ` — ${v.lenderName}` : ''}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Seller</Text>
						<Text style={styles.keyValueValue}>{v.sellerName}{relatedParty ? ' (related party)' : ''}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Closing date</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.closingDate)}</Text>
					</View>
				</View>

				<Text style={styles.sectionHeader}>3. Source of acquisition funds</Text>
				<Text style={styles.body}>{v.sourceOfFunds}</Text>

				<Text style={styles.sectionHeader}>4. Title vesting</Text>
				<Text style={styles.body}>
					Title shall vest exactly as follows: <Text style={styles.emph}>{v.titleVesting}</Text>. The recording party is instructed to use this vesting language verbatim and to refuse closing if the deed is not so worded.
				</Text>

				<Text style={styles.sectionHeader}>5. Valuation evidence</Text>
				<Text style={styles.body}>{v.valuationEvidence}</Text>

				<Text style={styles.sectionHeader}>6. Prudent-investor determination</Text>
				<Text style={styles.body}>{v.prudentInvestorAnalysis}</Text>

				<Text style={styles.sectionHeader}>7. Title insurance &amp; hazard coverage</Text>
				<Text style={styles.body}><Text style={styles.emph}>Title insurance: </Text>{v.titleInsurance}</Text>
				<Text style={styles.body}><Text style={styles.emph}>Property insurance: </Text>{v.propertyInsurance}</Text>

				<Text style={styles.sectionHeader}>8. Recording</Text>
				<Text style={styles.body}>{v.recordingInstructions}</Text>

				{financed && v.dueOnSaleAcknowledgment === 'acknowledged_acceleration_risk' && (
					<View style={styles.warningBlock}>
						<Text style={styles.warningText}>
							<Text style={styles.emph}>Due-on-sale notice:</Text> The Garn-St Germain Act §341(d)(8) due-on-sale carve-out for transfers into trust applies only to revocable inter-vivos trusts where the borrower remains a beneficiary and there is no transfer of occupancy rights. As an irrevocable non-grantor trust, this acquisition does not benefit from that carve-out and may trigger the lender&rsquo;s due-on-sale clause. The Trustee acknowledges this risk and has determined to proceed.
						</Text>
					</View>
				)}

				{financed && v.dueOnSaleAcknowledgment === 'lender_consent_obtained' && (
					<View style={styles.warningBlock}>
						<Text style={styles.warningText}>
							<Text style={styles.emph}>Due-on-sale waiver on file:</Text> The Trustee has obtained written consent from the lender to take title in the Trust and has preserved that consent in the trust documentation archive.
						</Text>
					</View>
				)}

				{relatedParty && (
					<View style={styles.warningBlock}>
						<Text style={styles.warningText}>
							<Text style={styles.emph}>Related-party transaction:</Text> The seller is a related party. A separate Conflict of Interest Waiver under UTC §802(b)–(c) memorializes the fairness determination and supporting evidence and must accompany this Resolution.
						</Text>
					</View>
				)}

				<Text style={styles.sectionHeader}>9. Allocation</Text>
				<Text style={styles.body}>
					The purchase price, closing costs, and any pre-closing capital improvements are charged to <Text style={styles.emph}>corpus</Text> under UPIA §502. Ongoing property taxes, insurance, ordinary repairs, and operating expenses are charged to <Text style={styles.emph}>income</Text> under UPIA §501.
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
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template real-estate-purchase v1
				</Text>
			</Page>
		</Document>
	);
}

export const realEstatePurchaseTemplate: TemplateDefinition<PurchaseVariables> = {
	id: 'real-estate-purchase',
	version: '1',
	label: 'Real Estate Purchase Resolution',
	description:
		'Authorizes the Trust to acquire real property. Captures legal description, vesting language, prudent-investor finding, due-on-sale risk, title + hazard insurance, recording, and allocation between corpus and income.',
	category: 'operating',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: realEstatePurchasePdf,
	formFields: [
		{ name: 'propertyAddress', label: 'Property address', widget: 'text', span: 2 },
		{ name: 'legalDescription', label: 'Legal description (as recorded)', widget: 'textarea', rows: 2, span: 2 },
		{
			name: 'propertyType',
			label: 'Property type',
			widget: 'select',
			options: [
				{ value: 'single_family_residential', label: 'Single-family residential' },
				{ value: 'multifamily_residential', label: 'Multifamily residential' },
				{ value: 'commercial', label: 'Commercial' },
				{ value: 'land', label: 'Vacant land' },
				{ value: 'mixed_use', label: 'Mixed-use' },
				{ value: 'industrial', label: 'Industrial' },
				{ value: 'other', label: 'Other' },
			],
		},
		{
			name: 'intendedUse',
			label: 'Intended use',
			widget: 'select',
			options: [
				{ value: 'rental_income', label: 'Rental income production' },
				{ value: 'beneficiary_residence', label: 'Beneficiary residence' },
				{ value: 'long_term_appreciation', label: 'Long-term appreciation' },
				{ value: 'business_operation', label: 'Business operation' },
				{ value: 'mixed', label: 'Mixed' },
			],
		},
		{ name: 'purchasePriceCents', label: 'Purchase price ($)', widget: 'dollars', cents: true },
		{ name: 'closingDate', label: 'Closing date', widget: 'date' },
		{ name: 'cashPortionCents', label: 'Cash portion ($)', widget: 'dollars', cents: true },
		{ name: 'financedPortionCents', label: 'Financed portion ($)', widget: 'dollars', cents: true },
		{
			name: 'lenderName',
			label: 'Lender name',
			widget: 'text',
			required: false,
			span: 2,
			visibleWhen: { field: 'financedPortionCents', gt: 0 },
		},
		{
			name: 'dueOnSaleAcknowledgment',
			label: 'Due-on-sale acknowledgment',
			widget: 'select',
			required: false,
			span: 2,
			visibleWhen: { field: 'financedPortionCents', gt: 0 },
			options: [
				{ value: 'no_financing', label: 'No third-party financing' },
				{ value: 'not_applicable_cash', label: 'N/A (cash purchase)' },
				{ value: 'acknowledged_acceleration_risk', label: 'Acknowledged — Garn-St Germain does not apply to non-grantor trust' },
				{ value: 'lender_consent_obtained', label: 'Written lender consent obtained' },
			],
		},
		{ name: 'sellerName', label: 'Seller name', widget: 'text', span: 2 },
		{
			name: 'sellerIsRelatedParty',
			label: 'Is the seller a related party?',
			widget: 'select',
			options: [
				{ value: 'no', label: 'No' },
				{ value: 'yes', label: 'Yes — pair with Conflict of Interest Waiver' },
			],
		},
		{
			name: 'titleVesting',
			label: 'Title vesting language (verbatim for the deed)',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "Jane Doe, as Trustee of the Smith Family Beneficial Trust dated January 1, 2024"',
			span: 2,
		},
		{
			name: 'sourceOfFunds',
			label: 'Source of acquisition funds',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "Wire from Trust operating account at ABC Bank, funded by sale of XYZ securities under Asset Disposition Resolution dated…"',
			span: 2,
		},
		{
			name: 'valuationEvidence',
			label: 'Valuation evidence',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "Independent appraisal by Smith Appraisal Co. dated 2026-04-15 at $X; supporting comparable sales attached"',
			span: 2,
		},
		{
			name: 'prudentInvestorAnalysis',
			label: 'Prudent-investor determination',
			widget: 'textarea',
			rows: 3,
			placeholder: 'How this property fits the IPS (target allocation to real estate, expected cap rate, liquidity profile, role in diversification).',
			span: 2,
		},
		{
			name: 'titleInsurance',
			label: 'Title insurance',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "Old Republic Title — owner\'s policy, full purchase price, standard exceptions only"',
			span: 2,
		},
		{
			name: 'propertyInsurance',
			label: 'Property insurance',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "Travelers — $X dwelling, $1M liability, named insured: Trustee of the Trust"',
			span: 2,
		},
		{
			name: 'recordingInstructions',
			label: 'Recording instructions',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "Record warranty deed with Travis County Clerk; trust certificate to accompany; mail recorded deed to Trustee at trust address"',
			span: 2,
		},
	],
};
