import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * UTC §813 Initial Notice to Qualified Beneficiaries.
 *
 * UTC §813(b) imposes a STATUTORY duty on the trustee to notify
 * qualified beneficiaries of an irrevocable trust within 60 days of:
 *   (1) the trustee's acceptance of office, OR
 *   (2) the trustee's first awareness that the trust is irrevocable
 *       (e.g., the grantor's death of a previously revocable trust).
 *
 * The notice must contain:
 *   - Trust existence + identity of grantor
 *   - Trustee's name + address
 *   - Right to request a copy of the trust instrument
 *   - Right to receive annual accountings (UTC §813(a))
 *   - Identification of the trustee's compensation, if material
 *
 * Without contemporaneous §813 notice, the trustee is exposed from
 * day one — beneficiaries' statutes of limitation on breach-of-trust
 * claims do not start running until they receive proper notice. This
 * is the single most-forgotten requirement of irrevocable-trust
 * administration.
 */

const VARIABLES_SCHEMA = z.object({
	/** Trigger date — date of trustee acceptance OR date the trustee
	 *  became aware the trust is irrevocable (e.g., grantor death). */
	triggerEventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** What event triggered the §813 obligation. */
	triggerEvent: z.enum([
		'trustee_acceptance',     // a trustee just accepted office
		'grantor_death',          // revocable trust became irrevocable on grantor death
		'trust_creation',         // newly created irrevocable trust
		'awareness_event',        // trustee became aware of pre-existing irrevocable status
	]),
	/** Names of all qualified beneficiaries receiving this notice.
	 *  Multi-line, one per line. */
	qualifiedBeneficiaryNames: z.string().min(1),
	/** Notice deadline (triggerEventDate + 60 days). */
	noticeDeadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Date the notice is actually being sent. */
	noticeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Trustee's contact address (mailing address for information
	 *  requests). */
	trusteeContactAddress: z.string().min(1),
	/** Trustee's contact email + phone, optional but useful. */
	trusteeContactDetails: z.string().optional().nullable(),
	/** Trustee compensation arrangement — required disclosure under
	 *  §813(b)(4). Free text — should reference the Trustee
	 *  Compensation Resolution if one is on file. */
	compensationDisclosure: z.string().min(1),
	/** Delivery method for the notice. */
	deliveryMethod: z.enum([
		'certified_mail',
		'us_mail',
		'personal_delivery',
		'email_with_consent',
		'mixed',
	]),
	/** Names of beneficiaries excluded from notice and the
	 *  basis (e.g., minor with guardian, missing address). Optional. */
	exclusionsNoted: z.string().optional().nullable(),
});

type NoticeVariables = z.infer<typeof VARIABLES_SCHEMA>;

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
	rightsList: { marginVertical: 6 },
	rightsItem: {
		fontSize: 10.5,
		color: '#0f172a',
		marginBottom: 5,
		marginLeft: 16,
		textAlign: 'justify',
	},
	keyValueBlock: {
		marginVertical: 8,
		paddingVertical: 8,
		paddingHorizontal: 12,
		backgroundColor: '#f1f5f9',
		borderRadius: 4,
	},
	keyValueRow: { flexDirection: 'row', marginBottom: 3 },
	keyValueKey: {
		width: 160,
		fontFamily: 'Helvetica-Bold',
		fontSize: 9,
		color: '#475569',
		textTransform: 'uppercase',
		letterSpacing: 0.4,
	},
	keyValueValue: { flex: 1, fontSize: 10, color: '#0f172a' },
	beneficiaryList: {
		marginTop: 4,
		paddingLeft: 14,
	},
	beneficiaryLine: {
		fontSize: 10.5,
		color: '#0f172a',
		marginBottom: 3,
	},
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
	warningBlock: {
		marginVertical: 10,
		paddingVertical: 8,
		paddingHorizontal: 12,
		borderLeftWidth: 3,
		borderLeftColor: '#b45309',
		backgroundColor: '#fef3c7',
	},
	warningText: { fontSize: 9.5, color: '#78350f', lineHeight: 1.45 },
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

const TRIGGER_LABEL: Record<NoticeVariables['triggerEvent'], string> = {
	trustee_acceptance: 'Trustee acceptance of office',
	grantor_death: 'Trust became irrevocable on grantor\'s death',
	trust_creation: 'Creation of irrevocable trust',
	awareness_event: 'Trustee became aware that the Trust is irrevocable',
};

const DELIVERY_LABEL: Record<NoticeVariables['deliveryMethod'], string> = {
	certified_mail: 'Certified mail, return receipt requested',
	us_mail: 'First-class U.S. mail',
	personal_delivery: 'Personal delivery',
	email_with_consent: 'Email (prior beneficiary consent on file)',
	mixed: 'Mixed methods (see beneficiary roster)',
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

function utc813NoticePdf(args: RenderArgs<NoticeVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const stateClause = trust.governingState
		? ` This Notice is given under §813 of the Uniform Trust Code as enacted in ${trust.governingState}.`
		: ' This Notice is given under §813 of the Uniform Trust Code.';

	const daysFromTrigger = daysBetween(v.triggerEventDate, v.noticeDate);
	const isLate = daysFromTrigger > 60;
	const beneficiaryList = v.qualifiedBeneficiaryNames
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean);

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>NOTICE TO QUALIFIED BENEFICIARIES</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · §813 UTC · Dated {formatDate(v.noticeDate)}
				</Text>
				<View style={styles.hr} />

				<Text style={styles.intro}>
					Pursuant to Uniform Trust Code §813(b), the undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
					{trust.effectiveDate ? `, established ${formatDate(trust.effectiveDate)}` : ''}
					{trust.ein ? `, EIN ${trust.ein}` : ''}, hereby gives this Notice to the qualified beneficiaries identified below.{stateClause}
				</Text>

				<Text style={styles.sectionHeader}>1. Triggering event</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Event</Text>
						<Text style={styles.keyValueValue}>{TRIGGER_LABEL[v.triggerEvent]}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Event date</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.triggerEventDate)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Statutory deadline</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.noticeDeadline)} (60 days after event)</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Notice date</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.noticeDate)} ({daysFromTrigger} days after event)</Text>
					</View>
				</View>

				{isLate && (
					<View style={styles.warningBlock}>
						<Text style={styles.warningText}>
							<Text style={styles.emph}>Notice issued after 60-day statutory deadline.</Text> The Trustee acknowledges that this Notice was not delivered within the 60-day window prescribed by §813(b) and is issuing it as soon as practicable upon awareness of the obligation. The beneficiaries&rsquo; statute of limitations on breach-of-trust claims under §1005(a)(2) begins to run from receipt of this Notice and accompanying disclosures, not from the trigger date.
						</Text>
					</View>
				)}

				<Text style={styles.sectionHeader}>2. The Trust</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Trust name</Text>
						<Text style={styles.keyValueValue}>{trustLabel}</Text>
					</View>
					{trust.effectiveDate && (
						<View style={styles.keyValueRow}>
							<Text style={styles.keyValueKey}>Effective date</Text>
							<Text style={styles.keyValueValue}>{formatDate(trust.effectiveDate)}</Text>
						</View>
					)}
					{trust.grantorName && (
						<View style={styles.keyValueRow}>
							<Text style={styles.keyValueKey}>Grantor / Settlor</Text>
							<Text style={styles.keyValueValue}>{trust.grantorName}</Text>
						</View>
					)}
					{trust.governingState && (
						<View style={styles.keyValueRow}>
							<Text style={styles.keyValueKey}>Governing law</Text>
							<Text style={styles.keyValueValue}>{trust.governingState}</Text>
						</View>
					)}
				</View>

				<Text style={styles.sectionHeader}>3. Trustee identity &amp; contact</Text>
				<Text style={styles.body}>
					<Text style={styles.emph}>Trustee: </Text>{trustee?.expectedName ?? 'Trustee of record'}
				</Text>
				<Text style={styles.body}>
					<Text style={styles.emph}>Mailing address for information requests: </Text>{v.trusteeContactAddress}
				</Text>
				{v.trusteeContactDetails && (
					<Text style={styles.body}>{v.trusteeContactDetails}</Text>
				)}

				<Text style={styles.sectionHeader}>4. Qualified beneficiaries receiving this Notice</Text>
				<View style={styles.beneficiaryList}>
					{beneficiaryList.map((name, i) => (
						<Text key={i} style={styles.beneficiaryLine}>• {name}</Text>
					))}
				</View>

				{v.exclusionsNoted && (
					<>
						<Text style={styles.sectionHeader}>5. Exclusions / special service</Text>
						<Text style={styles.body}>{v.exclusionsNoted}</Text>
					</>
				)}

				<Text style={styles.sectionHeader}>{v.exclusionsNoted ? '6' : '5'}. Your rights under §813</Text>
				<View style={styles.rightsList}>
					<Text style={styles.rightsItem}>
						(a) <Text style={styles.emph}>Trust instrument.</Text> You have the right to request a complete copy of the Trust instrument from the Trustee.
					</Text>
					<Text style={styles.rightsItem}>
						(b) <Text style={styles.emph}>Annual accounting.</Text> You are entitled to receive, at least annually, a report of trust property, liabilities, receipts, disbursements, source and amount of trustee compensation, and a list of trust assets and their market values (UTC §813(a)).
					</Text>
					<Text style={styles.rightsItem}>
						(c) <Text style={styles.emph}>Information on request.</Text> You may request from the Trustee, in writing, additional information reasonably related to the administration of the Trust at any time.
					</Text>
					<Text style={styles.rightsItem}>
						(d) <Text style={styles.emph}>Limitation on actions.</Text> Your right to commence a proceeding against the Trustee for breach of trust is governed by §1005. The statutory limitation period begins to run from the date you receive an accounting or other report from which the alleged breach could reasonably be discerned.
					</Text>
				</View>

				<Text style={styles.sectionHeader}>{v.exclusionsNoted ? '7' : '6'}. Trustee compensation</Text>
				<Text style={styles.body}>{v.compensationDisclosure}</Text>

				<Text style={styles.sectionHeader}>{v.exclusionsNoted ? '8' : '7'}. Delivery method</Text>
				<Text style={styles.body}>This Notice is delivered by: {DELIVERY_LABEL[v.deliveryMethod]}.</Text>

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
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template utc-813-initial-notice v1
				</Text>
			</Page>
		</Document>
	);
}

export const utc813InitialNoticeTemplate: TemplateDefinition<NoticeVariables> = {
	id: 'utc-813-initial-notice',
	version: '1',
	label: 'UTC §813 Notice to Qualified Beneficiaries',
	description:
		'Statutory 60-day notice that an irrevocable trust exists and identifying the trustee, with the beneficiaries\' rights to instrument, annual accounting, and information. Required within 60 days of trustee acceptance or grantor death.',
	category: 'foundational',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: utc813NoticePdf,
	formFields: [
		{
			name: 'triggerEvent',
			label: 'Triggering event',
			widget: 'select',
			options: [
				{ value: 'trustee_acceptance', label: 'Trustee acceptance of office' },
				{ value: 'grantor_death', label: 'Grantor death (revocable → irrevocable)' },
				{ value: 'trust_creation', label: 'Creation of irrevocable trust' },
				{ value: 'awareness_event', label: 'Trustee became aware of irrevocable status' },
			],
		},
		{ name: 'triggerEventDate', label: 'Event date', widget: 'date' },
		{ name: 'noticeDeadline', label: 'Statutory deadline (event + 60 days)', widget: 'date' },
		{ name: 'noticeDate', label: 'Notice date (today or send date)', widget: 'date' },
		{
			name: 'qualifiedBeneficiaryNames',
			label: 'Qualified beneficiary names (one per line)',
			widget: 'textarea',
			rows: 5,
			placeholder: 'List every qualified beneficiary receiving this Notice. UTC §103(13) defines "qualified" — current distributees + presumptive remainder.',
			span: 2,
		},
		{
			name: 'trusteeContactAddress',
			label: 'Trustee mailing address',
			widget: 'textarea',
			rows: 2,
			placeholder: 'Address where beneficiaries can send information requests.',
			span: 2,
		},
		{
			name: 'trusteeContactDetails',
			label: 'Trustee email / phone (optional)',
			widget: 'text',
			required: false,
			span: 2,
		},
		{
			name: 'compensationDisclosure',
			label: 'Trustee compensation disclosure',
			widget: 'textarea',
			rows: 3,
			placeholder: 'Required under §813(b)(4). e.g., "The Trustee receives no compensation" OR "The Trustee receives an annual fee of $X pursuant to the Trustee Compensation Resolution dated YYYY-MM-DD, available on request."',
			span: 2,
		},
		{
			name: 'deliveryMethod',
			label: 'Delivery method',
			widget: 'select',
			span: 2,
			options: [
				{ value: 'certified_mail', label: 'Certified mail, return receipt' },
				{ value: 'us_mail', label: 'First-class U.S. mail' },
				{ value: 'personal_delivery', label: 'Personal delivery' },
				{ value: 'email_with_consent', label: 'Email (consent on file)' },
				{ value: 'mixed', label: 'Mixed methods' },
			],
		},
		{
			name: 'exclusionsNoted',
			label: 'Exclusions / special service (optional)',
			widget: 'textarea',
			rows: 2,
			required: false,
			placeholder: 'Beneficiaries excluded and basis — e.g., "Jane Doe (minor) served via guardian Mark Doe; address unknown for Sam Doe, attempting locate"',
			span: 2,
		},
	],
};
