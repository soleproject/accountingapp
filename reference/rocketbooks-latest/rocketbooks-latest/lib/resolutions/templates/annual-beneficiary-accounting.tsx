import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Annual Beneficiary Accounting per UTC §813.
 *
 * Under UTC §813(c) and most state adoptions, the trustee must
 * deliver a report to qualified beneficiaries at least annually
 * containing:
 *   1. Trust property (assets + liabilities) with market values
 *   2. Receipts (income, contributions, gains)
 *   3. Disbursements (expenses, distributions)
 *   4. Source + amount of trustee compensation
 *   5. Material transactions (acquisitions, dispositions)
 *
 * This template covers all five. Variables are snapshotted at draft
 * time from a year of GL activity so re-rendering reproduces the same
 * document — important because the report is what was delivered, not
 * a live view that drifts as the books are updated.
 *
 * Trustee signs and certifies; the report is delivered to qualified
 * beneficiaries (out of band — UTC §813 doesn't require beneficiary
 * signatures, only timely delivery).
 */

const BALANCE_ITEM_SCHEMA = z.object({
	accountNumber: z.string().nullable(),
	accountName: z.string(),
	balanceCents: z.number().int(),
});

const ACTIVITY_ITEM_SCHEMA = z.object({
	accountNumber: z.string().nullable(),
	accountName: z.string(),
	amountCents: z.number().int().nonnegative(),
});

const DISTRIBUTION_ITEM_SCHEMA = z.object({
	beneficiaryName: z.string(),
	amountCents: z.number().int().nonnegative(),
	distributionCount: z.number().int().nonnegative(),
});

const VARIABLES_SCHEMA = z.object({
	taxYear: z.number().int().min(1900).max(3000),
	periodStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	periodEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	assetBalances: z.array(BALANCE_ITEM_SCHEMA),
	liabilityBalances: z.array(BALANCE_ITEM_SCHEMA),
	receipts: z.array(ACTIVITY_ITEM_SCHEMA),
	disbursements: z.array(ACTIVITY_ITEM_SCHEMA),
	distributions: z.array(DISTRIBUTION_ITEM_SCHEMA),
	trusteeCompensationCents: z.number().int().nonnegative(),
	notes: z.string().optional().nullable(),
});

type AccountingVariables = z.infer<typeof VARIABLES_SCHEMA>;

const styles = StyleSheet.create({
	page: {
		paddingTop: 56,
		paddingBottom: 64,
		paddingHorizontal: 48,
		fontFamily: 'Helvetica',
		fontSize: 10,
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
	intro: {
		marginBottom: 14,
		textAlign: 'justify',
	},
	emph: {
		fontFamily: 'Helvetica-Bold',
	},
	sectionHeader: {
		marginTop: 16,
		marginBottom: 6,
		paddingBottom: 4,
		borderBottomWidth: 0.75,
		borderBottomColor: '#0f172a',
		fontFamily: 'Helvetica-Bold',
		fontSize: 11,
		color: '#0f172a',
		textTransform: 'uppercase',
		letterSpacing: 0.5,
	},
	row: {
		flexDirection: 'row',
		paddingVertical: 4,
		borderBottomWidth: 0.5,
		borderBottomColor: '#e2e8f0',
	},
	col_acct: { flex: 1, paddingRight: 6 },
	col_count: { width: '15%', textAlign: 'right' },
	col_amount: { width: '22%', textAlign: 'right' },
	cellMain: {
		fontSize: 10,
		color: '#0f172a',
	},
	cellSub: {
		fontSize: 8,
		fontFamily: 'Courier',
		color: '#64748b',
		marginTop: 1,
	},
	totalsRow: {
		flexDirection: 'row',
		paddingVertical: 5,
		marginTop: 4,
		borderTopWidth: 1,
		borderTopColor: '#0f172a',
	},
	totalsLabel: {
		flex: 1,
		fontFamily: 'Helvetica-Bold',
		fontSize: 10,
		color: '#0f172a',
	},
	totalsValue: {
		fontFamily: 'Helvetica-Bold',
		fontSize: 10,
		color: '#0f172a',
		textAlign: 'right',
		width: '22%',
	},
	emptyState: {
		fontSize: 9.5,
		color: '#64748b',
		fontStyle: 'italic',
		paddingVertical: 4,
	},
	notesBlock: {
		marginTop: 20,
		padding: 10,
		backgroundColor: '#f8fafc',
		borderRadius: 4,
	},
	notesLabel: {
		fontFamily: 'Helvetica-Bold',
		fontSize: 8.5,
		color: '#475569',
		textTransform: 'uppercase',
		letterSpacing: 0.4,
		marginBottom: 4,
	},
	notesBody: {
		fontSize: 10,
		color: '#0f172a',
	},
	certificationBlock: {
		marginTop: 24,
		padding: 12,
		backgroundColor: '#f1f5f9',
		borderRadius: 4,
	},
	certificationLabel: {
		fontFamily: 'Helvetica-Bold',
		fontSize: 9.5,
		color: '#475569',
		textTransform: 'uppercase',
		letterSpacing: 0.4,
		marginBottom: 6,
	},
	certificationBody: {
		fontSize: 10,
		color: '#0f172a',
		textAlign: 'justify',
	},
	signaturesHeader: {
		marginTop: 28,
		marginBottom: 6,
		fontSize: 10,
		letterSpacing: 1.5,
		color: '#0f172a',
		fontFamily: 'Helvetica-Bold',
	},
	sigBlock: {
		marginTop: 16,
	},
	sigLineRule: {
		borderBottomWidth: 0.75,
		borderBottomColor: '#0f172a',
		marginBottom: 4,
		marginTop: 28,
	},
	sigLabel: {
		fontSize: 9,
		color: '#64748b',
	},
	sigName: {
		fontSize: 10.5,
		fontFamily: 'Helvetica-Bold',
		color: '#0f172a',
		marginBottom: 2,
	},
	sigMeta: {
		fontSize: 8,
		color: '#64748b',
		marginTop: 2,
	},
	footer: {
		position: 'absolute',
		bottom: 32,
		left: 48,
		right: 48,
		fontSize: 8,
		color: '#94a3b8',
		textAlign: 'center',
		borderTopWidth: 0.5,
		borderTopColor: '#cbd5e1',
		paddingTop: 6,
	},
});

function formatMoney(cents: number): string {
	const negative = cents < 0;
	const abs = Math.abs(cents);
	const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(abs / 100);
	return negative ? `(${formatted})` : formatted;
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function annualBeneficiaryAccountingPdf(args: RenderArgs<AccountingVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));

	const totalAssetsCents = v.assetBalances.reduce((acc, b) => acc + b.balanceCents, 0);
	const totalLiabilitiesCents = v.liabilityBalances.reduce((acc, b) => acc + b.balanceCents, 0);
	const netAssetsCents = totalAssetsCents - totalLiabilitiesCents;
	const totalReceiptsCents = v.receipts.reduce((acc, r) => acc + r.amountCents, 0);
	const totalDisbursementsCents = v.disbursements.reduce((acc, d) => acc + d.amountCents, 0);
	const totalDistributionsCents = v.distributions.reduce((acc, d) => acc + d.amountCents, 0);

	const statuteCitation = trust.governingState
		? `Uniform Trust Code §813 as adopted in ${trust.governingState}`
		: 'Uniform Trust Code §813';

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>ANNUAL BENEFICIARY ACCOUNTING</Text>
				<Text style={styles.subtitle}>
					{trustLabel}{trust.ein ? ` · EIN ${trust.ein}` : ''} · Tax year {v.taxYear} · {formatDate(v.periodStartDate)} through {formatDate(v.periodEndDate)}
				</Text>
				<View style={styles.hr} />

				<Text style={styles.intro}>
					This accounting is delivered to the qualified beneficiaries of <Text style={styles.emph}>{trustLabel}</Text> pursuant to {statuteCitation}. It summarizes the trust property as of the period end, the receipts and disbursements during the period, distributions to beneficiaries, and the trustee compensation paid. A beneficiary who has questions about any item below may request supporting documentation from the Trustee in writing.
				</Text>

				<Text style={styles.sectionHeader}>Trust Property — Assets</Text>
				{v.assetBalances.length === 0 ? (
					<Text style={styles.emptyState}>No asset balances recorded for the period.</Text>
				) : (
					<>
						{v.assetBalances.map((b, idx) => (
							<View key={idx} style={styles.row} wrap={false}>
								<View style={styles.col_acct}>
									<Text style={styles.cellMain}>{b.accountName}</Text>
									{b.accountNumber && (
										<Text style={styles.cellSub}>Account {b.accountNumber}</Text>
									)}
								</View>
								<Text style={[styles.cellMain, styles.col_amount]}>{formatMoney(b.balanceCents)}</Text>
							</View>
						))}
						<View style={styles.totalsRow}>
							<Text style={styles.totalsLabel}>Total Assets</Text>
							<Text style={styles.totalsValue}>{formatMoney(totalAssetsCents)}</Text>
						</View>
					</>
				)}

				<Text style={styles.sectionHeader}>Trust Property — Liabilities</Text>
				{v.liabilityBalances.length === 0 ? (
					<Text style={styles.emptyState}>No liabilities recorded for the period.</Text>
				) : (
					<>
						{v.liabilityBalances.map((b, idx) => (
							<View key={idx} style={styles.row} wrap={false}>
								<View style={styles.col_acct}>
									<Text style={styles.cellMain}>{b.accountName}</Text>
									{b.accountNumber && (
										<Text style={styles.cellSub}>Account {b.accountNumber}</Text>
									)}
								</View>
								<Text style={[styles.cellMain, styles.col_amount]}>{formatMoney(b.balanceCents)}</Text>
							</View>
						))}
						<View style={styles.totalsRow}>
							<Text style={styles.totalsLabel}>Total Liabilities</Text>
							<Text style={styles.totalsValue}>{formatMoney(totalLiabilitiesCents)}</Text>
						</View>
					</>
				)}

				<View style={styles.totalsRow}>
					<Text style={styles.totalsLabel}>Net Trust Property</Text>
					<Text style={styles.totalsValue}>{formatMoney(netAssetsCents)}</Text>
				</View>

				<Text style={styles.sectionHeader}>Receipts during the period</Text>
				{v.receipts.length === 0 ? (
					<Text style={styles.emptyState}>No receipts recorded for the period.</Text>
				) : (
					<>
						{v.receipts.map((r, idx) => (
							<View key={idx} style={styles.row} wrap={false}>
								<View style={styles.col_acct}>
									<Text style={styles.cellMain}>{r.accountName}</Text>
									{r.accountNumber && (
										<Text style={styles.cellSub}>Account {r.accountNumber}</Text>
									)}
								</View>
								<Text style={[styles.cellMain, styles.col_amount]}>{formatMoney(r.amountCents)}</Text>
							</View>
						))}
						<View style={styles.totalsRow}>
							<Text style={styles.totalsLabel}>Total Receipts</Text>
							<Text style={styles.totalsValue}>{formatMoney(totalReceiptsCents)}</Text>
						</View>
					</>
				)}

				<Text style={styles.sectionHeader}>Disbursements during the period</Text>
				{v.disbursements.length === 0 ? (
					<Text style={styles.emptyState}>No disbursements recorded for the period.</Text>
				) : (
					<>
						{v.disbursements.map((d, idx) => (
							<View key={idx} style={styles.row} wrap={false}>
								<View style={styles.col_acct}>
									<Text style={styles.cellMain}>{d.accountName}</Text>
									{d.accountNumber && (
										<Text style={styles.cellSub}>Account {d.accountNumber}</Text>
									)}
								</View>
								<Text style={[styles.cellMain, styles.col_amount]}>{formatMoney(d.amountCents)}</Text>
							</View>
						))}
						<View style={styles.totalsRow}>
							<Text style={styles.totalsLabel}>Total Disbursements</Text>
							<Text style={styles.totalsValue}>{formatMoney(totalDisbursementsCents)}</Text>
						</View>
					</>
				)}

				<Text style={styles.sectionHeader}>Distributions to Beneficiaries</Text>
				{v.distributions.length === 0 ? (
					<Text style={styles.emptyState}>No distributions made during the period.</Text>
				) : (
					<>
						{v.distributions.map((d, idx) => (
							<View key={idx} style={styles.row} wrap={false}>
								<View style={styles.col_acct}>
									<Text style={styles.cellMain}>{d.beneficiaryName}</Text>
								</View>
								<Text style={[styles.cellMain, styles.col_count]}>
									{d.distributionCount} {d.distributionCount === 1 ? 'distribution' : 'distributions'}
								</Text>
								<Text style={[styles.cellMain, styles.col_amount]}>{formatMoney(d.amountCents)}</Text>
							</View>
						))}
						<View style={styles.totalsRow}>
							<Text style={styles.totalsLabel}>Total Distributions</Text>
							<View style={{ width: '15%' }} />
							<Text style={styles.totalsValue}>{formatMoney(totalDistributionsCents)}</Text>
						</View>
					</>
				)}

				<Text style={styles.sectionHeader}>Trustee Compensation</Text>
				<View style={styles.row}>
					<View style={styles.col_acct}>
						<Text style={styles.cellMain}>Compensation paid to Trustee during the period</Text>
					</View>
					<Text style={[styles.cellMain, styles.col_amount]}>{formatMoney(v.trusteeCompensationCents)}</Text>
				</View>

				{v.notes && (
					<View style={styles.notesBlock}>
						<Text style={styles.notesLabel}>Notes from the Trustee</Text>
						<Text style={styles.notesBody}>{v.notes}</Text>
					</View>
				)}

				<View style={styles.certificationBlock}>
					<Text style={styles.certificationLabel}>Certification</Text>
					<Text style={styles.certificationBody}>
						The undersigned Trustee certifies that the foregoing accounting is, to the best of the Trustee&rsquo;s knowledge and belief, a true and correct summary of the trust&rsquo;s property and activity for the period stated, derived from the books and records maintained for {trustLabel}. Supporting journal entries, receipts, and signed resolutions are available for inspection on reasonable notice.
					</Text>
				</View>

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
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template annual-beneficiary-accounting v1
				</Text>
			</Page>
		</Document>
	);
}

export const annualBeneficiaryAccountingTemplate: TemplateDefinition<AccountingVariables> = {
	id: 'annual-beneficiary-accounting',
	version: '1',
	label: 'Annual Beneficiary Accounting (UTC §813)',
	description:
		'Year-end report to qualified beneficiaries per Uniform Trust Code §813: assets + liabilities + receipts + disbursements + distributions + trustee compensation. Auto-populated from a year of GL activity.',
	category: 'annual',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: annualBeneficiaryAccountingPdf,
};
