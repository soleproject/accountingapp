import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Declaration of Extraordinary Dividend — annual filing that
 * documents the trustee's election to RETAIN otherwise-distributable
 * income items (rental, interest, dividends, K-1, royalty, etc.) in
 * trust corpus rather than distribute them as DNI to beneficiaries.
 *
 * Source-spec note: the spec docs call this "Nexxess-Approved" and
 * cite IRC §643(b) as the authority for the retention. This generic
 * template covers the §643(b) shape; orgs with a proprietary form
 * can upload theirs in a later release.
 *
 * One per tax year. NOT auto-triggered today — the trustee opens it
 * from the catalog at year-end, picks the tax year, and the
 * retention amounts auto-populate from 4xx credits minus 310
 * debits in that period.
 */

const DIVIDEND_LINE_ITEM_SCHEMA = z.object({
	accountNumber: z.string().optional().nullable(),
	accountName: z.string(),
	/** Cents. Gross income credited to this account in the tax year. */
	incomeCents: z.number().int().nonnegative(),
	/** Cents. Portion of this income distributed to beneficiaries. */
	distributedCents: z.number().int().nonnegative(),
	/** Cents. incomeCents - distributedCents (clamped at 0). */
	retainedCents: z.number().int().nonnegative(),
});

const VARIABLES_SCHEMA = z.object({
	/** Tax year being declared. */
	taxYear: z.number().int().min(1900).max(3000),
	/** Period end date — typically the fiscal-year-end date the trust
	 *  uses; calendar trusts will be YYYY-12-31. */
	periodEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Line items, one per 4xx (or other-income) account that carried
	 *  retained income for the year. */
	items: z.array(DIVIDEND_LINE_ITEM_SCHEMA),
	/** Free-text rationale: why the trustee elected to retain rather
	 *  than distribute. */
	retentionRationale: z.string().optional().nullable(),
	/** Optional trust-instrument citation that authorizes retention. */
	authorityCitation: z.string().optional().nullable(),
});

type DividendVariables = z.infer<typeof VARIABLES_SCHEMA>;

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
		marginBottom: 20,
	},
	hr: {
		borderBottomWidth: 1,
		borderBottomColor: '#0f172a',
		marginBottom: 18,
	},
	intro: {
		marginBottom: 14,
		textAlign: 'justify',
	},
	emph: {
		fontFamily: 'Helvetica-Bold',
	},
	tableHeader: {
		flexDirection: 'row',
		borderBottomWidth: 1,
		borderBottomColor: '#0f172a',
		paddingBottom: 4,
		marginBottom: 4,
	},
	tableHeaderCell: {
		fontFamily: 'Helvetica-Bold',
		fontSize: 8.5,
		color: '#475569',
		textTransform: 'uppercase',
		letterSpacing: 0.4,
	},
	row: {
		flexDirection: 'row',
		paddingVertical: 5,
		borderBottomWidth: 0.5,
		borderBottomColor: '#e2e8f0',
	},
	col_n: { width: '5%' },
	col_acct: { width: '47%', paddingRight: 6 },
	col_income: { width: '16%', textAlign: 'right' },
	col_dist: { width: '16%', textAlign: 'right' },
	col_retained: { width: '16%', textAlign: 'right' },
	cellMain: {
		fontSize: 9.5,
		color: '#0f172a',
	},
	cellSub: {
		fontSize: 8,
		fontFamily: 'Courier',
		color: '#64748b',
		marginTop: 1,
	},
	totals: {
		flexDirection: 'row',
		marginTop: 12,
		paddingTop: 8,
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
	},
	rationaleBlock: {
		marginTop: 20,
		marginBottom: 12,
	},
	rationaleLabel: {
		fontFamily: 'Helvetica-Bold',
		fontSize: 9.5,
		color: '#475569',
		textTransform: 'uppercase',
		letterSpacing: 0.4,
		marginBottom: 6,
	},
	rationaleBody: {
		fontSize: 10.5,
		color: '#0f172a',
		marginBottom: 8,
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
	emptyState: {
		marginTop: 16,
		padding: 12,
		backgroundColor: '#fef3c7',
		borderRadius: 4,
		fontSize: 10,
		color: '#92400e',
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
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function declarationOfExtraordinaryDividendPdf(args: RenderArgs<DividendVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));

	const totalIncome = v.items.reduce((acc, i) => acc + i.incomeCents, 0);
	const totalDistributed = v.items.reduce((acc, i) => acc + i.distributedCents, 0);
	const totalRetained = v.items.reduce((acc, i) => acc + i.retainedCents, 0);

	const stateClause = trust.governingState
		? ` This Declaration is made under IRC §643(b) and the laws of ${trust.governingState}.`
		: ' This Declaration is made under IRC §643(b).';

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>DECLARATION OF EXTRAORDINARY DIVIDEND</Text>
				<Text style={styles.subtitle}>
					{trustLabel}{trust.ein ? ` · EIN ${trust.ein}` : ''} · Tax year {v.taxYear} · Period ending {formatDate(v.periodEndDate)}
				</Text>
				<View style={styles.hr} />

				<Text style={styles.intro}>
					The undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
					{trust.effectiveDate ? `, established ${formatDate(trust.effectiveDate)}` : ''},
					hereby declares the retention to trust corpus of the income items
					listed below for tax year {v.taxYear}, pursuant to the trustee&rsquo;s
					discretionary authority under the Trust Agreement and IRC §643(b).
					Retained amounts are <Text style={styles.emph}>not</Text> included in
					Distributable Net Income (DNI) for the year and therefore do not
					generate K-1 income to any beneficiary on account of this Declaration.
				</Text>

				{v.items.length === 0 ? (
					<View style={styles.emptyState}>
						<Text>
							No income retained for the period — every dollar of income posted to a 4xx
							account in the period was distributed (or there was no income). This
							Declaration has no effect; consider whether it&rsquo;s needed.
						</Text>
					</View>
				) : (
					<>
						<View style={styles.tableHeader}>
							<Text style={[styles.tableHeaderCell, styles.col_n]}>#</Text>
							<Text style={[styles.tableHeaderCell, styles.col_acct]}>Account</Text>
							<Text style={[styles.tableHeaderCell, styles.col_income]}>Income</Text>
							<Text style={[styles.tableHeaderCell, styles.col_dist]}>Distributed</Text>
							<Text style={[styles.tableHeaderCell, styles.col_retained]}>Retained</Text>
						</View>

						{v.items.map((item, idx) => (
							<View key={idx} style={styles.row} wrap={false}>
								<Text style={[styles.cellMain, styles.col_n]}>{idx + 1}</Text>
								<View style={styles.col_acct}>
									<Text style={styles.cellMain}>{item.accountName}</Text>
									{item.accountNumber && (
										<Text style={styles.cellSub}>Account {item.accountNumber}</Text>
									)}
								</View>
								<Text style={[styles.cellMain, styles.col_income]}>{formatMoney(item.incomeCents)}</Text>
								<Text style={[styles.cellMain, styles.col_dist]}>{formatMoney(item.distributedCents)}</Text>
								<Text style={[styles.cellMain, styles.col_retained]}>{formatMoney(item.retainedCents)}</Text>
							</View>
						))}

						<View style={styles.totals}>
							<Text style={styles.totalsLabel}>
								Totals ({v.items.length} account{v.items.length === 1 ? '' : 's'})
							</Text>
							<View style={{ width: '16%' }}>
								<Text style={styles.totalsValue}>{formatMoney(totalIncome)}</Text>
							</View>
							<View style={{ width: '16%' }}>
								<Text style={styles.totalsValue}>{formatMoney(totalDistributed)}</Text>
							</View>
							<View style={{ width: '16%' }}>
								<Text style={styles.totalsValue}>{formatMoney(totalRetained)}</Text>
							</View>
						</View>
					</>
				)}

				{v.retentionRationale && (
					<View style={styles.rationaleBlock}>
						<Text style={styles.rationaleLabel}>Retention rationale</Text>
						<Text style={styles.rationaleBody}>{v.retentionRationale}</Text>
					</View>
				)}

				{v.authorityCitation && (
					<View style={styles.rationaleBlock}>
						<Text style={styles.rationaleLabel}>Authority</Text>
						<Text style={styles.rationaleBody}>{v.authorityCitation}{stateClause}</Text>
					</View>
				)}

				{!v.authorityCitation && (
					<View style={styles.rationaleBlock}>
						<Text style={styles.rationaleBody}>
							<Text style={styles.emph}>Authority.</Text> The Trustee acts
							under the discretionary retention authority of the Trust
							Agreement and IRC §643(b).{stateClause}
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
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template declaration-of-extraordinary-dividend v1
				</Text>
			</Page>
		</Document>
	);
}

export const declarationOfExtraordinaryDividendTemplate: TemplateDefinition<DividendVariables> = {
	id: 'declaration-of-extraordinary-dividend',
	version: '1',
	label: 'Declaration of Extraordinary Dividend (annual)',
	description:
		'Year-end declaration that the trustee has elected to retain otherwise-distributable income to trust corpus under IRC §643(b). Auto-populated from 4xx income credits minus 310 distributions in the tax year.',
	category: 'annual',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: declarationOfExtraordinaryDividendPdf,
};
