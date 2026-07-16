import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Co-Trustee Dissent Record (UTC §703(h)).
 *
 * Under UTC §703(g)–(h): a trustee who joins in an action of the
 * co-trustees, or who fails to exercise reasonable care to prevent
 * a co-trustee from committing a breach, is jointly liable. BUT
 * §703(h) carves out: "A dissenting trustee who did not join in
 * an action of another trustee is not liable for the action."
 *
 * To rely on §703(h) the dissent must be CONTEMPORANEOUS — a verbal
 * objection at the time of the action is enough but is hard to prove
 * months or years later. This template is the contemporaneous written
 * record. Without it, a co-trustee facing a beneficiary suit over a
 * majority action has nothing to point to.
 *
 * It is short on purpose. The whole document is: identify the action,
 * record the dissent, state the basis, and confirm the dissenter took
 * no further part.
 */

const VARIABLES_SCHEMA = z.object({
	/** Date of the underlying action the dissent is from. */
	actionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Date the dissent is being recorded. Ideally same as actionDate
	 *  or within days. */
	dissentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Description of the action being dissented from. */
	actionDescription: z.string().min(1),
	/** Reference to the resolution / instrument the majority acted by
	 *  (if any) — e.g., the document_record id of the majority's
	 *  resolution, the title of the document, or a description of an
	 *  informal action. */
	actionReference: z.string().min(1),
	/** Co-trustees who took the action (the majority). One per line
	 *  or comma-separated. */
	majorityTrusteeNames: z.string().min(1),
	/** The dissenter's stated reasons. */
	dissentReasons: z.string().min(1),
	/** Whether the dissent was communicated at the time of the action
	 *  or only later (and why). */
	timingNarrative: z.enum([
		'communicated_at_action',
		'communicated_within_days',
		'communicated_later_with_explanation',
	]),
	/** Required when timing is 'later' — explanation of why. */
	timingExplanation: z.string().optional().nullable(),
	/** Whether the dissenter is taking any further steps (e.g.,
	 *  petitioning a court, formally resigning). */
	furtherAction: z.enum([
		'none_no_further_steps',
		'will_take_no_part_in_implementation',
		'considering_resignation',
		'petitioning_for_review',
		'other_see_narrative',
	]),
	/** Required for 'other' — explain. */
	furtherActionNarrative: z.string().optional().nullable(),
});

type DissentVariables = z.infer<typeof VARIABLES_SCHEMA>;

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

const TIMING_LABEL: Record<DissentVariables['timingNarrative'], string> = {
	communicated_at_action: 'Dissent was communicated to co-trustees at the time of the action',
	communicated_within_days: 'Dissent was communicated to co-trustees within days of the action',
	communicated_later_with_explanation: 'Dissent communicated later (see explanation)',
};

const FURTHER_LABEL: Record<DissentVariables['furtherAction'], string> = {
	none_no_further_steps: 'No further action — dissent is recorded for the §703(h) safe harbor only',
	will_take_no_part_in_implementation: 'Dissenter will take no part in implementation of the action',
	considering_resignation: 'Dissenter is considering resignation as trustee',
	petitioning_for_review: 'Dissenter is petitioning a court of competent jurisdiction for review',
	other_see_narrative: 'Other action (see narrative)',
};

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

function coTrusteeDissentPdf(args: RenderArgs<DissentVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const dissenter = args.signers.find((s) => s.role.toLowerCase().includes('dissenting'));
	const stateClause = trust.governingState
		? ` This Record is executed under §703(h) of the Uniform Trust Code as enacted in ${trust.governingState}.`
		: ' This Record is executed under §703(h) of the Uniform Trust Code.';

	const delayDays = daysBetween(v.actionDate, v.dissentDate);
	const isDelayed = delayDays > 7;

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>CO-TRUSTEE DISSENT RECORD</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · Dissent date {formatDate(v.dissentDate)}
				</Text>
				<View style={styles.hr} />

				<Text style={styles.intro}>
					The undersigned, a co-trustee of <Text style={styles.emph}>{trustLabel}</Text>
					{trust.ein ? ` (EIN ${trust.ein})` : ''}, hereby records the undersigned&rsquo;s dissent from the action of the majority co-trustees identified below, for the purpose of invoking the protection of Uniform Trust Code §703(h) against joint liability for the action.{stateClause}
				</Text>

				<Text style={styles.sectionHeader}>1. The action dissented from</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Action date</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.actionDate)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Action reference</Text>
						<Text style={styles.keyValueValue}>{v.actionReference}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Majority trustees</Text>
						<Text style={styles.keyValueValue}>{v.majorityTrusteeNames}</Text>
					</View>
				</View>
				<Text style={styles.body}>{v.actionDescription}</Text>

				<Text style={styles.sectionHeader}>2. Basis for dissent</Text>
				<Text style={styles.body}>{v.dissentReasons}</Text>

				<Text style={styles.sectionHeader}>3. Timing of dissent</Text>
				<Text style={styles.body}>{TIMING_LABEL[v.timingNarrative]}.</Text>
				{v.timingNarrative === 'communicated_later_with_explanation' && v.timingExplanation && (
					<Text style={styles.body}>{v.timingExplanation}</Text>
				)}
				{isDelayed && v.timingNarrative !== 'communicated_later_with_explanation' && (
					<View style={styles.warningBlock}>
						<Text style={styles.warningText}>
							<Text style={styles.emph}>Timing review:</Text> This Record is being executed {delayDays} days after the underlying action. §703(h) protection is strongest when the dissent is contemporaneous. The dissenter relies on the timing narrative above describing how and when the dissent was communicated to co-trustees prior to this written record.
						</Text>
					</View>
				)}

				<Text style={styles.sectionHeader}>4. Further action</Text>
				<Text style={styles.body}>{FURTHER_LABEL[v.furtherAction]}.</Text>
				{v.furtherAction === 'other_see_narrative' && v.furtherActionNarrative && (
					<Text style={styles.body}>{v.furtherActionNarrative}</Text>
				)}

				<Text style={styles.sectionHeader}>5. §703(h) recital</Text>
				<Text style={styles.body}>
					The undersigned did not join in the foregoing action of the majority co-trustees. The undersigned has exercised reasonable care to prevent the action or, having been unable to prevent it, has dissented as set forth herein. The undersigned invokes the protection of UTC §703(h) and does not consent to be held jointly liable for the action.
				</Text>

				<Text style={styles.signaturesHeader}>SIGNATURE</Text>

				<View style={styles.sigBlock}>
					<View style={styles.sigLineRule} />
					<Text style={styles.sigName}>{dissenter?.signedName ?? dissenter?.expectedName ?? 'Dissenting Co-Trustee'}</Text>
					<Text style={styles.sigLabel}>Dissenting Co-Trustee of {trustLabel}</Text>
					{dissenter?.signedAt && (
						<Text style={styles.sigMeta}>
							Signed {dissenter.signedAt}{dissenter.signedIp ? ` · IP ${dissenter.signedIp}` : ''}
						</Text>
					)}
				</View>

				<Text style={styles.footer}>
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template co-trustee-dissent v1
				</Text>
			</Page>
		</Document>
	);
}

export const coTrusteeDissentTemplate: TemplateDefinition<DissentVariables> = {
	id: 'co-trustee-dissent',
	version: '1',
	label: 'Co-Trustee Dissent Record',
	description:
		'UTC §703(h) record protecting a dissenting co-trustee from joint liability for a majority action. Must be contemporaneous with the action to be fully protective.',
	category: 'governance',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Dissenting Co-Trustee' }],
	requiresState: true,
	renderPdf: coTrusteeDissentPdf,
	formFields: [
		{ name: 'actionDate', label: 'Date of the action', widget: 'date' },
		{ name: 'dissentDate', label: 'Date of this dissent record', widget: 'date' },
		{
			name: 'actionReference',
			label: 'Action reference',
			widget: 'text',
			placeholder: 'e.g., "Distribution Authorization #DA-2026-014" or "Informal majority decision communicated via email 2026-05-10"',
			span: 2,
		},
		{
			name: 'actionDescription',
			label: 'Description of the action',
			widget: 'textarea',
			rows: 3,
			placeholder: 'What the majority co-trustees decided / authorized / approved.',
			span: 2,
		},
		{
			name: 'majorityTrusteeNames',
			label: 'Majority co-trustees',
			widget: 'textarea',
			rows: 2,
			placeholder: 'Names of the co-trustees who took the action (one per line or comma-separated).',
			span: 2,
		},
		{
			name: 'dissentReasons',
			label: 'Basis for dissent',
			widget: 'textarea',
			rows: 4,
			placeholder: 'Why you dissent — duty-of-loyalty concerns, prudent-investor concerns, lack of beneficiary consent, conflict-of-interest, breach of trust instrument, etc. Be specific.',
			span: 2,
		},
		{
			name: 'timingNarrative',
			label: 'Timing of dissent',
			widget: 'select',
			options: [
				{ value: 'communicated_at_action', label: 'Communicated at the time of the action' },
				{ value: 'communicated_within_days', label: 'Communicated within days of the action' },
				{ value: 'communicated_later_with_explanation', label: 'Communicated later (explain below)' },
			],
			span: 2,
		},
		{
			name: 'timingExplanation',
			label: 'Timing explanation',
			widget: 'textarea',
			rows: 2,
			required: false,
			placeholder: 'Required when dissent was communicated later — explain why (lack of notice of action, discovery only later, etc.).',
			span: 2,
			visibleWhen: { field: 'timingNarrative', in: ['communicated_later_with_explanation'] },
		},
		{
			name: 'furtherAction',
			label: 'Further action',
			widget: 'select',
			options: [
				{ value: 'none_no_further_steps', label: 'No further action — dissent recorded only' },
				{ value: 'will_take_no_part_in_implementation', label: 'Will take no part in implementation' },
				{ value: 'considering_resignation', label: 'Considering resignation' },
				{ value: 'petitioning_for_review', label: 'Petitioning court for review' },
				{ value: 'other_see_narrative', label: 'Other (narrative below)' },
			],
			span: 2,
		},
		{
			name: 'furtherActionNarrative',
			label: 'Further action narrative',
			widget: 'textarea',
			rows: 2,
			required: false,
			span: 2,
			visibleWhen: { field: 'furtherAction', in: ['other_see_narrative'] },
		},
	],
};
