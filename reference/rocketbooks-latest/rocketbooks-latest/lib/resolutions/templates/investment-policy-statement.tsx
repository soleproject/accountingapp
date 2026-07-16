import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Investment Policy Statement (IPS) Adoption Resolution.
 *
 * UPIA §2(b) — "A trustee's investment and management decisions…
 * must be evaluated… as part of an overall investment strategy."
 * Without a written IPS, every 160-series purchase is naked. With
 * one, the trustee has a documented overall strategy that frames
 * every individual investment decision.
 *
 * One-time at trust formation + annual ratify. The annual ratification
 * is a separate doc fired from the catalog with a `reviewedAnnually`
 * flag set on the variables (later — Phase 2). For now this single
 * template covers both modes by including a "review-frequency"
 * statement and letting users redraft annually.
 */

const VARIABLES_SCHEMA = z.object({
	/** Statement of trust purposes — drives every other allocation
	 *  decision. e.g., "preservation of capital for the benefit of
	 *  current beneficiaries with growth for future generations". */
	trustPurposes: z.string().min(1),
	/** Time horizon (in years) the investment strategy targets. */
	timeHorizonYears: z.number().int().positive(),
	/** Anticipated annual distributions as a percent of trust assets
	 *  — drives liquidity targets. */
	distributionRatePercent: z.number().nonnegative(),
	/** Risk tolerance — categorical. */
	riskTolerance: z.enum(['conservative', 'moderate_conservative', 'moderate', 'moderate_aggressive', 'aggressive']),
	/** Target allocation as free text — e.g., "50% equities / 35%
	 *  fixed income / 10% real estate / 5% cash, ±10% per asset
	 *  class". */
	targetAllocation: z.string().min(1),
	/** Permitted asset classes — comma-separated or one per line. */
	permittedAssetClasses: z.string().min(1),
	/** Prohibited investments (margin trading, naked options, single
	 *  positions > 50%, etc.). */
	prohibitedInvestments: z.string().optional().nullable(),
	/** Rebalancing policy. */
	rebalancingPolicy: z.string().min(1),
	/** Benchmark (e.g., 60/40 stock/bond index, S&P 500, ACWI, etc.) */
	benchmark: z.string().optional().nullable(),
	/** How often the IPS is reviewed. */
	reviewCadence: z.enum(['quarterly', 'semi_annual', 'annual']),
	/** Whether investment management is delegated to a third party
	 *  under UTC §807. */
	delegatedToManager: z.enum(['yes', 'no']),
	/** Investment manager / advisor name, if delegated. */
	managerName: z.string().optional().nullable(),
	/** Effective date of this IPS. */
	effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

type IPSVariables = z.infer<typeof VARIABLES_SCHEMA>;

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
	intro: { marginBottom: 14, textAlign: 'justify' },
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
	body: { fontSize: 10.5, color: '#0f172a', marginBottom: 8 },
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
	signaturesHeader: {
		marginTop: 24,
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

const RISK_LABEL: Record<IPSVariables['riskTolerance'], string> = {
	conservative: 'Conservative (capital preservation primary)',
	moderate_conservative: 'Moderate-Conservative',
	moderate: 'Moderate (balanced growth + preservation)',
	moderate_aggressive: 'Moderate-Aggressive',
	aggressive: 'Aggressive (growth primary)',
};

const CADENCE_LABEL: Record<IPSVariables['reviewCadence'], string> = {
	quarterly: 'Quarterly',
	semi_annual: 'Semi-annually',
	annual: 'Annually',
};

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function ipsPdf(args: RenderArgs<IPSVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const stateClause = trust.governingState
		? ` This IPS is adopted under the Uniform Prudent Investor Act (UPIA) as enacted in ${trust.governingState}.`
		: ' This IPS is adopted under the Uniform Prudent Investor Act (UPIA).';

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>INVESTMENT POLICY STATEMENT</Text>
				<Text style={styles.subtitle}>
					{trustLabel}{trust.ein ? ` · EIN ${trust.ein}` : ''} · Effective {formatDate(v.effectiveDate)}
				</Text>
				<View style={styles.hr} />

				<Text style={styles.intro}>
					This Investment Policy Statement is adopted by the Trustee of <Text style={styles.emph}>{trustLabel}</Text>
					{trust.effectiveDate ? `, established ${formatDate(trust.effectiveDate)}` : ''} to memorialize the investment strategy that guides the management of trust assets and to evidence the Trustee&rsquo;s compliance with the prudent-investor rule.{stateClause}
				</Text>

				<Text style={styles.sectionHeader}>1. Trust purposes</Text>
				<Text style={styles.body}>{v.trustPurposes}</Text>

				<Text style={styles.sectionHeader}>2. Investment objectives</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Time horizon</Text>
						<Text style={styles.keyValueValue}>{v.timeHorizonYears} years</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Annual distribution rate</Text>
						<Text style={styles.keyValueValue}>{v.distributionRatePercent.toFixed(2)}% of trust assets (target)</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Risk tolerance</Text>
						<Text style={styles.keyValueValue}>{RISK_LABEL[v.riskTolerance]}</Text>
					</View>
					{v.benchmark && (
						<View style={styles.keyValueRow}>
							<Text style={styles.keyValueKey}>Benchmark</Text>
							<Text style={styles.keyValueValue}>{v.benchmark}</Text>
						</View>
					)}
				</View>

				<Text style={styles.sectionHeader}>3. Asset allocation</Text>
				<Text style={styles.body}>{v.targetAllocation}</Text>

				<Text style={styles.sectionHeader}>4. Permitted asset classes</Text>
				<Text style={styles.body}>{v.permittedAssetClasses}</Text>

				{v.prohibitedInvestments && (
					<>
						<Text style={styles.sectionHeader}>5. Prohibited investments</Text>
						<Text style={styles.body}>{v.prohibitedInvestments}</Text>
					</>
				)}

				<Text style={styles.sectionHeader}>{v.prohibitedInvestments ? '6' : '5'}. Rebalancing</Text>
				<Text style={styles.body}>{v.rebalancingPolicy}</Text>

				<Text style={styles.sectionHeader}>{v.prohibitedInvestments ? '7' : '6'}. Review &amp; delegation</Text>
				<Text style={styles.body}>
					This IPS will be reviewed {CADENCE_LABEL[v.reviewCadence].toLowerCase()} by the Trustee. Material changes will require a new resolution adopting a revised IPS.
				</Text>
				<Text style={styles.body}>
					{v.delegatedToManager === 'yes'
						? `Investment management is delegated under UTC §807 to ${v.managerName ?? 'the named investment manager'} pursuant to a separate Investment Manager Delegation Resolution and the manager's engagement letter. The Trustee retains the duty to select, monitor, and replace the manager as appropriate.`
						: 'Investment management is retained by the Trustee. No delegation under UTC §807 is in effect.'}
				</Text>

				<Text style={styles.sectionHeader}>{v.prohibitedInvestments ? '8' : '7'}. Adoption</Text>
				<Text style={styles.body}>
					The Trustee, having determined that the foregoing is consistent with the prudent-investor rule and the purposes of the Trust, hereby adopts this Investment Policy Statement effective {formatDate(v.effectiveDate)}.
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
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template investment-policy-statement v1
				</Text>
			</Page>
		</Document>
	);
}

export const investmentPolicyStatementTemplate: TemplateDefinition<IPSVariables> = {
	id: 'investment-policy-statement',
	version: '1',
	label: 'Investment Policy Statement',
	description:
		'UPIA §2(b)-compliant statement of investment strategy. Adopted at trust formation; reviewed quarterly / semi-annually / annually. Without one, every 160-series investment is naked under the prudent-investor rule.',
	category: 'foundational',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: ipsPdf,
	formFields: [
		{
			name: 'trustPurposes',
			label: 'Trust purposes',
			widget: 'textarea',
			rows: 3,
			placeholder: 'e.g., "preservation of capital for the benefit of current beneficiaries with growth for future generations"',
			span: 2,
		},
		{ name: 'effectiveDate', label: 'Effective date', widget: 'date' },
		{ name: 'timeHorizonYears', label: 'Time horizon (years)', widget: 'integer', placeholder: 'e.g., 20' },
		{ name: 'distributionRatePercent', label: 'Annual distribution rate (% of assets)', widget: 'integer', placeholder: 'e.g., 4' },
		{
			name: 'riskTolerance',
			label: 'Risk tolerance',
			widget: 'select',
			options: [
				{ value: 'conservative', label: 'Conservative (capital preservation primary)' },
				{ value: 'moderate_conservative', label: 'Moderate-Conservative' },
				{ value: 'moderate', label: 'Moderate (balanced)' },
				{ value: 'moderate_aggressive', label: 'Moderate-Aggressive' },
				{ value: 'aggressive', label: 'Aggressive (growth primary)' },
			],
		},
		{
			name: 'targetAllocation',
			label: 'Target asset allocation',
			widget: 'textarea',
			rows: 3,
			placeholder: 'e.g., "50% equities / 35% fixed income / 10% real estate / 5% cash, ±10% per asset class"',
			span: 2,
		},
		{
			name: 'permittedAssetClasses',
			label: 'Permitted asset classes',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "US large-cap equities, US small-cap equities, international developed, EM equities, IG corporate bonds, government bonds, REITs, private real estate, cash equivalents"',
			span: 2,
		},
		{
			name: 'prohibitedInvestments',
			label: 'Prohibited investments (optional)',
			widget: 'textarea',
			rows: 2,
			required: false,
			placeholder: 'e.g., "margin trading, naked options, single positions > 50% of trust assets, C-corp ownership > 50%, cryptocurrency"',
			span: 2,
		},
		{
			name: 'rebalancingPolicy',
			label: 'Rebalancing policy',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "Rebalance to target allocation when any asset class drifts ±5% from target; review quarterly"',
			span: 2,
		},
		{ name: 'benchmark', label: 'Benchmark (optional)', widget: 'text', required: false, placeholder: 'e.g., 60/40 stock/bond index' },
		{
			name: 'reviewCadence',
			label: 'IPS review cadence',
			widget: 'select',
			options: [
				{ value: 'quarterly', label: 'Quarterly' },
				{ value: 'semi_annual', label: 'Semi-annually' },
				{ value: 'annual', label: 'Annually' },
			],
		},
		{
			name: 'delegatedToManager',
			label: 'Delegated to investment manager (UTC §807)?',
			widget: 'select',
			options: [
				{ value: 'no', label: 'No — Trustee retains management' },
				{ value: 'yes', label: 'Yes — delegated under §807' },
			],
			span: 2,
		},
		{
			name: 'managerName',
			label: 'Investment manager name',
			widget: 'text',
			required: false,
			span: 2,
			visibleWhen: { field: 'delegatedToManager', in: ['yes'] },
		},
	],
};
