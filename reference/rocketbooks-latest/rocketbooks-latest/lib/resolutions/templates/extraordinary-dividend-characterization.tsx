import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Per-event Extraordinary Dividend Characterization Memo.
 *
 * Backs the annual Declaration of Extraordinary Dividend with
 * per-transaction support — what specifically made THIS dividend
 * "extraordinary" under IRC §643(b)(3) such that it lands in corpus
 * rather than DNI. Without per-event support, the annual roll-up
 * is conclusory and (per IRS AM 2023-006 + recent Office of Chief
 * Counsel memos on "marketed schemes" using §643(b)) the most likely
 * audit target.
 *
 * Trigger: any 4xx credit the trustee determines is extraordinary —
 * one-time payouts, liquidation distributions, special / capital-in-
 * nature dividends, etc. Manual draft from the catalog today; future
 * iteration can fire on a per-event TRUST_INCOME_NEEDS_CHARACTERIZATION
 * finding when one is added.
 */

const VARIABLES_SCHEMA = z.object({
	/** Free-text description of the receipt that's being characterized
	 *  (e.g., "Special dividend from XYZ Holdings", "Liquidation
	 *  distribution from ABC LLC partnership wind-down"). */
	receiptDescription: z.string().min(1),
	/** Source — payer / issuer. */
	payer: z.string().min(1),
	/** Income account the credit was posted to (e.g., "410 Dividend
	 *  Income"). */
	sourceAccountLabel: z.string().optional().nullable(),
	/** Amount of the characterized dividend, in cents. */
	amountCents: z.number().int().positive(),
	/** Receipt date. */
	receiptDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Tax year the dividend falls into. */
	taxYear: z.number().int().min(1900).max(3000),
	/** Why is it extraordinary? Categorical hint — drives recital
	 *  language. */
	extraordinaryReason: z.enum([
		'liquidation',          // partial / full liquidation distribution
		'one_time_special',     // declared special dividend
		'return_of_capital',    // return-of-investment distribution
		'merger_or_spinoff',    // M&A / spinoff distribution
		'large_relative',       // unusually large vs. the issuer's history
		'other',
	]),
	/** Trustee's narrative supporting the characterization. Required
	 *  — the judgment-call field that makes the memo defensible. */
	characterizationRationale: z.string().min(1),
	/** Issuer's own declaration / 1099 box / press release that
	 *  supports characterization, if available. */
	supportingEvidence: z.string().optional().nullable(),
});

type CharacterizationVariables = z.infer<typeof VARIABLES_SCHEMA>;

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
		marginBottom: 24,
	},
	hr: {
		borderBottomWidth: 1,
		borderBottomColor: '#0f172a',
		marginBottom: 24,
	},
	recitalBlock: {
		marginBottom: 14,
	},
	paragraph: {
		marginBottom: 12,
		textAlign: 'justify',
	},
	emph: {
		fontFamily: 'Helvetica-Bold',
	},
	keyValueBlock: {
		marginVertical: 14,
		paddingVertical: 10,
		paddingHorizontal: 14,
		backgroundColor: '#f1f5f9',
		borderRadius: 4,
	},
	keyValueRow: {
		flexDirection: 'row',
		marginBottom: 4,
	},
	keyValueKey: {
		width: 150,
		fontFamily: 'Helvetica-Bold',
		fontSize: 9.5,
		color: '#475569',
		textTransform: 'uppercase',
		letterSpacing: 0.5,
	},
	keyValueValue: {
		flex: 1,
		fontSize: 11,
		color: '#0f172a',
	},
	signaturesHeader: {
		marginTop: 36,
		marginBottom: 6,
		fontSize: 10,
		letterSpacing: 1.5,
		color: '#0f172a',
		fontFamily: 'Helvetica-Bold',
	},
	sigBlock: {
		marginTop: 24,
	},
	sigLineRule: {
		borderBottomWidth: 0.75,
		borderBottomColor: '#0f172a',
		marginBottom: 4,
		marginTop: 28,
	},
	sigLabel: {
		fontSize: 9.5,
		color: '#64748b',
	},
	sigName: {
		fontSize: 10.5,
		fontFamily: 'Helvetica-Bold',
		color: '#0f172a',
		marginBottom: 2,
	},
	sigMeta: {
		fontSize: 8.5,
		color: '#64748b',
		marginTop: 2,
	},
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

const REASON_LABEL: Record<CharacterizationVariables['extraordinaryReason'], string> = {
	liquidation: 'Liquidation distribution (partial or complete)',
	one_time_special: 'One-time special dividend declared by issuer',
	return_of_capital: 'Return-of-capital distribution',
	merger_or_spinoff: 'Merger or spin-off distribution',
	large_relative: 'Unusually large relative to issuer history',
	other: 'Other (see rationale)',
};

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function extraordinaryDividendCharacterizationPdf(args: RenderArgs<CharacterizationVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const stateClause = trust.governingState
		? ` Allocation is made under IRC §643(b) and the laws of ${trust.governingState}.`
		: ' Allocation is made under IRC §643(b).';

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>EXTRAORDINARY DIVIDEND CHARACTERIZATION</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · {formatDate(v.receiptDate)} · Tax year {v.taxYear}
				</Text>
				<View style={styles.hr} />

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						The undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
						{trust.effectiveDate ? `, established ${formatDate(trust.effectiveDate)}` : ''},
						{trust.ein ? ` EIN ${trust.ein},` : ''} hereby characterizes the receipt described below as an <Text style={styles.emph}>extraordinary dividend</Text> for purposes of IRC §643(b)(3) and the Uniform Principal and Income Act, and allocates the receipt to principal (corpus) rather than to distributable net income.
					</Text>
				</View>

				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Receipt</Text>
						<Text style={styles.keyValueValue}>{v.receiptDescription}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Payer / issuer</Text>
						<Text style={styles.keyValueValue}>{v.payer}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Amount</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.amountCents)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Receipt date</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.receiptDate)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Tax year</Text>
						<Text style={styles.keyValueValue}>{v.taxYear}</Text>
					</View>
					{v.sourceAccountLabel && (
						<View style={styles.keyValueRow}>
							<Text style={styles.keyValueKey}>Source account</Text>
							<Text style={styles.keyValueValue}>{v.sourceAccountLabel}</Text>
						</View>
					)}
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Extraordinary basis</Text>
						<Text style={styles.keyValueValue}>{REASON_LABEL[v.extraordinaryReason]}</Text>
					</View>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>1. Statutory standard.</Text> IRC §643(b)(3) treats certain dividends as extraordinary — i.e., not "income" within the meaning of §643(b) and therefore not part of DNI. The Treasury regulations and case law (see e.g., Rev. Rul. 67-117; <Text style={styles.emph}>Hay v. Commissioner</Text>) treat liquidation distributions, return-of-capital distributions, and special dividends issued out of corporate surplus as paradigm examples. The trustee&rsquo;s characterization must rest on facts evidencing that the receipt is not part of the issuer&rsquo;s ordinary income stream.
					</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>2. Trustee&rsquo;s characterization.</Text> {v.characterizationRationale}
					</Text>
				</View>

				{v.supportingEvidence && (
					<View style={styles.recitalBlock}>
						<Text style={styles.paragraph}>
							<Text style={styles.emph}>3. Supporting evidence.</Text> {v.supportingEvidence}
						</Text>
					</View>
				)}

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>{v.supportingEvidence ? '4' : '3'}. Allocation &amp; tax effect.</Text> Because the receipt is properly characterized as extraordinary, it is allocated to the principal (corpus) of the Trust and is <Text style={styles.emph}>not</Text> included in DNI for the tax year. No K-1 income flows to any beneficiary on account of this receipt. The receipt will be reflected on Form 1041 as a corpus adjustment, not on Schedule K-1.{stateClause}
					</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>{v.supportingEvidence ? '5' : '4'}. Audit-defense note.</Text> The IRS has indicated in published guidance (including AM 2023-006 and related Office of Chief Counsel memoranda) that improper use of the §643(b) extraordinary-dividend framework is a marketed-scheme audit trigger. This memo, together with the annual Declaration of Extraordinary Dividend, provides the contemporaneous fact-based support that the trustee&rsquo;s characterization is grounded in the underlying transaction&mdash;not a tax-motivated label applied to ordinary income.
					</Text>
				</View>

				<Text style={styles.signaturesHeader}>SIGNATURE</Text>

				<View style={styles.sigBlock}>
					<View style={styles.sigLineRule} />
					<Text style={styles.sigName}>{trustee?.signedName ?? trustee?.expectedName ?? 'Trustee'}</Text>
					<Text style={styles.sigLabel}>
						Trustee of {trustLabel}
					</Text>
					{trustee?.signedAt && (
						<Text style={styles.sigMeta}>
							Signed {trustee.signedAt}{trustee.signedIp ? ` · IP ${trustee.signedIp}` : ''}
						</Text>
					)}
				</View>

				<Text style={styles.footer}>
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template extraordinary-dividend-characterization v1
				</Text>
			</Page>
		</Document>
	);
}

export const extraordinaryDividendCharacterizationTemplate: TemplateDefinition<CharacterizationVariables> = {
	id: 'extraordinary-dividend-characterization',
	version: '1',
	label: 'Extraordinary Dividend Characterization (per-event)',
	description:
		'Per-event memo characterizing a specific dividend or distribution as "extraordinary" under IRC §643(b)(3). Pairs with the annual Declaration of Extraordinary Dividend; without per-event support the annual roll-up is the most likely audit target.',
	category: 'corpus',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: extraordinaryDividendCharacterizationPdf,
	formFields: [
		{
			name: 'receiptDescription',
			label: 'Receipt description',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "Special dividend from XYZ Holdings", "Liquidation distribution from ABC LLC partnership wind-down"',
			span: 2,
		},
		{ name: 'payer', label: 'Payer / issuer', widget: 'text' },
		{ name: 'amountCents', label: 'Amount ($)', widget: 'dollars', cents: true },
		{ name: 'receiptDate', label: 'Receipt date', widget: 'date' },
		{ name: 'taxYear', label: 'Tax year', widget: 'integer' },
		{
			name: 'sourceAccountLabel',
			label: 'Source account (optional)',
			widget: 'text',
			required: false,
			placeholder: 'e.g., 410 Dividend Income',
			span: 2,
		},
		{
			name: 'extraordinaryReason',
			label: 'Extraordinary basis',
			widget: 'select',
			options: [
				{ value: 'liquidation', label: 'Liquidation distribution (partial or complete)' },
				{ value: 'one_time_special', label: 'One-time special dividend declared by issuer' },
				{ value: 'return_of_capital', label: 'Return-of-capital distribution' },
				{ value: 'merger_or_spinoff', label: 'Merger or spin-off distribution' },
				{ value: 'large_relative', label: 'Unusually large relative to issuer history' },
				{ value: 'other', label: 'Other (explain in rationale)' },
			],
			span: 2,
		},
		{
			name: 'characterizationRationale',
			label: 'Trustee characterization rationale',
			widget: 'textarea',
			rows: 4,
			placeholder:
				'Specific facts supporting characterization as extraordinary. Cite issuer declaration / 10-K disclosure / SEC filing / partnership K-1 footnote where possible. The IRS treats conclusory labels as a marketed-scheme red flag; facts are the defense.',
			span: 2,
		},
		{
			name: 'supportingEvidence',
			label: 'Supporting evidence (optional)',
			widget: 'textarea',
			rows: 2,
			placeholder: 'Press release URL, 1099-DIV box reference, partnership wind-up agreement, etc.',
			required: false,
			span: 2,
		},
	],
};
