import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Trustee Compensation Resolution (UTC §708 + §802).
 *
 * Every dollar of trustee compensation is a related-party transaction:
 * the trustee is paying themselves out of trust assets. Under UTC §802
 * that's voidable by a beneficiary unless either (a) the trust
 * instrument expressly fixes the trustee's compensation, (b) court
 * approval, or (c) the trustee makes a reasonable-compensation
 * determination under §708 with contemporaneous documentation.
 *
 * UTC §708(a): "If the terms of a trust do not specify the trustee's
 * compensation, a trustee is entitled to compensation that is
 * reasonable under the circumstances." §708(b) lets a trustee fix
 * their compensation but allows beneficiaries to petition for review.
 *
 * This is the contemporaneous artifact. Without it, every fee payment
 * is exposed. With it, the trustee has documented:
 *   - The compensation method (hourly / flat annual / percentage of
 *     assets / hybrid)
 *   - The reasonableness analysis (skills, time, complexity,
 *     comparable charges, results)
 *   - The compensation period covered
 *   - Co-trustee consent if there are co-trustees (peer review
 *     under §703(b))
 *   - Whether the trust instrument authorizes compensation
 *
 * Pair with Conflict of Interest Waiver under §802 for belt-and-
 * suspenders defense — but this resolution standing alone is the
 * §708 reasonableness record.
 */

const VARIABLES_SCHEMA = z.object({
	/** Compensation period start. */
	periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Compensation period end. */
	periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Date this resolution is being signed. */
	resolutionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Compensation method. */
	compensationMethod: z.enum([
		'hourly',
		'flat_annual',
		'percentage_of_assets',
		'percentage_of_income',
		'percentage_of_assets_and_income',
		'transaction_based',
		'hybrid',
	]),
	/** Free-text describing the method specifics (rate, fee schedule). */
	methodDetails: z.string().min(1),
	/** Total compensation for this period. */
	totalCompensationCents: z.number().int().nonnegative(),
	/** Allocation of the fee under UPIA — income, corpus, or split.
	 *  UPIA §501(4) makes one-half of the trustee's regular compensation
	 *  chargeable to income and one-half to corpus, unless the
	 *  instrument overrides. */
	upiaAllocation: z.enum(['income_50_corpus_50', 'income_only', 'corpus_only', 'custom_split']),
	/** Required when custom_split — describe the allocation. */
	allocationNarrative: z.string().optional().nullable(),
	/** Whether the trust instrument expressly addresses compensation. */
	instrumentAuthority: z.enum(['expressly_authorized', 'silent', 'expressly_prohibited']),
	/** Citation when instrument expressly authorizes (e.g., "§7.3 of
	 *  the Trust Agreement"). */
	instrumentCitation: z.string().optional().nullable(),
	/** Reasonableness narrative — the §708 analysis. */
	reasonablenessAnalysis: z.string().min(1),
	/** Are there co-trustees who must consent under §703(b)? */
	coTrusteeConsent: z.enum(['no_co_trustees', 'consent_obtained', 'consent_pending']),
	/** Whether a Conflict of Interest Waiver is paired. */
	conflictWaiverPaired: z.enum(['yes', 'no_relying_on_708']),
});

type CompensationVariables = z.infer<typeof VARIABLES_SCHEMA>;

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
		width: 170,
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

const METHOD_LABEL: Record<CompensationVariables['compensationMethod'], string> = {
	hourly: 'Hourly billing',
	flat_annual: 'Flat annual fee',
	percentage_of_assets: 'Percentage of trust assets (AUM)',
	percentage_of_income: 'Percentage of trust income',
	percentage_of_assets_and_income: 'Percentage of both assets and income',
	transaction_based: 'Transaction-based fee',
	hybrid: 'Hybrid (see method details)',
};

const UPIA_LABEL: Record<CompensationVariables['upiaAllocation'], string> = {
	income_50_corpus_50: 'Default UPIA §501(4) — 50% income, 50% corpus',
	income_only: '100% charged to income (instrument or §201(b) override)',
	corpus_only: '100% charged to corpus (instrument or §201(b) override)',
	custom_split: 'Custom split (see allocation narrative)',
};

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function trusteeCompensationPdf(args: RenderArgs<CompensationVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const stateClause = trust.governingState
		? ` This Resolution is executed under the laws of ${trust.governingState}.`
		: '';
	const expresslyProhibited = v.instrumentAuthority === 'expressly_prohibited';

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>TRUSTEE COMPENSATION RESOLUTION</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · {formatDate(v.periodStart)} – {formatDate(v.periodEnd)}
				</Text>
				<View style={styles.hr} />

				<Text style={styles.intro}>
					The undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
					{trust.ein ? ` (EIN ${trust.ein})` : ''}, having considered the criteria in Uniform Trust Code §708 and the principles of reasonableness applicable to trustee compensation, hereby resolves to fix the Trustee&rsquo;s compensation for the period stated below and to record the contemporaneous reasonableness analysis required to defeat any challenge under §802 to a related-party fee determination.{stateClause}
				</Text>

				<Text style={styles.sectionHeader}>1. Period and method</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Compensation period</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.periodStart)} – {formatDate(v.periodEnd)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Compensation method</Text>
						<Text style={styles.keyValueValue}>{METHOD_LABEL[v.compensationMethod]}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Total compensation</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.totalCompensationCents)}</Text>
					</View>
				</View>

				<Text style={styles.sectionHeader}>2. Method details</Text>
				<Text style={styles.body}>{v.methodDetails}</Text>

				<Text style={styles.sectionHeader}>3. Trust-instrument authority</Text>
				<Text style={styles.body}>
					{v.instrumentAuthority === 'expressly_authorized' &&
						`The Trust instrument expressly authorizes trustee compensation${v.instrumentCitation ? ` (${v.instrumentCitation})` : ''}. This Resolution memorializes the compensation determined under that authority for the stated period.`}
					{v.instrumentAuthority === 'silent' &&
						'The Trust instrument is silent as to trustee compensation. Pursuant to UTC §708(a), the Trustee is entitled to compensation that is reasonable under the circumstances. The reasonableness analysis is set forth below.'}
					{v.instrumentAuthority === 'expressly_prohibited' &&
						'The Trust instrument expressly prohibits trustee compensation. The Trustee acknowledges this prohibition. NO compensation is taken for this period.'}
				</Text>

				{expresslyProhibited && v.totalCompensationCents > 0 && (
					<View style={styles.warningBlock}>
						<Text style={styles.warningText}>
							<Text style={styles.emph}>Compensation/instrument conflict:</Text> The Trust instrument prohibits compensation, yet a non-zero amount is recorded. The Trustee must either reduce the compensation to zero, obtain court approval to override the instrument, or treat the amount as a reimbursement of properly documented out-of-pocket expenses rather than compensation. This Resolution does not, by itself, override the instrument.
						</Text>
					</View>
				)}

				<Text style={styles.sectionHeader}>4. Reasonableness analysis (§708)</Text>
				<Text style={styles.body}>{v.reasonablenessAnalysis}</Text>

				<Text style={styles.sectionHeader}>5. Allocation under UPIA</Text>
				<Text style={styles.body}>{UPIA_LABEL[v.upiaAllocation]}</Text>
				{v.upiaAllocation === 'custom_split' && v.allocationNarrative && (
					<Text style={styles.body}>{v.allocationNarrative}</Text>
				)}

				<Text style={styles.sectionHeader}>6. Co-trustee consent</Text>
				<Text style={styles.body}>
					{v.coTrusteeConsent === 'no_co_trustees' &&
						'There are no co-trustees serving. This Resolution is effective on the sole Trustee\'s signature.'}
					{v.coTrusteeConsent === 'consent_obtained' &&
						'All co-trustees have reviewed and consented to the compensation determined herein. Co-trustee consent signatures or separate writings are filed with the trust documentation.'}
					{v.coTrusteeConsent === 'consent_pending' &&
						'Co-trustee consent is pending and will be obtained before any compensation is paid pursuant to this Resolution. Until consent is obtained, this Resolution is conditional and no fee may be drawn.'}
				</Text>

				<Text style={styles.sectionHeader}>7. §802 fairness recital</Text>
				<Text style={styles.body}>
					The Trustee acknowledges that the determination of trustee compensation is a related-party transaction. The Trustee has determined that the compensation set forth herein is fair to the Trust and reasonable under §708, based on the foregoing analysis. {v.conflictWaiverPaired === 'yes'
						? 'A separate Conflict of Interest Waiver under §802 is paired with this Resolution for belt-and-suspenders defense.'
						: 'The Trustee relies on the §708 reasonableness determination herein and on the disclosures contained in the §813 notices and annual accountings as sufficient under §802(b)(4) (transactions made in compliance with reasonable-compensation rules).'}
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
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template trustee-compensation v1
				</Text>
			</Page>
		</Document>
	);
}

export const trusteeCompensationTemplate: TemplateDefinition<CompensationVariables> = {
	id: 'trustee-compensation',
	version: '1',
	label: 'Trustee Compensation Resolution',
	description:
		'UTC §708 reasonableness record + §802 fairness recital for any trustee compensation. Without this, every fee payment is voidable by a beneficiary. Pair with Conflict Waiver for belt-and-suspenders defense.',
	category: 'governance',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: trusteeCompensationPdf,
	formFields: [
		{ name: 'periodStart', label: 'Compensation period start', widget: 'date' },
		{ name: 'periodEnd', label: 'Compensation period end', widget: 'date' },
		{ name: 'resolutionDate', label: 'Resolution date', widget: 'date' },
		{ name: 'totalCompensationCents', label: 'Total compensation ($)', widget: 'dollars', cents: true },
		{
			name: 'compensationMethod',
			label: 'Compensation method',
			widget: 'select',
			options: [
				{ value: 'hourly', label: 'Hourly billing' },
				{ value: 'flat_annual', label: 'Flat annual fee' },
				{ value: 'percentage_of_assets', label: 'Percentage of trust assets (AUM)' },
				{ value: 'percentage_of_income', label: 'Percentage of trust income' },
				{ value: 'percentage_of_assets_and_income', label: 'Percentage of both' },
				{ value: 'transaction_based', label: 'Transaction-based' },
				{ value: 'hybrid', label: 'Hybrid' },
			],
		},
		{
			name: 'methodDetails',
			label: 'Method details',
			widget: 'textarea',
			rows: 3,
			placeholder: 'Specifics of the method: rate, schedule, caps, minimums. e.g., "$250/hr with $5,000 annual cap" or "0.5% of trust principal valued at end of period"',
			span: 2,
		},
		{
			name: 'instrumentAuthority',
			label: 'Trust-instrument authority',
			widget: 'select',
			options: [
				{ value: 'silent', label: 'Silent (default §708 governs)' },
				{ value: 'expressly_authorized', label: 'Expressly authorizes' },
				{ value: 'expressly_prohibited', label: 'Expressly prohibits' },
			],
		},
		{
			name: 'instrumentCitation',
			label: 'Instrument citation (when authorized)',
			widget: 'text',
			required: false,
			placeholder: 'e.g., "Section 7.3 of the Trust Agreement"',
			visibleWhen: { field: 'instrumentAuthority', in: ['expressly_authorized'] },
		},
		{
			name: 'reasonablenessAnalysis',
			label: 'Reasonableness analysis (§708)',
			widget: 'textarea',
			rows: 4,
			placeholder: 'Address §708 factors: trustee\'s skill and experience, time spent, complexity of trust administration, comparable fees charged by professional fiduciaries / trust companies in the area, results obtained, any unusual responsibilities. Cite specific events or workload.',
			span: 2,
		},
		{
			name: 'upiaAllocation',
			label: 'UPIA fee allocation',
			widget: 'select',
			options: [
				{ value: 'income_50_corpus_50', label: 'UPIA §501(4) default (50/50)' },
				{ value: 'income_only', label: '100% income' },
				{ value: 'corpus_only', label: '100% corpus' },
				{ value: 'custom_split', label: 'Custom split (narrative below)' },
			],
		},
		{
			name: 'allocationNarrative',
			label: 'Allocation narrative',
			widget: 'textarea',
			rows: 2,
			required: false,
			placeholder: 'Required when custom split — describe the income/corpus allocation.',
			span: 2,
			visibleWhen: { field: 'upiaAllocation', in: ['custom_split'] },
		},
		{
			name: 'coTrusteeConsent',
			label: 'Co-trustee consent (§703)',
			widget: 'select',
			options: [
				{ value: 'no_co_trustees', label: 'No co-trustees (sole trustee)' },
				{ value: 'consent_obtained', label: 'Co-trustee consent obtained' },
				{ value: 'consent_pending', label: 'Consent pending — fee not drawn until obtained' },
			],
		},
		{
			name: 'conflictWaiverPaired',
			label: 'Conflict of Interest Waiver paired?',
			widget: 'select',
			options: [
				{ value: 'no_relying_on_708', label: 'No — relying on §708 + §813 notice' },
				{ value: 'yes', label: 'Yes — belt-and-suspenders defense' },
			],
		},
	],
};
