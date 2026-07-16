import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Decanting Resolution.
 *
 * Decanting is the trustee's exercise of a power (statutory or
 * instrument-granted) to distribute trust principal to a NEW trust
 * with modified terms — effectively a fiduciary "do-over" that can
 * fix scrivener errors, add or remove powers of appointment, modify
 * administrative provisions, address tax-law changes, or extend the
 * trust duration in perpetuity-friendly jurisdictions.
 *
 * It is one of the most powerful — and dangerous — actions a trustee
 * can take. Done right, it modernizes an otherwise irrevocable trust
 * for changed circumstances. Done wrong, it can be characterized as
 * a self-dealing breach (§802), can create gift-tax exposure if the
 * beneficial interests change, can blow up GST-exempt status, and
 * can lose grandfathered tax positions.
 *
 * Statutes vary widely by state:
 *   - DE, NV, SD, NH, AK, TN, WY have very broad decanting statutes
 *     (DE 12 §3528 is the gold standard — power to distribute
 *     principal to a new trust if the trustee has discretionary
 *     distribution power, with broad latitude to modify terms)
 *   - Other UTC-jurisdiction states have the Uniform Trust Decanting
 *     Act (UTDA, 2015), which is narrower but more uniform
 *   - A few states have NO decanting statute and rely on common-law
 *     analysis or court approval
 *
 * §818 of the Uniform Trust Code (in 2024 amendments) added a default
 * decanting power, but adoption is uneven.
 *
 * This template captures the trustee's contemporaneous record of:
 *   - The statutory or instrument basis for the decanting
 *   - Source trust + recipient trust identities (with the recipient
 *     trust being executed concurrently or already in existence)
 *   - Material changes between source and recipient terms
 *   - Beneficial-interest impact analysis (CRITICAL — material
 *     changes to beneficial interests can void the decanting and
 *     trigger gift / GST consequences)
 *   - Fiduciary duty determination
 *   - Notice to qualified beneficiaries (UTDA §7 / state statute)
 *   - Tax-position preservation analysis
 */

const VARIABLES_SCHEMA = z.object({
	/** Statutory basis for the decanting. */
	statutoryBasis: z.enum([
		'state_statute',           // e.g., DE 12 §3528, NV NRS 163.556
		'utda',                     // Uniform Trust Decanting Act
		'utc_818',                  // UTC §818 default decanting power
		'instrument_express_power', // trust agreement expressly grants
		'common_law',               // no statute — common-law analysis
		'court_approval',           // proceeding for court approval
	]),
	/** Citation of the statute / instrument provision. */
	authorityCitation: z.string().min(1),
	/** Effective date of the decanting. */
	effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Recipient trust name. */
	recipientTrustName: z.string().min(1),
	/** Recipient trust effective date / execution date. */
	recipientTrustEffectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Whether the recipient trust is a brand-new trust, an existing
	 *  trust, or a "naked" decanting trust created to receive the
	 *  decanted assets. */
	recipientTrustStatus: z.enum(['newly_created', 'existing_trust', 'created_for_decanting']),
	/** Purpose / motivation for the decanting. */
	decantingPurpose: z.string().min(1),
	/** Categorical taxonomy of what's changing. */
	changeCategories: z.string().min(1),
	/** Narrative description of MATERIAL CHANGES. */
	materialChangesNarrative: z.string().min(1),
	/** Whether beneficial interests are modified. The defining
	 *  question for whether the decanting is "decanting" vs an
	 *  illegal modification masquerading as decanting. */
	beneficialInterestsChanged: z.enum([
		'no_identical',                          // beneficiaries + shares identical
		'no_administrative_only',                // changes are admin / governance only
		'yes_narrowing_class',                   // recipient class is subset of source class
		'yes_broadening_class',                  // recipient class is broader (HIGH RISK)
		'yes_shifting_interests',                // remainder vs current rebalanced (HIGH RISK)
	]),
	/** Beneficial-interest analysis narrative. */
	beneficialInterestsAnalysis: z.string().min(1),
	/** Tax positions being preserved or modified. */
	taxAnalysis: z.string().min(1),
	/** Notice to qualified beneficiaries — UTDA §7 / state statute
	 *  generally requires 60–90 days advance notice. */
	beneficiaryNotice: z.enum(['notice_given', 'notice_pending', 'notice_waived', 'no_notice_required']),
	/** Notice narrative. */
	noticeNarrative: z.string().min(1),
	/** Asset transfer description — what's being moved. */
	assetTransferDescription: z.string().min(1),
});

type DecantingVariables = z.infer<typeof VARIABLES_SCHEMA>;

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
		width: 175,
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
	dangerBlock: {
		marginVertical: 10,
		paddingVertical: 8,
		paddingHorizontal: 12,
		borderLeftWidth: 3,
		borderLeftColor: '#b91c1c',
		backgroundColor: '#fee2e2',
	},
	dangerText: { fontSize: 9.5, color: '#7f1d1d', lineHeight: 1.45 },
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

const BASIS_LABEL: Record<DecantingVariables['statutoryBasis'], string> = {
	state_statute: 'State decanting statute',
	utda: 'Uniform Trust Decanting Act (2015)',
	utc_818: 'UTC §818 default decanting power',
	instrument_express_power: 'Express decanting power in trust instrument',
	common_law: 'Common-law analysis (no statute available)',
	court_approval: 'Court approval / instructions',
};

const RECIPIENT_STATUS_LABEL: Record<DecantingVariables['recipientTrustStatus'], string> = {
	newly_created: 'Newly created trust',
	existing_trust: 'Existing trust',
	created_for_decanting: 'Created concurrently for the purpose of receiving the decanting',
};

const INTEREST_CHANGE_LABEL: Record<DecantingVariables['beneficialInterestsChanged'], string> = {
	no_identical: 'No — beneficiaries and shares identical to source',
	no_administrative_only: 'No — changes are administrative / governance only',
	yes_narrowing_class: 'Yes — recipient class is a subset of source class',
	yes_broadening_class: 'Yes — recipient class is broader than source',
	yes_shifting_interests: 'Yes — current / remainder interests rebalanced',
};

const NOTICE_LABEL: Record<DecantingVariables['beneficiaryNotice'], string> = {
	notice_given: 'Statutory notice given to qualified beneficiaries (notice period expired)',
	notice_pending: 'Notice given, notice period running',
	notice_waived: 'Notice waived in writing by all qualified beneficiaries',
	no_notice_required: 'No notice required under applicable statute or instrument',
};

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function decantingResolutionPdf(args: RenderArgs<DecantingVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Source Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const stateClause = trust.governingState
		? ` This Resolution is executed under the laws of ${trust.governingState}.`
		: '';

	const highRiskChange = v.beneficialInterestsChanged === 'yes_broadening_class' || v.beneficialInterestsChanged === 'yes_shifting_interests';
	const anyChange = v.beneficialInterestsChanged !== 'no_identical' && v.beneficialInterestsChanged !== 'no_administrative_only';

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>DECANTING RESOLUTION</Text>
				<Text style={styles.subtitle}>
					{trustLabel} → {v.recipientTrustName} · Effective {formatDate(v.effectiveDate)}
				</Text>
				<View style={styles.hr} />

				<Text style={styles.intro}>
					The undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
					{trust.ein ? ` (EIN ${trust.ein})` : ''} hereby exercises the power to distribute trust principal to a new trust pursuant to {BASIS_LABEL[v.statutoryBasis]} and records the contemporaneous fiduciary determination supporting the action.{stateClause}
				</Text>

				<Text style={styles.sectionHeader}>1. Authority</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Statutory basis</Text>
						<Text style={styles.keyValueValue}>{BASIS_LABEL[v.statutoryBasis]}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Citation</Text>
						<Text style={styles.keyValueValue}>{v.authorityCitation}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Effective date</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.effectiveDate)}</Text>
					</View>
				</View>

				<Text style={styles.sectionHeader}>2. Source &amp; recipient trusts</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Source trust</Text>
						<Text style={styles.keyValueValue}>{trustLabel}{trust.effectiveDate ? ` (effective ${formatDate(trust.effectiveDate)})` : ''}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Recipient trust</Text>
						<Text style={styles.keyValueValue}>{v.recipientTrustName} (effective {formatDate(v.recipientTrustEffectiveDate)})</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Recipient status</Text>
						<Text style={styles.keyValueValue}>{RECIPIENT_STATUS_LABEL[v.recipientTrustStatus]}</Text>
					</View>
				</View>

				<Text style={styles.sectionHeader}>3. Purpose</Text>
				<Text style={styles.body}>{v.decantingPurpose}</Text>

				<Text style={styles.sectionHeader}>4. Changes from source to recipient</Text>
				<Text style={styles.body}>
					<Text style={styles.emph}>Change categories: </Text>{v.changeCategories}
				</Text>
				<Text style={styles.body}>{v.materialChangesNarrative}</Text>

				<Text style={styles.sectionHeader}>5. Beneficial-interest analysis</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Interest change</Text>
						<Text style={styles.keyValueValue}>{INTEREST_CHANGE_LABEL[v.beneficialInterestsChanged]}</Text>
					</View>
				</View>
				<Text style={styles.body}>{v.beneficialInterestsAnalysis}</Text>

				{highRiskChange && (
					<View style={styles.dangerBlock}>
						<Text style={styles.dangerText}>
							<Text style={styles.emph}>High-risk beneficial-interest change.</Text> Material modifications to beneficiaries&rsquo; interests can (i) exceed the trustee&rsquo;s decanting authority under the applicable statute, voiding the decanting; (ii) constitute a taxable gift by a beneficiary who consents to a reduction of their interest; (iii) lose grandfathered GST-exempt status; and (iv) trigger §661 distribution-deduction treatment of the entire decanted corpus. The Trustee MUST confirm with qualified tax counsel that the specific change is within the applicable statute and does not produce these consequences before this Resolution is acted upon.
						</Text>
					</View>
				)}

				{anyChange && !highRiskChange && (
					<View style={styles.warningBlock}>
						<Text style={styles.warningText}>
							<Text style={styles.emph}>Beneficial-interest change present.</Text> Even a narrowing of the beneficiary class can have tax consequences. The Trustee has confirmed with qualified tax counsel that the change is within the applicable decanting authority.
						</Text>
					</View>
				)}

				<Text style={styles.sectionHeader}>6. Tax-position analysis</Text>
				<Text style={styles.body}>{v.taxAnalysis}</Text>

				<Text style={styles.sectionHeader}>7. Beneficiary notice</Text>
				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Notice status</Text>
						<Text style={styles.keyValueValue}>{NOTICE_LABEL[v.beneficiaryNotice]}</Text>
					</View>
				</View>
				<Text style={styles.body}>{v.noticeNarrative}</Text>

				<Text style={styles.sectionHeader}>8. Asset transfer</Text>
				<Text style={styles.body}>{v.assetTransferDescription}</Text>

				<Text style={styles.sectionHeader}>9. Fiduciary determination</Text>
				<Text style={styles.body}>
					The Trustee, having considered the beneficiaries&rsquo; interests, the purposes of the Trust, the applicable statutory framework, and the tax consequences identified above, determines that the decanting set forth herein (i) is within the Trustee&rsquo;s authority, (ii) is consistent with the purposes of the Trust, (iii) is in the best interests of the beneficiaries as a whole, and (iv) does not constitute an improper modification of beneficial interests. The Trustee directs that the assets identified in Section 8 be transferred from the Source Trust to the Recipient Trust as of the Effective Date.
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
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template decanting-resolution v1
				</Text>
			</Page>
		</Document>
	);
}

export const decantingResolutionTemplate: TemplateDefinition<DecantingVariables> = {
	id: 'decanting-resolution',
	version: '1',
	label: 'Decanting Resolution',
	description:
		'Trustee\'s exercise of statutory or instrument decanting power to distribute principal to a new trust with modified terms. High-risk action — captures authority, source/recipient identities, material changes, beneficial-interest analysis, tax-position preservation, and §813 notice.',
	category: 'governance',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: decantingResolutionPdf,
	formIntro:
		'Decanting is one of the most consequential actions a trustee can take. Before executing this resolution, the Trustee must confirm with qualified tax counsel that the specific change is within the applicable decanting authority and does not produce adverse gift / GST / grandfathering consequences.',
	formFields: [
		{
			name: 'statutoryBasis',
			label: 'Statutory basis',
			widget: 'select',
			options: [
				{ value: 'state_statute', label: 'State decanting statute (DE / NV / SD / etc.)' },
				{ value: 'utda', label: 'Uniform Trust Decanting Act (UTDA 2015)' },
				{ value: 'utc_818', label: 'UTC §818 default power' },
				{ value: 'instrument_express_power', label: 'Express power in trust instrument' },
				{ value: 'common_law', label: 'Common-law analysis (no statute)' },
				{ value: 'court_approval', label: 'Court approval / instructions' },
			],
		},
		{ name: 'effectiveDate', label: 'Effective date', widget: 'date' },
		{
			name: 'authorityCitation',
			label: 'Authority citation',
			widget: 'text',
			placeholder: 'e.g., "Del. Code Ann. tit. 12, §3528" or "Section 9.4 of the Trust Agreement"',
			span: 2,
		},
		{ name: 'recipientTrustName', label: 'Recipient trust name', widget: 'text' },
		{ name: 'recipientTrustEffectiveDate', label: 'Recipient trust effective date', widget: 'date' },
		{
			name: 'recipientTrustStatus',
			label: 'Recipient trust status',
			widget: 'select',
			span: 2,
			options: [
				{ value: 'newly_created', label: 'Newly created' },
				{ value: 'existing_trust', label: 'Existing trust' },
				{ value: 'created_for_decanting', label: 'Created concurrently for the decanting' },
			],
		},
		{
			name: 'decantingPurpose',
			label: 'Purpose of the decanting',
			widget: 'textarea',
			rows: 3,
			placeholder: 'Why decant? Common purposes: fix scrivener error, modernize administrative provisions, address tax-law change, change situs / governing law, extend duration, add/remove powers of appointment, consolidate trusts.',
			span: 2,
		},
		{
			name: 'changeCategories',
			label: 'Change categories',
			widget: 'text',
			placeholder: 'e.g., "Administrative — change in trustee removal provisions; Situs — change from CA to DE governing law"',
			span: 2,
		},
		{
			name: 'materialChangesNarrative',
			label: 'Material changes (source → recipient)',
			widget: 'textarea',
			rows: 5,
			placeholder: 'Detailed enumeration of every material change between the source trust and the recipient trust. Use a "From → To" format if helpful.',
			span: 2,
		},
		{
			name: 'beneficialInterestsChanged',
			label: 'Beneficial-interest change',
			widget: 'select',
			span: 2,
			options: [
				{ value: 'no_identical', label: 'No — identical to source' },
				{ value: 'no_administrative_only', label: 'No — administrative changes only' },
				{ value: 'yes_narrowing_class', label: 'Yes — narrowing class (subset)' },
				{ value: 'yes_broadening_class', label: 'Yes — broadening class (HIGH RISK)' },
				{ value: 'yes_shifting_interests', label: 'Yes — shifting current/remainder (HIGH RISK)' },
			],
		},
		{
			name: 'beneficialInterestsAnalysis',
			label: 'Beneficial-interest analysis',
			widget: 'textarea',
			rows: 5,
			placeholder: 'Detailed analysis: which beneficiaries are present in source vs recipient, current vs remainder interests in each, dollar / percentage impact. Confirm the change is within the applicable decanting statute\'s permitted scope.',
			span: 2,
		},
		{
			name: 'taxAnalysis',
			label: 'Tax-position analysis',
			widget: 'textarea',
			rows: 5,
			placeholder: 'Address: gift-tax exposure (any beneficiary consenting to reduce their interest?), GST-exempt status preservation (is the recipient trust GST-grandfathered?), grandfathered tax positions (pre-1985 GST, pre-1991 §2056 elections), §661 distribution-deduction implications, basis-step-up implications.',
			span: 2,
		},
		{
			name: 'beneficiaryNotice',
			label: 'Beneficiary notice status',
			widget: 'select',
			options: [
				{ value: 'notice_given', label: 'Notice given (notice period expired)' },
				{ value: 'notice_pending', label: 'Notice given, period running' },
				{ value: 'notice_waived', label: 'Notice waived in writing by all qualified beneficiaries' },
				{ value: 'no_notice_required', label: 'No notice required' },
			],
		},
		{
			name: 'noticeNarrative',
			label: 'Notice narrative',
			widget: 'textarea',
			rows: 3,
			placeholder: 'Notice dates, delivery method, beneficiaries notified, statutory notice period, any beneficiary responses received.',
			span: 2,
		},
		{
			name: 'assetTransferDescription',
			label: 'Asset transfer description',
			widget: 'textarea',
			rows: 4,
			placeholder: 'What\'s being transferred — all assets, specific assets, valuation method. Mechanics: re-titling, deeds, brokerage account transfers, contract assignments.',
			span: 2,
		},
	],
};
