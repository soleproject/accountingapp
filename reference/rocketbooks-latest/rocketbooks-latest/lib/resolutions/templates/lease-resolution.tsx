import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Lease Resolution.
 *
 * Trustee authorizes the Trust to enter a lease as landlord of
 * trust-owned property. Backs the legal authority for every lease
 * the trust signs, captures market-rate evidence, and screens for
 * the personal-use-by-beneficiary trap (§267 imputed-rent / step-
 * transaction risk when a beneficiary occupies trust property at
 * below-market rent without a documented partial-distribution).
 *
 * Trust powers under UTC §816(8)–(9) include the power to enter and
 * grant options for leases, but the trustee must still apply prudent-
 * investor analysis and disclose any related-party tenant. Without
 * this resolution, a lease signed in the trust's name has uncertain
 * authority — title and recording offices may push back, and a
 * defaulting tenant can attack the lease for lack of capacity.
 */

const VARIABLES_SCHEMA = z.object({
	/** Property being leased (address). */
	propertyAddress: z.string().min(1),
	/** Brief property description (e.g., "3BR/2BA single-family home",
	 *  "1,200 sf office suite #4B"). */
	propertyDescription: z.string().min(1),
	/** Tenant name. */
	tenantName: z.string().min(1),
	/** Is the tenant a related party (beneficiary, trustee, or family
	 *  of either)? */
	tenantIsRelatedParty: z.enum(['no', 'yes_beneficiary', 'yes_trustee', 'yes_family']),
	/** Lease type. */
	leaseType: z.enum(['residential', 'commercial', 'land_only', 'mixed_use', 'short_term_vacation']),
	/** Lease term start. */
	termStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Lease term end (or "month-to-month" sentinel — keep date
	 *  required and use a flag for MTM). */
	termEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Month-to-month flag — when true the term end is just the
	 *  initial review date. */
	isMonthToMonth: z.enum(['yes', 'no']),
	/** Monthly rent (cents). */
	monthlyRentCents: z.number().int().nonnegative(),
	/** Security deposit (cents). */
	securityDepositCents: z.number().int().nonnegative(),
	/** Late fee policy. */
	lateFeePolicy: z.string().optional().nullable(),
	/** Who pays utilities (tenant / landlord / split). */
	utilitiesArrangement: z.enum(['tenant_pays_all', 'landlord_pays_all', 'split', 'tenant_pays_with_exceptions']),
	/** Utilities exceptions narrative when split or with exceptions. */
	utilitiesNarrative: z.string().optional().nullable(),
	/** Market-rate evidence: comparable rentals supporting the rent. */
	marketRateEvidence: z.string().min(1),
	/** Property manager name if one is in place (paired with a
	 *  Professional Engagement Resolution). */
	propertyManagerName: z.string().optional().nullable(),
	/** Lease document reference (e.g., "Form lease dated YYYY-MM-DD
	 *  signed by both parties; filed in trust documentation"). */
	leaseDocumentReference: z.string().min(1),
});

type LeaseVariables = z.infer<typeof VARIABLES_SCHEMA>;

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

const LEASE_TYPE_LABEL: Record<LeaseVariables['leaseType'], string> = {
	residential: 'Residential',
	commercial: 'Commercial',
	land_only: 'Ground lease (land only)',
	mixed_use: 'Mixed-use',
	short_term_vacation: 'Short-term / vacation rental',
};

const UTILITIES_LABEL: Record<LeaseVariables['utilitiesArrangement'], string> = {
	tenant_pays_all: 'Tenant pays all utilities',
	landlord_pays_all: 'Landlord (Trust) pays all utilities',
	split: 'Split between tenant and landlord (see narrative)',
	tenant_pays_with_exceptions: 'Tenant pays with exceptions (see narrative)',
};

const RELATED_PARTY_LABEL: Record<LeaseVariables['tenantIsRelatedParty'], string> = {
	no: 'Arm\'s-length unrelated tenant',
	yes_beneficiary: 'Beneficiary of the Trust',
	yes_trustee: 'Trustee of the Trust',
	yes_family: 'Family member of a trustee or beneficiary',
};

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function leaseResolutionPdf(args: RenderArgs<LeaseVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const stateClause = trust.governingState
		? ` This Resolution is executed under the laws of ${trust.governingState}.`
		: '';
	const isRelated = v.tenantIsRelatedParty !== 'no';
	const isBeneficiary = v.tenantIsRelatedParty === 'yes_beneficiary';
	const annualRent = v.monthlyRentCents * 12;

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>LEASE RESOLUTION</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · {v.propertyAddress} · {formatDate(v.termStart)} – {v.isMonthToMonth === 'yes' ? 'Month-to-Month' : formatDate(v.termEnd)}
				</Text>
				<View style={styles.hr} />

				<Text style={styles.intro}>
					The undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
					{trust.ein ? ` (EIN ${trust.ein})` : ''}, exercising the powers granted under Uniform Trust Code §816(8)–(9) and consistent with the prudent-investor rule, hereby resolves to enter into the lease of trust-owned real property described below as landlord.{stateClause}
				</Text>

				<Text style={styles.sectionHeader}>1. Leased property</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Address</Text>
						<Text style={styles.keyValueValue}>{v.propertyAddress}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Description</Text>
						<Text style={styles.keyValueValue}>{v.propertyDescription}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Lease type</Text>
						<Text style={styles.keyValueValue}>{LEASE_TYPE_LABEL[v.leaseType]}</Text>
					</View>
				</View>

				<Text style={styles.sectionHeader}>2. Tenant</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Tenant name</Text>
						<Text style={styles.keyValueValue}>{v.tenantName}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Relationship</Text>
						<Text style={styles.keyValueValue}>{RELATED_PARTY_LABEL[v.tenantIsRelatedParty]}</Text>
					</View>
				</View>

				<Text style={styles.sectionHeader}>3. Term and rent</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Term start</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.termStart)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Term end</Text>
						<Text style={styles.keyValueValue}>{v.isMonthToMonth === 'yes' ? `Month-to-month (review date ${formatDate(v.termEnd)})` : formatDate(v.termEnd)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Monthly rent</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.monthlyRentCents)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Annualized rent</Text>
						<Text style={styles.keyValueValue}>{formatMoney(annualRent)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Security deposit</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.securityDepositCents)}</Text>
					</View>
					{v.lateFeePolicy && (
						<View style={styles.keyValueRow}>
							<Text style={styles.keyValueKey}>Late fee policy</Text>
							<Text style={styles.keyValueValue}>{v.lateFeePolicy}</Text>
						</View>
					)}
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Utilities</Text>
						<Text style={styles.keyValueValue}>{UTILITIES_LABEL[v.utilitiesArrangement]}</Text>
					</View>
				</View>
				{v.utilitiesNarrative && (
					<Text style={styles.body}>{v.utilitiesNarrative}</Text>
				)}

				<Text style={styles.sectionHeader}>4. Market-rate evidence</Text>
				<Text style={styles.body}>{v.marketRateEvidence}</Text>

				{isBeneficiary && (
					<View style={styles.warningBlock}>
						<Text style={styles.warningText}>
							<Text style={styles.emph}>Beneficiary tenant — below-market rent risk:</Text> If the rent set in this lease is below the market rate established above, the differential may be characterized as a constructive distribution to the beneficiary tenant under §651/§661 of the Internal Revenue Code and may need to be reported on the beneficiary&rsquo;s K-1. The Trustee has set rent at market OR has documented the differential and the corresponding partial-distribution treatment in a paired Distribution Authorization.
						</Text>
					</View>
				)}

				{isRelated && !isBeneficiary && (
					<View style={styles.warningBlock}>
						<Text style={styles.warningText}>
							<Text style={styles.emph}>Related-party tenant:</Text> The tenant is a related party. A separate Conflict of Interest Waiver under UTC §802(b)–(c) memorializes the fairness determination, the market-rate evidence above, and the Trustee&rsquo;s determination that this lease is in the Trust&rsquo;s best interests. The Waiver must accompany this Resolution.
						</Text>
					</View>
				)}

				{v.propertyManagerName && (
					<>
						<Text style={styles.sectionHeader}>5. Property manager</Text>
						<Text style={styles.body}>
							The property is managed by <Text style={styles.emph}>{v.propertyManagerName}</Text> under a separate Professional Engagement Resolution (UTC §806–807) on file with the trust documentation. The Trustee retains the duty to monitor the manager&rsquo;s performance.
						</Text>
					</>
				)}

				<Text style={styles.sectionHeader}>{v.propertyManagerName ? '6' : '5'}. Lease document &amp; allocation</Text>
				<Text style={styles.body}>{v.leaseDocumentReference}</Text>
				<Text style={styles.body}>
					Rent collected under this lease is allocated to <Text style={styles.emph}>trust income</Text> under UPIA §403. Tenant security deposits are held in a separate Trust account, are not income, and are returnable at lease end net of permitted offsets.
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
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template lease-resolution v1
				</Text>
			</Page>
		</Document>
	);
}

export const leaseResolutionTemplate: TemplateDefinition<LeaseVariables> = {
	id: 'lease-resolution',
	version: '1',
	label: 'Lease Resolution',
	description:
		'Authorizes the Trust to enter a lease as landlord of trust-owned property. Captures property, tenant, term, rent (with annualization), security deposit, utilities, market-rate evidence, related-party screening, and rent-to-income allocation under UPIA §403.',
	category: 'operating',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: leaseResolutionPdf,
	formFields: [
		{ name: 'propertyAddress', label: 'Property address', widget: 'text', span: 2 },
		{
			name: 'propertyDescription',
			label: 'Property description',
			widget: 'text',
			placeholder: 'e.g., "3BR/2BA single-family home" or "1,200 sf office suite #4B"',
			span: 2,
		},
		{
			name: 'leaseType',
			label: 'Lease type',
			widget: 'select',
			options: [
				{ value: 'residential', label: 'Residential' },
				{ value: 'commercial', label: 'Commercial' },
				{ value: 'land_only', label: 'Ground lease (land only)' },
				{ value: 'mixed_use', label: 'Mixed-use' },
				{ value: 'short_term_vacation', label: 'Short-term / vacation rental' },
			],
		},
		{ name: 'tenantName', label: 'Tenant name', widget: 'text' },
		{
			name: 'tenantIsRelatedParty',
			label: 'Tenant relationship',
			widget: 'select',
			span: 2,
			options: [
				{ value: 'no', label: 'Arm\'s-length unrelated' },
				{ value: 'yes_beneficiary', label: 'Beneficiary' },
				{ value: 'yes_trustee', label: 'Trustee' },
				{ value: 'yes_family', label: 'Family of trustee or beneficiary' },
			],
		},
		{ name: 'termStart', label: 'Term start', widget: 'date' },
		{ name: 'termEnd', label: 'Term end (or first review date)', widget: 'date' },
		{
			name: 'isMonthToMonth',
			label: 'Month-to-month?',
			widget: 'select',
			options: [
				{ value: 'no', label: 'No — fixed term' },
				{ value: 'yes', label: 'Yes — MTM (use term end as review date)' },
			],
		},
		{ name: 'monthlyRentCents', label: 'Monthly rent ($)', widget: 'dollars', cents: true },
		{ name: 'securityDepositCents', label: 'Security deposit ($)', widget: 'dollars', cents: true },
		{ name: 'lateFeePolicy', label: 'Late fee policy (optional)', widget: 'text', required: false, span: 2, placeholder: 'e.g., "$50 if rent is more than 5 days late"' },
		{
			name: 'utilitiesArrangement',
			label: 'Utilities',
			widget: 'select',
			span: 2,
			options: [
				{ value: 'tenant_pays_all', label: 'Tenant pays all' },
				{ value: 'landlord_pays_all', label: 'Landlord (Trust) pays all' },
				{ value: 'split', label: 'Split (see narrative)' },
				{ value: 'tenant_pays_with_exceptions', label: 'Tenant pays with exceptions' },
			],
		},
		{
			name: 'utilitiesNarrative',
			label: 'Utilities narrative',
			widget: 'textarea',
			rows: 2,
			required: false,
			placeholder: 'Describe split / exceptions.',
			span: 2,
			visibleWhen: { field: 'utilitiesArrangement', in: ['split', 'tenant_pays_with_exceptions'] },
		},
		{
			name: 'marketRateEvidence',
			label: 'Market-rate evidence',
			widget: 'textarea',
			rows: 3,
			placeholder: 'Comparable rentals supporting the rent — e.g., "Three comparable 3BR/2BA homes within 1 mile renting for $2,250–$2,400/mo per Zillow/Redfin pulled YYYY-MM-DD; subject is priced at midpoint."',
			span: 2,
		},
		{
			name: 'propertyManagerName',
			label: 'Property manager name (optional)',
			widget: 'text',
			required: false,
			span: 2,
		},
		{
			name: 'leaseDocumentReference',
			label: 'Lease document reference',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "Standard residential lease (Texas Apartment Association form) dated YYYY-MM-DD, signed by both parties, archived in trust documentation."',
			span: 2,
		},
	],
};
