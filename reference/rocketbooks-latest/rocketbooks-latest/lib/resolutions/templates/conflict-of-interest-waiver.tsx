import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Conflict of Interest Waiver — UTC §802(b)–(c) audit-defense
 * document for any related-party transaction.
 *
 * Under §802(b) a transaction between the trustee and the trust is
 * voidable by a beneficiary unless (a) the instrument expressly
 * authorizes it, (b) the beneficiary consents in writing after
 * disclosure, (c) court approval, or (d) the transaction was fair
 * to the beneficiary and the trustee can show contemporaneous fair-
 * value evidence. §802(c) extends the presumption to family
 * transactions.
 *
 * Without this document, every related-party transaction (trustee
 * compensation, trustee personal-use lease, related-borrower loan,
 * sale to/from a trustee) is exposed. This is the one-page artifact
 * that closes the exposure.
 */

const VARIABLES_SCHEMA = z.object({
	/** Plain-language description of the underlying transaction. */
	transactionDescription: z.string().min(1),
	transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Amount at stake, if material. Optional for non-dollar conflicts
	 *  (e.g., service contracts with no fixed dollar amount). */
	amountCents: z.number().int().nonnegative().optional().nullable(),
	/** The counterparty (the related party on the other side). */
	counterpartyName: z.string().min(1),
	/** Relationship of the counterparty to the trustee / trust. */
	relationship: z.enum([
		'trustee_self',         // trustee is the other side
		'co_trustee',           // co-trustee is the other side
		'trustee_family',       // trustee's spouse / child / parent / sibling
		'beneficiary',          // beneficiary (e.g., loan-to-bene, sale-to-bene)
		'beneficiary_family',   // beneficiary's family
		'trustee_business',     // entity the trustee owns/controls
		'other',
	]),
	/** Specific facts establishing the conflict (who, what relationship,
	 *  why the transaction is happening). */
	conflictDescription: z.string().min(1),
	/** Evidence the terms are fair to the trust at market. */
	fairnessEvidence: z.string().min(1),
	/** Did the qualified beneficiaries (or their representatives) give
	 *  written consent after disclosure? */
	beneficiaryConsent: z.enum(['obtained', 'not_obtained', 'not_required']),
	/** Court approval status. */
	courtApproval: z.enum(['obtained', 'not_obtained', 'not_required']),
	/** Trust-instrument citation if the trust expressly authorizes
	 *  this kind of transaction. */
	instrumentAuthority: z.string().optional().nullable(),
	/** Free-text trustee determination — the bottom-line statement
	 *  that the transaction is fair to the trust. */
	fairnessDetermination: z.string().min(1),
});

type WaiverVariables = z.infer<typeof VARIABLES_SCHEMA>;

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
		fontSize: 18,
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
	recitalBlock: { marginBottom: 14 },
	paragraph: { marginBottom: 12, textAlign: 'justify' },
	emph: { fontFamily: 'Helvetica-Bold' },
	keyValueBlock: {
		marginVertical: 14,
		paddingVertical: 10,
		paddingHorizontal: 14,
		backgroundColor: '#f1f5f9',
		borderRadius: 4,
	},
	keyValueRow: { flexDirection: 'row', marginBottom: 4 },
	keyValueKey: {
		width: 160,
		fontFamily: 'Helvetica-Bold',
		fontSize: 9.5,
		color: '#475569',
		textTransform: 'uppercase',
		letterSpacing: 0.5,
	},
	keyValueValue: { flex: 1, fontSize: 11, color: '#0f172a' },
	signaturesHeader: {
		marginTop: 36,
		marginBottom: 6,
		fontSize: 10,
		letterSpacing: 1.5,
		color: '#0f172a',
		fontFamily: 'Helvetica-Bold',
	},
	sigBlock: { marginTop: 24 },
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

const RELATIONSHIP_LABEL: Record<WaiverVariables['relationship'], string> = {
	trustee_self: 'Trustee is the counterparty',
	co_trustee: 'Co-trustee is the counterparty',
	trustee_family: 'Trustee’s family member (spouse, child, parent, sibling)',
	beneficiary: 'Beneficiary of the Trust',
	beneficiary_family: 'Beneficiary’s family member',
	trustee_business: 'Entity owned or controlled by Trustee',
	other: 'Other related party',
};

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function conflictOfInterestWaiverPdf(args: RenderArgs<WaiverVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const stateClause = trust.governingState
		? ` This Waiver is made under the laws of ${trust.governingState}.`
		: '';

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>CONFLICT OF INTEREST WAIVER</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · {formatDate(v.transactionDate)}
				</Text>
				<View style={styles.hr} />

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						The undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
						{trust.effectiveDate ? `, established ${formatDate(trust.effectiveDate)}` : ''},
						{trust.ein ? ` EIN ${trust.ein},` : ''} executes this Waiver to memorialize a related-party transaction and the basis on which the Trustee has determined it to be fair and reasonable to the Trust under Uniform Trust Code §802(b)–(c).
					</Text>
				</View>

				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Transaction</Text>
						<Text style={styles.keyValueValue}>{v.transactionDescription}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Date</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.transactionDate)}</Text>
					</View>
					{v.amountCents != null && v.amountCents > 0 && (
						<View style={styles.keyValueRow}>
							<Text style={styles.keyValueKey}>Amount</Text>
							<Text style={styles.keyValueValue}>{formatMoney(v.amountCents)}</Text>
						</View>
					)}
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Counterparty</Text>
						<Text style={styles.keyValueValue}>{v.counterpartyName}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Relationship</Text>
						<Text style={styles.keyValueValue}>{RELATIONSHIP_LABEL[v.relationship]}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Beneficiary consent</Text>
						<Text style={styles.keyValueValue}>
							{v.beneficiaryConsent === 'obtained' ? 'Obtained in writing after disclosure'
								: v.beneficiaryConsent === 'not_required' ? 'Not required (instrument or court authority)'
								: 'Not obtained (relying on fairness + disclosure)'}
						</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Court approval</Text>
						<Text style={styles.keyValueValue}>
							{v.courtApproval === 'obtained' ? 'Obtained'
								: v.courtApproval === 'not_required' ? 'Not required'
								: 'Not obtained'}
						</Text>
					</View>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>1. Disclosure of conflict.</Text> {v.conflictDescription}
					</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>2. Fairness evidence.</Text> {v.fairnessEvidence}
					</Text>
				</View>

				{v.instrumentAuthority && (
					<View style={styles.recitalBlock}>
						<Text style={styles.paragraph}>
							<Text style={styles.emph}>3. Trust instrument authority.</Text> {v.instrumentAuthority}
						</Text>
					</View>
				)}

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>{v.instrumentAuthority ? '4' : '3'}. Trustee&rsquo;s determination.</Text> Based on the foregoing, the Trustee determines that the transaction is fair and reasonable to the Trust and is in the best interests of the beneficiaries as a whole. {v.fairnessDetermination}{stateClause}
					</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>{v.instrumentAuthority ? '5' : '4'}. Reservation of beneficiary remedies.</Text> Nothing in this Waiver is intended to release the Trustee from liability for any breach of duty not specifically and adequately disclosed above. Beneficiaries retain all rights under the Trust Agreement and the Uniform Trust Code with respect to undisclosed facts.
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
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template conflict-of-interest-waiver v1
				</Text>
			</Page>
		</Document>
	);
}

export const conflictOfInterestWaiverTemplate: TemplateDefinition<WaiverVariables> = {
	id: 'conflict-of-interest-waiver',
	version: '1',
	label: 'Conflict of Interest Waiver',
	description:
		'UTC §802 audit-defense document for any related-party transaction (trustee comp, trustee personal-use lease, related-borrower loan, sale to/from related party). Without it, related-party transactions are voidable by beneficiaries.',
	category: 'governance',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: conflictOfInterestWaiverPdf,
	formFields: [
		{ name: 'transactionDescription', label: 'Transaction description', widget: 'textarea', rows: 2, span: 2 },
		{ name: 'transactionDate', label: 'Transaction date', widget: 'date' },
		{ name: 'amountCents', label: 'Amount ($) — if material', widget: 'dollars', cents: true, required: false },
		{ name: 'counterpartyName', label: 'Counterparty (related party)', widget: 'text' },
		{
			name: 'relationship',
			label: 'Relationship',
			widget: 'select',
			options: [
				{ value: 'trustee_self', label: 'Trustee is the counterparty' },
				{ value: 'co_trustee', label: 'Co-trustee is the counterparty' },
				{ value: 'trustee_family', label: 'Trustee’s family (spouse / child / parent / sibling)' },
				{ value: 'beneficiary', label: 'Beneficiary' },
				{ value: 'beneficiary_family', label: 'Beneficiary’s family' },
				{ value: 'trustee_business', label: 'Entity owned/controlled by Trustee' },
				{ value: 'other', label: 'Other related party' },
			],
		},
		{
			name: 'conflictDescription',
			label: 'Disclosure of conflict',
			widget: 'textarea',
			rows: 3,
			placeholder: 'Specific facts establishing the conflict: who, the relationship, why the transaction is happening.',
			span: 2,
		},
		{
			name: 'fairnessEvidence',
			label: 'Fairness evidence (market quotes, appraisal, comps)',
			widget: 'textarea',
			rows: 3,
			placeholder: 'Independent appraisal, market quotes from disinterested vendors, recent comparable transactions, etc.',
			span: 2,
		},
		{
			name: 'beneficiaryConsent',
			label: 'Beneficiary consent',
			widget: 'select',
			options: [
				{ value: 'obtained', label: 'Obtained in writing after disclosure' },
				{ value: 'not_obtained', label: 'Not obtained (relying on fairness + disclosure)' },
				{ value: 'not_required', label: 'Not required (instrument or court authority)' },
			],
		},
		{
			name: 'courtApproval',
			label: 'Court approval',
			widget: 'select',
			options: [
				{ value: 'not_required', label: 'Not required' },
				{ value: 'obtained', label: 'Obtained' },
				{ value: 'not_obtained', label: 'Not obtained' },
			],
		},
		{
			name: 'instrumentAuthority',
			label: 'Trust instrument authority citation (optional)',
			widget: 'text',
			required: false,
			placeholder: 'e.g., Section 7.2 of the Trust Agreement expressly permits the Trustee to compensate themselves',
			span: 2,
		},
		{
			name: 'fairnessDetermination',
			label: 'Trustee fairness determination',
			widget: 'textarea',
			rows: 3,
			placeholder: 'Bottom-line statement: why this transaction is fair to the Trust and in the beneficiaries\' best interests.',
			span: 2,
		},
	],
};
