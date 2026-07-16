import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Litigation Authorization Resolution (UTC §816(16) + §817).
 *
 * UTC §816(16) gives the trustee the power to "prosecute, defend,
 * or settle" claims involving the trust. §817(a)(2) lets the trustee
 * compromise claims to "facilitate the administration of the trust."
 *
 * BUT — litigation depletes trust assets, exposes the trust to
 * counterclaims, and may need beneficiary notice under §813. Every
 * litigation decision should be backed by:
 *   - The basis for prosecuting / defending / settling
 *   - The counsel engaged (cross-reference Professional Engagement)
 *   - A litigation budget (so settlement isn't an afterthought)
 *   - Notice to qualified beneficiaries when the matter is material
 *
 * Without this resolution, a settlement signed by the trustee can be
 * attacked years later as a breach of fiduciary duty (no documented
 * decision basis), and an adverse judgment is exposed as a §1005
 * breach.
 */

const VARIABLES_SCHEMA = z.object({
	/** Posture of the matter — what the trust is doing. */
	posture: z.enum([
		'prosecute_offensive_claim',     // trust suing someone
		'defend_against_claim',           // trust being sued
		'settle_or_compromise',           // accepting / proposing settlement
		'appeal',                         // appellate proceeding
		'enforce_judgment',               // collection actions
		'pre_litigation_demand',          // demand letter / negotiations before suit
	]),
	/** Matter caption / title. */
	matterTitle: z.string().min(1),
	/** Court or forum. */
	courtOrForum: z.string().min(1),
	/** Counterparty / opposing party. */
	counterparty: z.string().min(1),
	/** Is the counterparty a related party? */
	counterpartyIsRelatedParty: z.enum(['no', 'yes_beneficiary', 'yes_trustee', 'yes_family', 'yes_business_affiliate']),
	/** Claim or amount at stake — dollar exposure if quantifiable. */
	amountAtStakeCents: z.number().int().nonnegative().optional().nullable(),
	/** Decision being authorized. */
	authorizedAction: z.string().min(1),
	/** Counsel engaged for the matter. */
	counselName: z.string().min(1),
	/** Reference to Professional Engagement Resolution. */
	counselEngagementReference: z.string().min(1),
	/** Estimated total litigation budget (cents). */
	budgetCents: z.number().int().nonnegative(),
	/** Decision basis — why the trustee has determined this is the
	 *  best path for the Trust. */
	decisionBasis: z.string().min(1),
	/** Alternative dispute resolution considered. */
	adrConsidered: z.enum(['not_applicable', 'considered_and_rejected', 'in_progress', 'completed_failed', 'agreed_to_proceed']),
	/** ADR narrative when considered/rejected/in progress. */
	adrNarrative: z.string().optional().nullable(),
	/** Beneficiary notice status — material litigation must be
	 *  disclosed under §813. */
	beneficiaryNotice: z.enum(['not_material_no_notice', 'notice_given', 'notice_pending', 'notice_waived']),
	/** Notice narrative. */
	noticeNarrative: z.string().optional().nullable(),
	/** UPIA allocation of legal fees — generally income (UPIA §501)
	 *  unless the litigation is to defend or recover principal, in
	 *  which case corpus (§502). */
	upiaAllocation: z.enum(['income_ordinary', 'corpus_extraordinary', 'split']),
	/** Allocation narrative. */
	allocationNarrative: z.string().optional().nullable(),
});

type LitigationVariables = z.infer<typeof VARIABLES_SCHEMA>;

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
		width: 165,
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

const POSTURE_LABEL: Record<LitigationVariables['posture'], string> = {
	prosecute_offensive_claim: 'Prosecute offensive claim (Trust as plaintiff)',
	defend_against_claim: 'Defend against claim (Trust as defendant)',
	settle_or_compromise: 'Settle or compromise pending claim',
	appeal: 'Appeal of prior judgment',
	enforce_judgment: 'Enforce judgment / collection',
	pre_litigation_demand: 'Pre-litigation demand / negotiation',
};

const RELATED_PARTY_LABEL: Record<LitigationVariables['counterpartyIsRelatedParty'], string> = {
	no: 'Arm\'s-length / unrelated',
	yes_beneficiary: 'Beneficiary of the Trust',
	yes_trustee: 'Co-trustee of the Trust',
	yes_family: 'Family member of a trustee or beneficiary',
	yes_business_affiliate: 'Business affiliate of a trustee or beneficiary',
};

const ADR_LABEL: Record<LitigationVariables['adrConsidered'], string> = {
	not_applicable: 'Not applicable to this matter',
	considered_and_rejected: 'Considered and rejected (see narrative)',
	in_progress: 'ADR in progress concurrently',
	completed_failed: 'ADR previously attempted and failed',
	agreed_to_proceed: 'Parties agreed to proceed with ADR (mediation/arbitration)',
};

const NOTICE_LABEL: Record<LitigationVariables['beneficiaryNotice'], string> = {
	not_material_no_notice: 'Matter not material — no §813 notice required',
	notice_given: 'Notice given to qualified beneficiaries',
	notice_pending: 'Notice will be given (in progress)',
	notice_waived: 'Notice waived by all qualified beneficiaries in writing',
};

const ALLOCATION_LABEL: Record<LitigationVariables['upiaAllocation'], string> = {
	income_ordinary: 'Income (UPIA §501) — ordinary legal expenses',
	corpus_extraordinary: 'Corpus (UPIA §502) — defense or recovery of principal',
	split: 'Split between income and corpus (see narrative)',
};

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function litigationAuthorizationPdf(args: RenderArgs<LitigationVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const stateClause = trust.governingState
		? ` This Resolution is executed under the laws of ${trust.governingState}.`
		: '';
	const isRelated = v.counterpartyIsRelatedParty !== 'no';

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>LITIGATION AUTHORIZATION RESOLUTION</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · {POSTURE_LABEL[v.posture]}
				</Text>
				<View style={styles.hr} />

				<Text style={styles.intro}>
					The undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
					{trust.ein ? ` (EIN ${trust.ein})` : ''}, exercising the powers granted under Uniform Trust Code §816(16) (prosecute, defend, or settle) and §817 (claims against and by the Trust), hereby resolves to take the action described below.{stateClause}
				</Text>

				<Text style={styles.sectionHeader}>1. Matter</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Matter</Text>
						<Text style={styles.keyValueValue}>{v.matterTitle}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Court / forum</Text>
						<Text style={styles.keyValueValue}>{v.courtOrForum}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Posture</Text>
						<Text style={styles.keyValueValue}>{POSTURE_LABEL[v.posture]}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Counterparty</Text>
						<Text style={styles.keyValueValue}>{v.counterparty}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Relationship</Text>
						<Text style={styles.keyValueValue}>{RELATED_PARTY_LABEL[v.counterpartyIsRelatedParty]}</Text>
					</View>
					{v.amountAtStakeCents != null && v.amountAtStakeCents > 0 && (
						<View style={styles.keyValueRow}>
							<Text style={styles.keyValueKey}>Amount at stake</Text>
							<Text style={styles.keyValueValue}>{formatMoney(v.amountAtStakeCents)}</Text>
						</View>
					)}
				</View>

				<Text style={styles.sectionHeader}>2. Authorized action</Text>
				<Text style={styles.body}>{v.authorizedAction}</Text>

				<Text style={styles.sectionHeader}>3. Counsel</Text>
				<Text style={styles.body}>
					<Text style={styles.emph}>Counsel of record: </Text>{v.counselName}
				</Text>
				<Text style={styles.body}>{v.counselEngagementReference}</Text>

				<Text style={styles.sectionHeader}>4. Budget</Text>
				<Text style={styles.body}>
					The Trustee approves a litigation budget of <Text style={styles.emph}>{formatMoney(v.budgetCents)}</Text> for the matter, inclusive of attorney fees, expert fees, court costs, and ancillary expenses. Budget overruns require a supplemental authorization.
				</Text>

				<Text style={styles.sectionHeader}>5. Decision basis</Text>
				<Text style={styles.body}>{v.decisionBasis}</Text>

				<Text style={styles.sectionHeader}>6. Alternative dispute resolution</Text>
				<Text style={styles.body}>{ADR_LABEL[v.adrConsidered]}.</Text>
				{v.adrNarrative && (
					<Text style={styles.body}>{v.adrNarrative}</Text>
				)}

				<Text style={styles.sectionHeader}>7. Beneficiary notice (§813)</Text>
				<Text style={styles.body}>{NOTICE_LABEL[v.beneficiaryNotice]}.</Text>
				{v.noticeNarrative && (
					<Text style={styles.body}>{v.noticeNarrative}</Text>
				)}

				<Text style={styles.sectionHeader}>8. UPIA allocation</Text>
				<Text style={styles.body}>{ALLOCATION_LABEL[v.upiaAllocation]}</Text>
				{v.upiaAllocation === 'split' && v.allocationNarrative && (
					<Text style={styles.body}>{v.allocationNarrative}</Text>
				)}

				{isRelated && (
					<View style={styles.warningBlock}>
						<Text style={styles.warningText}>
							<Text style={styles.emph}>Related-party adversary:</Text> The Trust&rsquo;s litigation adversary is a related party. Conflict-of-interest review under UTC §802 is required. A separate Conflict of Interest Waiver must accompany this Resolution, addressing whether the Trustee can faithfully discharge fiduciary duties despite the relationship, or whether independent counsel / court direction should be obtained.
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
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template litigation-authorization v1
				</Text>
			</Page>
		</Document>
	);
}

export const litigationAuthorizationTemplate: TemplateDefinition<LitigationVariables> = {
	id: 'litigation-authorization',
	version: '1',
	label: 'Litigation Authorization Resolution',
	description:
		'UTC §816(16) + §817 authorization to prosecute, defend, settle, appeal, or enforce a claim. Captures posture, counsel + engagement reference, budget, decision basis, ADR consideration, §813 beneficiary notice, and UPIA fee allocation.',
	category: 'governance',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: litigationAuthorizationPdf,
	formFields: [
		{
			name: 'posture',
			label: 'Litigation posture',
			widget: 'select',
			options: [
				{ value: 'prosecute_offensive_claim', label: 'Prosecute (Trust as plaintiff)' },
				{ value: 'defend_against_claim', label: 'Defend (Trust as defendant)' },
				{ value: 'settle_or_compromise', label: 'Settle / compromise' },
				{ value: 'appeal', label: 'Appeal' },
				{ value: 'enforce_judgment', label: 'Enforce judgment' },
				{ value: 'pre_litigation_demand', label: 'Pre-litigation demand' },
			],
		},
		{ name: 'amountAtStakeCents', label: 'Amount at stake ($)', widget: 'dollars', cents: true, required: false },
		{
			name: 'matterTitle',
			label: 'Matter title / caption',
			widget: 'text',
			placeholder: 'e.g., "Smith Family Beneficial Trust v. ABC Contractors, Case No. 2026-CV-1234"',
			span: 2,
		},
		{
			name: 'courtOrForum',
			label: 'Court / forum',
			widget: 'text',
			placeholder: 'e.g., "Travis County District Court, Texas" or "American Arbitration Association"',
			span: 2,
		},
		{ name: 'counterparty', label: 'Counterparty', widget: 'text', span: 2 },
		{
			name: 'counterpartyIsRelatedParty',
			label: 'Counterparty relationship',
			widget: 'select',
			span: 2,
			options: [
				{ value: 'no', label: 'Arm\'s-length' },
				{ value: 'yes_beneficiary', label: 'Beneficiary' },
				{ value: 'yes_trustee', label: 'Co-trustee' },
				{ value: 'yes_family', label: 'Family of trustee/beneficiary' },
				{ value: 'yes_business_affiliate', label: 'Business affiliate' },
			],
		},
		{
			name: 'authorizedAction',
			label: 'Action authorized',
			widget: 'textarea',
			rows: 3,
			placeholder: 'Specifically what the Trustee is authorized to do — e.g., "file complaint, conduct discovery, mediate, settle for up to $X without further authorization"',
			span: 2,
		},
		{ name: 'counselName', label: 'Counsel of record', widget: 'text' },
		{ name: 'budgetCents', label: 'Litigation budget ($)', widget: 'dollars', cents: true },
		{
			name: 'counselEngagementReference',
			label: 'Counsel engagement reference',
			widget: 'textarea',
			rows: 2,
			placeholder: 'e.g., "Engagement letter with Smith Law LLP dated YYYY-MM-DD; Professional Engagement Resolution dated YYYY-MM-DD on file"',
			span: 2,
		},
		{
			name: 'decisionBasis',
			label: 'Decision basis',
			widget: 'textarea',
			rows: 4,
			placeholder: 'Why this is the best path for the Trust — likelihood of success, risk-adjusted exposure, opportunity cost, beneficiary interests. Be specific.',
			span: 2,
		},
		{
			name: 'adrConsidered',
			label: 'Alternative dispute resolution',
			widget: 'select',
			options: [
				{ value: 'not_applicable', label: 'Not applicable' },
				{ value: 'considered_and_rejected', label: 'Considered and rejected' },
				{ value: 'in_progress', label: 'ADR in progress' },
				{ value: 'completed_failed', label: 'ADR previously failed' },
				{ value: 'agreed_to_proceed', label: 'Parties agreed to ADR' },
			],
		},
		{
			name: 'adrNarrative',
			label: 'ADR narrative',
			widget: 'textarea',
			rows: 2,
			required: false,
			placeholder: 'Required when considered, in progress, or failed.',
			span: 2,
			visibleWhen: { field: 'adrConsidered', in: ['considered_and_rejected', 'in_progress', 'completed_failed', 'agreed_to_proceed'] },
		},
		{
			name: 'beneficiaryNotice',
			label: 'Beneficiary notice (§813)',
			widget: 'select',
			span: 2,
			options: [
				{ value: 'not_material_no_notice', label: 'Not material — no notice required' },
				{ value: 'notice_given', label: 'Notice given' },
				{ value: 'notice_pending', label: 'Notice pending' },
				{ value: 'notice_waived', label: 'Notice waived in writing' },
			],
		},
		{
			name: 'noticeNarrative',
			label: 'Notice narrative',
			widget: 'textarea',
			rows: 2,
			required: false,
			placeholder: 'Date notice was given, method of delivery, beneficiaries notified.',
			span: 2,
			visibleWhen: { field: 'beneficiaryNotice', in: ['notice_given', 'notice_pending', 'notice_waived'] },
		},
		{
			name: 'upiaAllocation',
			label: 'UPIA fee allocation',
			widget: 'select',
			options: [
				{ value: 'income_ordinary', label: 'Income — ordinary' },
				{ value: 'corpus_extraordinary', label: 'Corpus — defense/recovery of principal' },
				{ value: 'split', label: 'Split (narrative below)' },
			],
		},
		{
			name: 'allocationNarrative',
			label: 'Allocation narrative',
			widget: 'textarea',
			rows: 2,
			required: false,
			span: 2,
			visibleWhen: { field: 'upiaAllocation', in: ['split'] },
		},
	],
};
