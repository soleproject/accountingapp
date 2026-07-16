import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Real Estate Sale Resolution.
 *
 * The exit-side counterpart to real-estate-purchase. The trustee
 * must answer (and the document must capture):
 *   - Why selling is consistent with the IPS and the trust's purposes
 *   - Whether the buyer is a related party (paired with Conflict
 *     Waiver if so)
 *   - The §1001 gain calculation: amount realized − adjusted basis
 *   - Allocation: under UPIA §404 capital gain is corpus, not income,
 *     so absent a §643(b) election the gain stays with the trust at
 *     trust-level rates
 *   - §1250 unrecaptured-gain exposure (25% rate)
 *   - §121 exclusion exposure for residential property — does NOT
 *     apply to a non-grantor irrevocable trust (the exclusion is
 *     personal to a natural-person taxpayer); important to memorialize
 *     that the trustee considered and rejected the exclusion
 *   - Holding period (long-term vs short-term)
 *   - Plan for the net proceeds (where they go inside the trust)
 */

const VARIABLES_SCHEMA = z.object({
	/** Common street address of the property. */
	propertyAddress: z.string().min(1),
	/** Legal description. */
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
	/** Sale price (gross consideration). */
	salePriceCents: z.number().int().nonnegative(),
	/** Selling expenses (commission, closing costs, repairs paid by
	 *  trust). */
	sellingExpensesCents: z.number().int().nonnegative(),
	/** Adjusted basis at time of sale (acquisition cost + capital
	 *  improvements − accumulated depreciation). */
	adjustedBasisCents: z.number().int().nonnegative(),
	/** Accumulated depreciation taken on the property (drives §1250
	 *  unrecaptured-gain calculation for real property). */
	accumulatedDepreciationCents: z.number().int().nonnegative(),
	/** Closing / sale date. */
	closingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Date the trust acquired the property — drives holding period. */
	acquisitionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Buyer name. */
	buyerName: z.string().min(1),
	/** Related-party flag — pair with Conflict Waiver if yes. */
	buyerIsRelatedParty: z.enum(['yes', 'no']),
	/** Reason for the sale. */
	saleRationale: z.string().min(1),
	/** Disposition plan for the net proceeds. */
	proceedsDisposition: z.string().min(1),
	/** Title transfer instructions. */
	titleTransferInstructions: z.string().min(1),
	/** §121 exclusion consideration (residential only) — the trustee's
	 *  determination that the personal-residence exclusion does NOT
	 *  apply because the trust is not a natural-person taxpayer
	 *  (or, in a grantor-trust scenario, the affirmative analysis
	 *  that supports claiming it). */
	section121Analysis: z.string().optional().nullable(),
});

type SaleVariables = z.infer<typeof VARIABLES_SCHEMA>;

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
		width: 175,
		fontFamily: 'Helvetica-Bold',
		fontSize: 9,
		color: '#475569',
		textTransform: 'uppercase',
		letterSpacing: 0.4,
	},
	keyValueValue: { flex: 1, fontSize: 10, color: '#0f172a' },
	totalRow: {
		marginTop: 4,
		paddingTop: 4,
		borderTopWidth: 0.5,
		borderTopColor: '#475569',
	},
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

const PROPERTY_TYPE_LABEL: Record<SaleVariables['propertyType'], string> = {
	single_family_residential: 'Single-family residential',
	multifamily_residential: 'Multifamily residential',
	commercial: 'Commercial',
	land: 'Vacant land',
	mixed_use: 'Mixed-use',
	industrial: 'Industrial',
	other: 'Other',
};

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function daysBetween(start: string, end: string): number {
	const [y1, m1, d1] = start.split('-').map(Number);
	const [y2, m2, d2] = end.split('-').map(Number);
	const a = Date.UTC(y1, m1 - 1, d1);
	const b = Date.UTC(y2, m2 - 1, d2);
	return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

function realEstateSalePdf(args: RenderArgs<SaleVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const stateClause = trust.governingState
		? ` This Resolution is executed under the laws of ${trust.governingState}.`
		: '';

	const amountRealized = v.salePriceCents - v.sellingExpensesCents;
	const totalGainCents = amountRealized - v.adjustedBasisCents;
	const unrecapturedSection1250Cents = Math.min(Math.max(totalGainCents, 0), v.accumulatedDepreciationCents);
	const remainingLongTermGainCents = Math.max(totalGainCents - unrecapturedSection1250Cents, 0);
	const isGain = totalGainCents > 0;
	const isLoss = totalGainCents < 0;
	const holdDays = daysBetween(v.acquisitionDate, v.closingDate);
	const longTerm = holdDays >= 366;
	const isResidential = v.propertyType === 'single_family_residential' || v.propertyType === 'multifamily_residential' || v.propertyType === 'mixed_use';
	const relatedParty = v.buyerIsRelatedParty === 'yes';

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>REAL ESTATE SALE RESOLUTION</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · {formatDate(v.closingDate)}
				</Text>
				<View style={styles.hr} />

				<Text style={styles.intro}>
					The undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
					{trust.effectiveDate ? `, established ${formatDate(trust.effectiveDate)}` : ''}
					{trust.ein ? `, EIN ${trust.ein}` : ''}, having determined this disposition to be in the best interests of the beneficiaries and consistent with the prudent-investor rule, hereby resolves to sell the real property described below and to record the §1001 gain or loss calculation set forth herein.{stateClause}
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
						<Text style={styles.keyValueKey}>Acquisition date</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.acquisitionDate)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Closing / sale date</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.closingDate)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Holding period</Text>
						<Text style={styles.keyValueValue}>{holdDays} days — {longTerm ? 'long-term' : 'short-term'}</Text>
					</View>
				</View>
				<Text style={styles.body}><Text style={styles.emph}>Legal description: </Text>{v.legalDescription}</Text>

				<Text style={styles.sectionHeader}>2. Buyer</Text>
				<Text style={styles.body}>{v.buyerName}{relatedParty ? ' (related party)' : ''}</Text>

				<Text style={styles.sectionHeader}>3. §1001 gain calculation</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Sale price</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.salePriceCents)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Less selling expenses</Text>
						<Text style={styles.keyValueValue}>({formatMoney(v.sellingExpensesCents)})</Text>
					</View>
					<View style={[styles.keyValueRow, styles.totalRow]}>
						<Text style={styles.keyValueKey}>Amount realized</Text>
						<Text style={styles.keyValueValue}>{formatMoney(amountRealized)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Less adjusted basis</Text>
						<Text style={styles.keyValueValue}>({formatMoney(v.adjustedBasisCents)})</Text>
					</View>
					<View style={[styles.keyValueRow, styles.totalRow]}>
						<Text style={styles.keyValueKey}>Gain / (loss)</Text>
						<Text style={styles.keyValueValue}>{isLoss ? `(${formatMoney(Math.abs(totalGainCents))})` : formatMoney(totalGainCents)}</Text>
					</View>
				</View>

				{isGain && v.accumulatedDepreciationCents > 0 && (
					<>
						<Text style={styles.sectionHeader}>4. §1250 unrecaptured-gain split</Text>
						<View style={styles.keyValueBlock}>
							<View style={styles.keyValueRow}>
								<Text style={styles.keyValueKey}>Accumulated depreciation</Text>
								<Text style={styles.keyValueValue}>{formatMoney(v.accumulatedDepreciationCents)}</Text>
							</View>
							<View style={styles.keyValueRow}>
								<Text style={styles.keyValueKey}>Unrecaptured §1250 gain (max 25%)</Text>
								<Text style={styles.keyValueValue}>{formatMoney(unrecapturedSection1250Cents)}</Text>
							</View>
							<View style={styles.keyValueRow}>
								<Text style={styles.keyValueKey}>Remaining long-term gain (15/20% + NIIT)</Text>
								<Text style={styles.keyValueValue}>{formatMoney(remainingLongTermGainCents)}</Text>
							</View>
						</View>
					</>
				)}

				<Text style={styles.sectionHeader}>{isGain && v.accumulatedDepreciationCents > 0 ? '5' : '4'}. Sale rationale</Text>
				<Text style={styles.body}>{v.saleRationale}</Text>

				<Text style={styles.sectionHeader}>{isGain && v.accumulatedDepreciationCents > 0 ? '6' : '5'}. Allocation &amp; proceeds disposition</Text>
				<Text style={styles.body}>
					Capital gain on the sale of trust corpus is allocated to <Text style={styles.emph}>corpus</Text> under UPIA §404 and remains taxable at the trust level absent a separate §643(b) regulatory election. The net proceeds shall be applied as follows:
				</Text>
				<Text style={styles.body}>{v.proceedsDisposition}</Text>

				<Text style={styles.sectionHeader}>{isGain && v.accumulatedDepreciationCents > 0 ? '7' : '6'}. Title transfer</Text>
				<Text style={styles.body}>{v.titleTransferInstructions}</Text>

				{isResidential && (
					<>
						<Text style={styles.sectionHeader}>{isGain && v.accumulatedDepreciationCents > 0 ? '8' : '7'}. §121 personal-residence exclusion analysis</Text>
						<Text style={styles.body}>
							{v.section121Analysis ??
								'The §121 exclusion of gain on the sale of a principal residence is personal to a natural-person taxpayer who has owned AND used the property as a principal residence for 2 of the 5 years preceding sale. As an irrevocable non-grantor trust, the Trust is not eligible for §121. The exclusion does not apply to this transaction.'}
						</Text>
					</>
				)}

				{relatedParty && (
					<View style={styles.warningBlock}>
						<Text style={styles.warningText}>
							<Text style={styles.emph}>Related-party transaction:</Text> The buyer is a related party. A separate Conflict of Interest Waiver under UTC §802(b)–(c) memorializes the fairness determination and supporting evidence and must accompany this Resolution. Note that §267 may also disallow recognition of any loss on a sale to a related party.
						</Text>
					</View>
				)}

				{isLoss && relatedParty && (
					<View style={styles.warningBlock}>
						<Text style={styles.warningText}>
							<Text style={styles.emph}>§267 loss-disallowance warning:</Text> Under IRC §267(a)(1), losses on sales between a fiduciary of a trust and a related party (including a beneficiary of the trust) are not deductible. The Trustee acknowledges this disallowance and has determined the transaction is still in the beneficiaries&rsquo; interest on non-tax grounds.
						</Text>
					</View>
				)}

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
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template real-estate-sale v1
				</Text>
			</Page>
		</Document>
	);
}

export const realEstateSaleTemplate: TemplateDefinition<SaleVariables> = {
	id: 'real-estate-sale',
	version: '1',
	label: 'Real Estate Sale Resolution',
	description:
		'Authorizes the Trust to sell real property. Captures sale price, basis, §1001 gain, §1250 unrecaptured-gain split, holding period, §121 ineligibility recital (for non-grantor trusts), related-party screening, and proceeds disposition.',
	category: 'operating',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: realEstateSalePdf,
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
		{ name: 'acquisitionDate', label: 'Acquisition date (basis date)', widget: 'date' },
		{ name: 'closingDate', label: 'Closing / sale date', widget: 'date' },
		{ name: 'salePriceCents', label: 'Sale price ($)', widget: 'dollars', cents: true },
		{ name: 'sellingExpensesCents', label: 'Selling expenses ($)', widget: 'dollars', cents: true, placeholder: 'Commission + closing costs + repairs' },
		{ name: 'adjustedBasisCents', label: 'Adjusted basis ($)', widget: 'dollars', cents: true, placeholder: 'Acquisition + improvements − depreciation' },
		{ name: 'accumulatedDepreciationCents', label: 'Accumulated depreciation ($)', widget: 'dollars', cents: true, placeholder: 'For §1250 split' },
		{ name: 'buyerName', label: 'Buyer name', widget: 'text', span: 2 },
		{
			name: 'buyerIsRelatedParty',
			label: 'Is the buyer a related party?',
			widget: 'select',
			options: [
				{ value: 'no', label: 'No' },
				{ value: 'yes', label: 'Yes — pair with Conflict of Interest Waiver' },
			],
			span: 2,
		},
		{
			name: 'saleRationale',
			label: 'Sale rationale',
			widget: 'textarea',
			rows: 3,
			placeholder: 'Why selling now — IPS fit, market conditions, distribution needs, asset rebalancing, etc.',
			span: 2,
		},
		{
			name: 'proceedsDisposition',
			label: 'Disposition of net proceeds',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "Wire to Trust operating account at ABC Bank; held as cash pending reinvestment per IPS"',
			span: 2,
		},
		{
			name: 'titleTransferInstructions',
			label: 'Title transfer instructions',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "Execute special warranty deed; recorded by escrow agent; trust certificate to accompany"',
			span: 2,
		},
		{
			name: 'section121Analysis',
			label: '§121 exclusion analysis (residential only)',
			widget: 'textarea',
			rows: 3,
			required: false,
			placeholder: 'Default: §121 does not apply to a non-grantor irrevocable trust. Override only with affirmative analysis for grantor-trust scenarios.',
			span: 2,
			visibleWhen: { field: 'propertyType', in: ['single_family_residential', 'multifamily_residential', 'mixed_use'] },
		},
	],
};
