import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * §663(b) "65-Day Rule" Election Record.
 *
 * Under IRC §663(b), a trustee may elect to treat distributions made
 * within the first 65 days of a tax year as having been made on the
 * last day of the preceding year. The election is made on Form 1041,
 * Page 1, Line "Other Information" question 6 (a box check on the
 * §663(b) line), and is irrevocable for the year. It is the single
 * most powerful year-end planning tool a complex non-grantor trust
 * has — it lets the trustee see preliminary trust DNI / tax bracket
 * results in the first quarter of Y+1 and push DNI to beneficiaries
 * to avoid the compressed trust-level brackets ($16,550 → 37% in 2026).
 *
 * This document is the contemporaneous election record. It captures:
 *   - The DNI / undistributed-income picture being addressed
 *   - The specific distributions covered (date + amount + beneficiary)
 *   - The cents-level total being elected back into the prior year
 *   - An affirmative statement that the trustee instructs the return
 *     preparer to check the §663(b) box on the 1041
 *
 * Filing deadline math: distributions must be PAID (not merely
 * declared) by March 6 / 7 (65 days after Dec 31). The 1041 must be
 * timely filed (or extended) — late filings cannot make the election.
 */

const VARIABLES_SCHEMA = z.object({
	/** The PRIOR tax year being affected by the election (the year the
	 *  distributions will be treated as having been made on the last
	 *  day of). 4-digit calendar year. */
	priorTaxYear: z.number().int().min(2000).max(2100),
	/** Approximate undistributed income / DNI the trust would have
	 *  retained absent this election (per the year-end tax projection). */
	estimatedDniRetainedCents: z.number().int().nonnegative(),
	/** Estimated trust-level tax savings from making the election
	 *  (i.e., the differential between the compressed trust brackets
	 *  and the beneficiaries' marginal brackets). */
	estimatedTaxSavingsCents: z.number().int().nonnegative(),
	/** Total dollar amount being elected back into the prior year. */
	electionAmountCents: z.number().int().nonnegative(),
	/** Narrative description of the distributions being covered —
	 *  list each (date, beneficiary, amount). The Distribution
	 *  Authorization PDFs are the legal artifacts; this is a roll-up
	 *  for the election record. */
	distributionsCovered: z.string().min(1),
	/** Optional explanation of why the election is in beneficiaries'
	 *  best interests. */
	rationale: z.string().min(1),
	/** Last possible election date (65 days after Dec 31 of the prior
	 *  year, allowing for leap years). YYYY-03-06 or YYYY-03-07. */
	electionDeadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Date the trustee actually signed this election. */
	electionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Return preparer / CPA who will file the 1041 with the §663(b)
	 *  box checked. */
	returnPreparerName: z.string().optional().nullable(),
});

type ElectionVariables = z.infer<typeof VARIABLES_SCHEMA>;

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
		width: 165,
		fontFamily: 'Helvetica-Bold',
		fontSize: 9,
		color: '#475569',
		textTransform: 'uppercase',
		letterSpacing: 0.4,
	},
	keyValueValue: { flex: 1, fontSize: 10, color: '#0f172a' },
	electionBox: {
		marginVertical: 12,
		paddingVertical: 10,
		paddingHorizontal: 14,
		borderWidth: 1.5,
		borderColor: '#0f172a',
		borderRadius: 4,
	},
	electionBoxLabel: {
		fontSize: 9,
		fontFamily: 'Helvetica-Bold',
		color: '#475569',
		textTransform: 'uppercase',
		letterSpacing: 0.6,
		marginBottom: 4,
	},
	electionBoxText: { fontSize: 11, color: '#0f172a', fontFamily: 'Helvetica-Bold' },
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

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function section663bPdf(args: RenderArgs<ElectionVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>§663(b) 65-DAY ELECTION RECORD</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · Tax Year {v.priorTaxYear} · Signed {formatDate(v.electionDate)}
				</Text>
				<View style={styles.hr} />

				<Text style={styles.intro}>
					The undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
					{trust.ein ? ` (EIN ${trust.ein})` : ''} hereby makes a contemporaneous record of the §663(b) "65-day rule" election with respect to tax year <Text style={styles.emph}>{v.priorTaxYear}</Text>. Pursuant to IRC §663(b) and Treas. Reg. §1.663(b)-1, distributions paid by the Trust within the first 65 days of {v.priorTaxYear + 1} that are covered by this election shall be treated, for federal income tax purposes, as having been paid on the last day of the preceding tax year ({v.priorTaxYear}).
				</Text>

				<Text style={styles.sectionHeader}>1. Tax picture motivating the election</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Tax year affected</Text>
						<Text style={styles.keyValueValue}>{v.priorTaxYear}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Undistributed DNI retained</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.estimatedDniRetainedCents)} (pre-election)</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Estimated trust-level tax savings</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.estimatedTaxSavingsCents)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Election deadline</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.electionDeadline)} (65 days after 12/31/{v.priorTaxYear})</Text>
					</View>
				</View>

				<Text style={styles.body}>{v.rationale}</Text>

				<Text style={styles.sectionHeader}>2. Distributions covered by the election</Text>
				<Text style={styles.body}>{v.distributionsCovered}</Text>

				<View style={styles.electionBox}>
					<Text style={styles.electionBoxLabel}>Total amount elected back into tax year {v.priorTaxYear}</Text>
					<Text style={styles.electionBoxText}>{formatMoney(v.electionAmountCents)}</Text>
				</View>

				<Text style={styles.sectionHeader}>3. Trustee election</Text>
				<Text style={styles.body}>
					The Trustee hereby elects, irrevocably as to tax year {v.priorTaxYear}, to treat the distributions identified in Section 2 as having been made on the last day of tax year {v.priorTaxYear}. The Trustee instructs the return preparer{v.returnPreparerName ? `, ${v.returnPreparerName},` : ''} to (a) check the §663(b) box on the {v.priorTaxYear} Form 1041 "Other Information" section, (b) include the elected amount on Schedule B / DNI calculation as a {v.priorTaxYear} distribution, and (c) attach a statement identifying the elected amount as required by Treas. Reg. §1.663(b)-2.
				</Text>

				<Text style={styles.sectionHeader}>4. Reliance &amp; acknowledgment</Text>
				<Text style={styles.body}>
					The Trustee acknowledges that this election (i) is limited to amounts actually paid (not merely declared) within the 65-day window; (ii) is irrevocable as to {v.priorTaxYear} once the {v.priorTaxYear} Form 1041 is filed; and (iii) does not retroactively change the trust accounting income / corpus characterization of the underlying distributions — only their federal income-tax treatment.
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
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template section-663b-65-day-election v1
				</Text>
			</Page>
		</Document>
	);
}

export const section663b65DayElectionTemplate: TemplateDefinition<ElectionVariables> = {
	id: 'section-663b-65-day-election',
	version: '1',
	label: '§663(b) 65-Day Election Record',
	description:
		'IRC §663(b) election to treat first-65-days distributions as made in the prior tax year. Signed by March 6/7 each year to push DNI to beneficiaries and avoid compressed trust-level brackets.',
	category: 'annual',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: false,
	renderPdf: section663bPdf,
	formFields: [
		{ name: 'priorTaxYear', label: 'Tax year affected (prior year)', widget: 'integer', placeholder: 'e.g., 2025' },
		{ name: 'electionDate', label: 'Date trustee signs this election', widget: 'date' },
		{ name: 'electionDeadline', label: 'Election deadline (65th day)', widget: 'date', placeholder: 'YYYY-03-06 or 03-07' },
		{ name: 'electionAmountCents', label: 'Total elected back into prior year ($)', widget: 'dollars', cents: true },
		{ name: 'estimatedDniRetainedCents', label: 'Undistributed DNI absent election ($)', widget: 'dollars', cents: true },
		{ name: 'estimatedTaxSavingsCents', label: 'Estimated tax savings ($)', widget: 'dollars', cents: true },
		{
			name: 'distributionsCovered',
			label: 'Distributions covered by the election',
			widget: 'textarea',
			rows: 4,
			placeholder: 'List each covered distribution: date paid, beneficiary, amount. e.g., "2026-02-14 — John Doe — $12,500; 2026-03-01 — Jane Doe — $12,500"',
			span: 2,
		},
		{
			name: 'rationale',
			label: 'Rationale (best-interests determination)',
			widget: 'textarea',
			rows: 3,
			placeholder: 'Why the election is in the beneficiaries\' best interests — typically the bracket differential between trust-level rates and beneficiary marginal rates.',
			span: 2,
		},
		{ name: 'returnPreparerName', label: 'Return preparer / CPA (optional)', widget: 'text', required: false, span: 2 },
	],
};
