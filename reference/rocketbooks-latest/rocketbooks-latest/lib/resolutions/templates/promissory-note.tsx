import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Promissory Note Package — formalizes a loan the Trust extends to a
 * beneficiary, trustee, or third party. The matching audit-defense
 * document for the existing TRUST_DEMAND_NOTE_MISSING_NOTE warning.
 *
 * Spendthrift trusts CANNOT have advances to beneficiaries
 * recharacterized as distributions without proper documentation;
 * below-AFR loans create IRC §7872 imputed-income / imputed-
 * distribution exposure. This template captures the minimum the IRS
 * + state common law require: principal, rate at-or-above AFR,
 * payment schedule, maturity, collateral (if any), default remedies,
 * and (when the borrower is related to the trustee) a conflict
 * acknowledgment.
 *
 * Signed by Trustee + Borrower. Notarization is recommended for
 * notes secured by real estate or above a state-specific threshold.
 */

const VARIABLES_SCHEMA = z.object({
	borrowerName: z.string().min(1),
	borrowerRelationship: z.enum(['trustee', 'beneficiary', 'related_party', 'third_party']),
	borrowerAddress: z.string().optional().nullable(),
	principalCents: z.number().int().positive(),
	/** Annual rate, percent. e.g. 5.0 for 5%. Must be at or above the
	 *  applicable AFR for the loan term. */
	annualRatePercent: z.number().nonnegative(),
	/** Whether the rate at-least-equals the AFR. Trustee attests; the
	 *  IRS will reclassify below-AFR loans as part-gift / part-loan
	 *  under §7872. */
	afrConfirmed: z.enum(['yes', 'no_below_afr', 'na']),
	noteDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	maturityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
	paymentSchedule: z.enum(['monthly', 'quarterly', 'semi_annual', 'annual', 'demand', 'balloon']),
	/** Free-text description of the collateral, if any (real-estate
	 *  legal description, vehicle VIN, etc.). */
	collateral: z.string().optional().nullable(),
	/** Spendthrift-clause carve-out analysis. Required when borrower
	 *  is a beneficiary — without this, the loan exposes the trust to
	 *  challenges that it impaired the spendthrift protection. */
	spendthriftAnalysis: z.string().optional().nullable(),
	/** Source account for the cash advance (typically the bank
	 *  account funding the loan). */
	sourceAccountLabel: z.string().optional().nullable(),
	/** Underlying purpose of the loan (working capital, real-estate
	 *  acquisition, debt consolidation, etc.). */
	purpose: z.string().min(1),
});

type PromissoryVariables = z.infer<typeof VARIABLES_SCHEMA>;

const styles = StyleSheet.create({
	page: {
		paddingTop: 64,
		paddingBottom: 64,
		paddingHorizontal: 64,
		fontFamily: 'Helvetica',
		fontSize: 11,
		lineHeight: 1.5,
		color: '#1f2937',
	},
	title: {
		fontFamily: 'Helvetica-Bold',
		fontSize: 18,
		textAlign: 'center',
		marginBottom: 4,
		color: '#0f172a',
		letterSpacing: 1,
	},
	subtitle: {
		fontSize: 10,
		textAlign: 'center',
		color: '#64748b',
		marginBottom: 24,
	},
	hr: {
		borderBottomWidth: 1,
		borderBottomColor: '#0f172a',
		marginBottom: 24,
	},
	recitalBlock: { marginBottom: 14 },
	paragraph: { marginBottom: 12, textAlign: 'justify' },
	emph: { fontFamily: 'Helvetica-Bold' },
	keyValueBlock: {
		marginVertical: 14,
		paddingVertical: 10,
		paddingHorizontal: 14,
		backgroundColor: '#f1f5f9',
		borderRadius: 4,
	},
	keyValueRow: { flexDirection: 'row', marginBottom: 4 },
	keyValueKey: {
		width: 150,
		fontFamily: 'Helvetica-Bold',
		fontSize: 9.5,
		color: '#475569',
		textTransform: 'uppercase',
		letterSpacing: 0.5,
	},
	keyValueValue: { flex: 1, fontSize: 11, color: '#0f172a' },
	warningBlock: {
		marginVertical: 14,
		padding: 10,
		backgroundColor: '#fef3c7',
		borderRadius: 4,
		borderLeftWidth: 3,
		borderLeftColor: '#d97706',
	},
	warningText: { fontSize: 10.5, color: '#92400e' },
	signaturesHeader: {
		marginTop: 36,
		marginBottom: 6,
		fontSize: 10,
		letterSpacing: 1.5,
		color: '#0f172a',
		fontFamily: 'Helvetica-Bold',
	},
	sigRow: { flexDirection: 'row', gap: 28, marginTop: 12 },
	sigBlock: { flex: 1 },
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
		left: 64,
		right: 64,
		fontSize: 8,
		color: '#94a3b8',
		textAlign: 'center',
		borderTopWidth: 0.5,
		borderTopColor: '#cbd5e1',
		paddingTop: 6,
	},
});

const RELATIONSHIP_LABEL: Record<PromissoryVariables['borrowerRelationship'], string> = {
	trustee: 'Trustee (related party)',
	beneficiary: 'Beneficiary',
	related_party: 'Related party (not trustee/beneficiary)',
	third_party: 'Third party (unrelated)',
};

const SCHEDULE_LABEL: Record<PromissoryVariables['paymentSchedule'], string> = {
	monthly: 'Monthly',
	quarterly: 'Quarterly',
	semi_annual: 'Semi-annual',
	annual: 'Annual',
	demand: 'On demand',
	balloon: 'Single balloon payment at maturity',
};

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function promissoryNotePdf(args: RenderArgs<PromissoryVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const borrower = args.signers.find((s) => s.role.toLowerCase().includes('borrower'));
	const stateClause = trust.governingState
		? ` This Note shall be governed by the laws of ${trust.governingState}.`
		: '';
	const isRelatedParty = v.borrowerRelationship !== 'third_party';
	const isBeneficiary = v.borrowerRelationship === 'beneficiary';

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>PROMISSORY NOTE</Text>
				<Text style={styles.subtitle}>
					{trustLabel} as Lender · {v.borrowerName} as Borrower · {formatDate(v.noteDate)}
				</Text>
				<View style={styles.hr} />

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						FOR VALUE RECEIVED, the undersigned <Text style={styles.emph}>{v.borrowerName}</Text>
						{v.borrowerAddress ? `, of ${v.borrowerAddress}` : ''} (&ldquo;Borrower&rdquo;), promises to pay to the order of
						<Text style={styles.emph}> {trustLabel}</Text>
						{trust.effectiveDate ? `, established ${formatDate(trust.effectiveDate)}` : ''}
						{trust.ein ? ` (EIN ${trust.ein})` : ''}, acting by and through its Trustee (&ldquo;Lender&rdquo;), the principal sum and interest described below, on the terms set forth herein.
					</Text>
				</View>

				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Principal</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.principalCents)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Interest rate</Text>
						<Text style={styles.keyValueValue}>{v.annualRatePercent.toFixed(4)}% per annum, simple</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>AFR confirmation</Text>
						<Text style={styles.keyValueValue}>
							{v.afrConfirmed === 'yes' ? 'Rate equals or exceeds the applicable AFR'
								: v.afrConfirmed === 'no_below_afr' ? 'Rate is BELOW the AFR (§7872 imputation may apply — see Note below)'
								: 'AFR not applicable to this loan'}
						</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Note date</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.noteDate)}</Text>
					</View>
					{v.maturityDate && (
						<View style={styles.keyValueRow}>
							<Text style={styles.keyValueKey}>Maturity</Text>
							<Text style={styles.keyValueValue}>{formatDate(v.maturityDate)}</Text>
						</View>
					)}
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Payment schedule</Text>
						<Text style={styles.keyValueValue}>{SCHEDULE_LABEL[v.paymentSchedule]}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Borrower relationship</Text>
						<Text style={styles.keyValueValue}>{RELATIONSHIP_LABEL[v.borrowerRelationship]}</Text>
					</View>
					{v.purpose && (
						<View style={styles.keyValueRow}>
							<Text style={styles.keyValueKey}>Purpose</Text>
							<Text style={styles.keyValueValue}>{v.purpose}</Text>
						</View>
					)}
				</View>

				{v.afrConfirmed === 'no_below_afr' && (
					<View style={styles.warningBlock}>
						<Text style={styles.warningText}>
							<Text style={styles.emph}>Warning — below-AFR exposure.</Text> Under IRC §7872, a loan
							at a rate below the applicable federal rate is recharacterized in part as a transfer
							of the foregone interest. For a related-party borrower, that foregone interest may
							be treated as a distribution (taxable to the Trust or beneficiary depending on
							character) and may impair the spendthrift protection. Confirm with tax counsel
							before relying on this Note.
						</Text>
					</View>
				)}

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>1. Payment.</Text> Borrower shall pay {SCHEDULE_LABEL[v.paymentSchedule].toLowerCase()} installments of principal and interest as specified above, with the entire unpaid balance due on {v.maturityDate ? `the maturity date of ${formatDate(v.maturityDate)}` : 'demand by Lender'}. Payments shall be applied first to accrued interest, then to outstanding principal.
					</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>2. Prepayment.</Text> Borrower may prepay all or any portion of the principal at any time without penalty.
					</Text>
				</View>

				{v.collateral && (
					<View style={styles.recitalBlock}>
						<Text style={styles.paragraph}>
							<Text style={styles.emph}>3. Security.</Text> This Note is secured by the following collateral: {v.collateral}. Lender&rsquo;s rights in the collateral are governed by a separate security agreement of even date herewith and applicable law.
						</Text>
					</View>
				)}

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>{v.collateral ? '4' : '3'}. Default.</Text> Each of the following constitutes an Event of Default: (a) failure to pay any amount when due, continuing for ten days; (b) any material misrepresentation by Borrower in connection with this Note; (c) Borrower&rsquo;s bankruptcy or assignment for the benefit of creditors. Upon an Event of Default, Lender may declare the entire unpaid balance immediately due and payable, exercise rights against any collateral, and pursue all other remedies available at law or in equity.
					</Text>
				</View>

				{isBeneficiary && v.spendthriftAnalysis && (
					<View style={styles.recitalBlock}>
						<Text style={styles.paragraph}>
							<Text style={styles.emph}>{v.collateral ? '5' : '4'}. Spendthrift carve-out.</Text> The Trust contains spendthrift provisions protecting the Borrower&rsquo;s beneficial interest from creditor attachment. {v.spendthriftAnalysis} This Note is structured to preserve the spendthrift protection while creating a bona fide debt that prevents recharacterization of the advance as a non-taxable distribution.
						</Text>
					</View>
				)}

				{isRelatedParty && (
					<View style={styles.recitalBlock}>
						<Text style={styles.paragraph}>
							<Text style={styles.emph}>{v.collateral ? (isBeneficiary && v.spendthriftAnalysis ? '6' : '5') : (isBeneficiary && v.spendthriftAnalysis ? '5' : '4')}. Related-party acknowledgment.</Text> The parties acknowledge that the Borrower is related to the Trustee or is a beneficiary of the Trust. The Trustee has determined that the terms of this Note are fair and reasonable to the Trust under UTC §802(b)–(c) and that the rate at-least-equals the applicable AFR. A separate Conflict of Interest Waiver memorializing the analysis is filed with this Note.{stateClause}
						</Text>
					</View>
				)}

				<Text style={styles.signaturesHeader}>SIGNATURES</Text>

				<View style={styles.sigRow}>
					<View style={styles.sigBlock}>
						<View style={styles.sigLineRule} />
						<Text style={styles.sigName}>{borrower?.signedName ?? borrower?.expectedName ?? v.borrowerName}</Text>
						<Text style={styles.sigLabel}>Borrower</Text>
						{borrower?.signedAt && (
							<Text style={styles.sigMeta}>
								Signed {borrower.signedAt}{borrower.signedIp ? ` · IP ${borrower.signedIp}` : ''}
							</Text>
						)}
					</View>
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
				</View>

				<Text style={styles.footer}>
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template promissory-note v1
				</Text>
			</Page>
		</Document>
	);
}

export const promissoryNoteTemplate: TemplateDefinition<PromissoryVariables> = {
	id: 'promissory-note',
	version: '1',
	label: 'Promissory Note (Trust as Lender)',
	description:
		'Formal note for any loan the trust extends. Backs the TRUST_DEMAND_NOTE_MISSING_NOTE warning; without it, advances to beneficiaries can be recharacterized as distributions under §7872.',
	category: 'operating',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [
		{ role: 'Borrower' },
		{ role: 'Trustee' },
	],
	requiresState: true,
	renderPdf: promissoryNotePdf,
	formFields: [
		{ name: 'borrowerName', label: 'Borrower name', widget: 'text' },
		{
			name: 'borrowerRelationship',
			label: 'Borrower relationship',
			widget: 'select',
			options: [
				{ value: 'beneficiary', label: 'Beneficiary' },
				{ value: 'trustee', label: 'Trustee (related party)' },
				{ value: 'related_party', label: 'Related party (not trustee/beneficiary)' },
				{ value: 'third_party', label: 'Third party (unrelated)' },
			],
		},
		{ name: 'borrowerAddress', label: 'Borrower address', widget: 'text', required: false, span: 2 },
		{ name: 'principalCents', label: 'Principal ($)', widget: 'dollars', cents: true },
		{ name: 'annualRatePercent', label: 'Interest rate (% per annum)', widget: 'integer', placeholder: 'e.g., 5.5' },
		{
			name: 'afrConfirmed',
			label: 'AFR confirmation',
			widget: 'select',
			options: [
				{ value: 'yes', label: 'Yes — rate equals or exceeds the AFR' },
				{ value: 'no_below_afr', label: 'No — below AFR (will surface §7872 warning)' },
				{ value: 'na', label: 'Not applicable to this loan' },
			],
		},
		{ name: 'noteDate', label: 'Note date', widget: 'date' },
		{ name: 'maturityDate', label: 'Maturity date', widget: 'date', required: false },
		{
			name: 'paymentSchedule',
			label: 'Payment schedule',
			widget: 'select',
			options: [
				{ value: 'monthly', label: 'Monthly' },
				{ value: 'quarterly', label: 'Quarterly' },
				{ value: 'semi_annual', label: 'Semi-annual' },
				{ value: 'annual', label: 'Annual' },
				{ value: 'demand', label: 'On demand' },
				{ value: 'balloon', label: 'Single balloon at maturity' },
			],
		},
		{ name: 'purpose', label: 'Loan purpose', widget: 'text', span: 2, placeholder: 'e.g., working capital, real-estate acquisition, debt consolidation' },
		{ name: 'collateral', label: 'Collateral description (optional)', widget: 'textarea', rows: 2, required: false, span: 2 },
		{
			name: 'spendthriftAnalysis',
			label: 'Spendthrift carve-out analysis',
			widget: 'textarea',
			rows: 3,
			required: false,
			span: 2,
			placeholder: 'When borrower is a beneficiary: explain how this loan preserves the spendthrift protection while creating a bona fide debt.',
			visibleWhen: { field: 'borrowerRelationship', in: ['beneficiary'] },
		},
		{ name: 'sourceAccountLabel', label: 'Source account (optional)', widget: 'text', required: false, span: 2 },
	],
};
