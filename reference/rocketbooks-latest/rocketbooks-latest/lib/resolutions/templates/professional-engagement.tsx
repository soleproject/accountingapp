import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Professional Engagement Resolution (UTC §806).
 *
 * UTC §806 — "A trustee may incur only costs that are reasonable in
 * relation to the property, the purposes of the trust, and the
 * skills of the trustee." UTC §807 — when management is delegated,
 * the trustee must use reasonable care in (a) selecting the agent,
 * (b) establishing the scope and terms of the delegation, and (c)
 * periodically reviewing the agent's performance.
 *
 * This single template covers every professional engagement the
 * trust makes — CPA, attorney, appraiser, investment manager,
 * property manager, custodian, bookkeeper, etc. Captures the
 * scoping, fee, conflict screening, and §807 delegation analysis
 * in one document so each engagement is independently defensible.
 */

const VARIABLES_SCHEMA = z.object({
	/** Professional's name (individual or firm). */
	professionalName: z.string().min(1),
	/** Type of professional. */
	professionalRole: z.enum([
		'cpa_tax_preparer',
		'attorney',
		'appraiser',
		'investment_manager',
		'property_manager',
		'custodian',
		'bookkeeper',
		'insurance_broker',
		'financial_planner',
		'other',
	]),
	/** Engagement effective date. */
	effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Whether this is a §807 delegation (i.e., the trustee is
	 *  delegating a trustee FUNCTION) versus merely retaining
	 *  professional services (one-off advice). */
	isDelegation: z.enum(['yes_807_delegation', 'no_advisory_only']),
	/** Engagement scope — what the professional will do. */
	scopeOfWork: z.string().min(1),
	/** Fee arrangement — hourly, flat, retainer, AUM%, etc. */
	feeArrangement: z.string().min(1),
	/** Estimated annual cost. */
	estimatedAnnualCostCents: z.number().int().nonnegative(),
	/** Charge allocation under UPIA. */
	chargeAllocation: z.enum([
		'income',           // ordinary, recurring (CPA, bookkeeper)
		'corpus',           // extraordinary or capital-tied (appraiser for sale, attorney for asset acquisition)
		'split',            // some of each — detail in narrative
	]),
	/** Allocation narrative — required when 'split', encouraged otherwise. */
	allocationNarrative: z.string().optional().nullable(),
	/** Engagement is for a fixed-term or open-ended? */
	engagementTerm: z.enum(['one_time', 'annual', 'open_ended_terminable']),
	/** Selection / due-diligence narrative — the trustee's basis for
	 *  selecting this professional (licensure, experience with trusts,
	 *  references, fee comparison). */
	selectionRationale: z.string().min(1),
	/** Conflict-of-interest screen — does the professional have any
	 *  relationship to the trustee or beneficiaries that requires a
	 *  Conflict of Interest Waiver? */
	conflictScreen: z.enum(['no_conflict_disclosed', 'conflict_present_waiver_paired', 'shared_beneficial_owner']),
	/** Engagement letter on file (yes/no + reference). */
	engagementLetterReference: z.string().min(1),
});

type EngagementVariables = z.infer<typeof VARIABLES_SCHEMA>;

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

const ROLE_LABEL: Record<EngagementVariables['professionalRole'], string> = {
	cpa_tax_preparer: 'Certified Public Accountant / Tax Preparer',
	attorney: 'Attorney',
	appraiser: 'Appraiser',
	investment_manager: 'Investment Manager',
	property_manager: 'Property Manager',
	custodian: 'Custodian',
	bookkeeper: 'Bookkeeper',
	insurance_broker: 'Insurance Broker',
	financial_planner: 'Financial Planner',
	other: 'Other Professional',
};

const TERM_LABEL: Record<EngagementVariables['engagementTerm'], string> = {
	one_time: 'One-time engagement',
	annual: 'Annual engagement (renews on review)',
	open_ended_terminable: 'Open-ended, terminable on notice',
};

const ALLOCATION_LABEL: Record<EngagementVariables['chargeAllocation'], string> = {
	income: 'Income (UPIA §501 — ordinary, recurring expense)',
	corpus: 'Corpus (UPIA §502 — extraordinary or capital-tied)',
	split: 'Split between income and corpus',
};

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function professionalEngagementPdf(args: RenderArgs<EngagementVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const stateClause = trust.governingState
		? ` This Resolution is executed under the laws of ${trust.governingState}.`
		: '';
	const isDelegation = v.isDelegation === 'yes_807_delegation';
	const conflictPresent = v.conflictScreen !== 'no_conflict_disclosed';

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>PROFESSIONAL ENGAGEMENT RESOLUTION</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · {v.professionalName} · Effective {formatDate(v.effectiveDate)}
				</Text>
				<View style={styles.hr} />

				<Text style={styles.intro}>
					The undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
					{trust.ein ? ` (EIN ${trust.ein})` : ''}, in the exercise of the trustee&rsquo;s powers and consistent with the duty of prudent administration under Uniform Trust Code §§805–807, hereby resolves to engage the professional identified below.{stateClause}
				</Text>

				<Text style={styles.sectionHeader}>1. Professional engaged</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Name</Text>
						<Text style={styles.keyValueValue}>{v.professionalName}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Role</Text>
						<Text style={styles.keyValueValue}>{ROLE_LABEL[v.professionalRole]}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Engagement type</Text>
						<Text style={styles.keyValueValue}>{isDelegation ? '§807 delegation of a trustee function' : 'Professional services (advisory)'}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Term</Text>
						<Text style={styles.keyValueValue}>{TERM_LABEL[v.engagementTerm]}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Effective date</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.effectiveDate)}</Text>
					</View>
				</View>

				<Text style={styles.sectionHeader}>2. Scope of work</Text>
				<Text style={styles.body}>{v.scopeOfWork}</Text>

				<Text style={styles.sectionHeader}>3. Fees</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Fee arrangement</Text>
						<Text style={styles.keyValueValue}>{v.feeArrangement}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Estimated annual cost</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.estimatedAnnualCostCents)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Charge to</Text>
						<Text style={styles.keyValueValue}>{ALLOCATION_LABEL[v.chargeAllocation]}</Text>
					</View>
				</View>
				{v.allocationNarrative && (
					<Text style={styles.body}>{v.allocationNarrative}</Text>
				)}

				<Text style={styles.sectionHeader}>4. Selection &amp; due diligence</Text>
				<Text style={styles.body}>{v.selectionRationale}</Text>

				<Text style={styles.sectionHeader}>5. Conflict-of-interest screen</Text>
				<Text style={styles.body}>
					{v.conflictScreen === 'no_conflict_disclosed' &&
						'The Trustee has inquired of the professional and is unaware of any relationship to the Trustee, the beneficiaries, or related parties of the Trust that would constitute a conflict of interest. The professional is independent.'}
					{v.conflictScreen === 'conflict_present_waiver_paired' &&
						'The professional has a relationship to the Trustee, the beneficiaries, or a related party of the Trust that constitutes a conflict of interest. A separate Conflict of Interest Waiver under UTC §802(b)–(c) is paired with this Resolution and memorializes the disclosure, the fairness evidence, and the Trustee\'s determination that the engagement is in the Trust\'s best interests notwithstanding the conflict.'}
					{v.conflictScreen === 'shared_beneficial_owner' &&
						'The professional and a beneficiary share a related-party or beneficial ownership relationship. The Trustee has determined that the engagement is in the Trust\'s best interests and a Conflict of Interest Waiver is paired with this Resolution.'}
				</Text>

				<Text style={styles.sectionHeader}>6. Engagement letter</Text>
				<Text style={styles.body}>{v.engagementLetterReference}</Text>

				{isDelegation && (
					<>
						<Text style={styles.sectionHeader}>7. §807 delegation framework</Text>
						<Text style={styles.body}>
							In delegating the foregoing trustee function under UTC §807, the Trustee shall (a) periodically review the agent&rsquo;s actions and performance, including specific transactions undertaken pursuant to this delegation; (b) require periodic written reports from the agent in a form sufficient to permit the Trustee&rsquo;s review; (c) act to remedy any failures and, if warranted, terminate the delegation; and (d) retain the duty to select, monitor, and replace the agent. The agent is subject to the same standard of care as the Trustee with respect to the delegated function.
						</Text>
					</>
				)}

				{conflictPresent && (
					<View style={styles.warningBlock}>
						<Text style={styles.warningText}>
							<Text style={styles.emph}>Conflict on file:</Text> A Conflict of Interest Waiver must accompany this Resolution and be archived in the trust documentation set. Absence of the waiver leaves this engagement voidable by a beneficiary under UTC §802(b).
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
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template professional-engagement v1
				</Text>
			</Page>
		</Document>
	);
}

export const professionalEngagementTemplate: TemplateDefinition<EngagementVariables> = {
	id: 'professional-engagement',
	version: '1',
	label: 'Professional Engagement Resolution',
	description:
		'UTC §806–807 engagement of a CPA, attorney, appraiser, property manager, or other professional. Captures scope, fees, charge allocation, selection due diligence, and conflict screening.',
	category: 'governance',
	variablesSchema: VARIABLES_SCHEMA,
	requiresState: true,
	requiredSignerRoles: [{ role: 'Trustee' }],
	renderPdf: professionalEngagementPdf,
	formFields: [
		{ name: 'professionalName', label: 'Professional / firm name', widget: 'text', span: 2 },
		{
			name: 'professionalRole',
			label: 'Role',
			widget: 'select',
			options: [
				{ value: 'cpa_tax_preparer', label: 'CPA / Tax preparer' },
				{ value: 'attorney', label: 'Attorney' },
				{ value: 'appraiser', label: 'Appraiser' },
				{ value: 'investment_manager', label: 'Investment manager' },
				{ value: 'property_manager', label: 'Property manager' },
				{ value: 'custodian', label: 'Custodian' },
				{ value: 'bookkeeper', label: 'Bookkeeper' },
				{ value: 'insurance_broker', label: 'Insurance broker' },
				{ value: 'financial_planner', label: 'Financial planner' },
				{ value: 'other', label: 'Other' },
			],
		},
		{ name: 'effectiveDate', label: 'Effective date', widget: 'date' },
		{
			name: 'isDelegation',
			label: 'Engagement type',
			widget: 'select',
			options: [
				{ value: 'no_advisory_only', label: 'Professional services (advisory only)' },
				{ value: 'yes_807_delegation', label: '§807 delegation of a trustee function' },
			],
		},
		{
			name: 'engagementTerm',
			label: 'Term',
			widget: 'select',
			options: [
				{ value: 'one_time', label: 'One-time engagement' },
				{ value: 'annual', label: 'Annual engagement (renewable)' },
				{ value: 'open_ended_terminable', label: 'Open-ended (terminable on notice)' },
			],
		},
		{
			name: 'scopeOfWork',
			label: 'Scope of work',
			widget: 'textarea',
			rows: 3,
			placeholder: 'What the professional will do, deliverables, deadlines.',
			span: 2,
		},
		{
			name: 'feeArrangement',
			label: 'Fee arrangement',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "Hourly at $X with $Y not-to-exceed", "0.85% AUM annually billed quarterly", "8% of monthly gross rents"',
			span: 2,
		},
		{ name: 'estimatedAnnualCostCents', label: 'Estimated annual cost ($)', widget: 'dollars', cents: true },
		{
			name: 'chargeAllocation',
			label: 'Charge allocation (UPIA)',
			widget: 'select',
			options: [
				{ value: 'income', label: 'Income (ordinary, recurring)' },
				{ value: 'corpus', label: 'Corpus (extraordinary or capital-tied)' },
				{ value: 'split', label: 'Split between income and corpus' },
			],
		},
		{
			name: 'allocationNarrative',
			label: 'Allocation narrative',
			widget: 'textarea',
			rows: 2,
			required: false,
			placeholder: 'Required when split — explain which portion of the fees go to income vs corpus.',
			span: 2,
		},
		{
			name: 'selectionRationale',
			label: 'Selection / due diligence',
			widget: 'textarea',
			rows: 3,
			placeholder: 'Licensure, experience with trusts, references, fee comparison vs alternatives, fit with the engagement scope.',
			span: 2,
		},
		{
			name: 'conflictScreen',
			label: 'Conflict-of-interest screen',
			widget: 'select',
			span: 2,
			options: [
				{ value: 'no_conflict_disclosed', label: 'No conflict disclosed (independent)' },
				{ value: 'conflict_present_waiver_paired', label: 'Conflict present — Conflict Waiver paired' },
				{ value: 'shared_beneficial_owner', label: 'Shared beneficial owner — Conflict Waiver paired' },
			],
		},
		{
			name: 'engagementLetterReference',
			label: 'Engagement letter reference',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "Engagement letter dated 2026-05-15, attached to this Resolution and archived in trust documentation"',
			span: 2,
		},
	],
};
