import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Beneficiary Receipt & Release — the beneficiary's acknowledgment
 * that they received a distribution from the trust, paired with a
 * release of further claims against the trustee with respect to that
 * specific distribution.
 *
 * Per UTC/UPC + general trust-defense best practice (Hoge Fenton et
 * al.), every distribution should have a paired R&R. The trustee
 * holds the Distribution Authorization documenting the discretionary
 * decision; the beneficiary signs the R&R closing the loop. Together
 * they're the audit-defense pair.
 *
 * Auto-spawned by draftResolution after a Distribution Authorization
 * is created. Source linkage:
 *   sourceKind = 'distribution_doc'
 *   sourceId   = the Distribution Authorization's document_records.id
 *
 * Cascade: voiding / deleting the Authorization cascade-voids the
 * R&R (the underlying transaction is being reversed; the
 * acknowledgment of it no longer stands).
 */

const VARIABLES_SCHEMA = z.object({
	beneficiaryName: z.string().min(1),
	beneficiaryRelationship: z.string().optional().nullable(),
	/** Cents. Must match the paired Authorization. */
	amountCents: z.number().int().nonnegative(),
	distributionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	taxYear: z.number().int().min(1900).max(3000),
	/** Mirrors the Authorization's character. Drives the tax-character
	 *  recital so the R&R is self-contained without making the reader
	 *  open the Authorization. */
	character: z.enum(['principal', 'income', 'dni']),
	/** Optional pointer to the paired Distribution Authorization. */
	authorizationDocumentId: z.string().optional().nullable(),
});

type ReceiptAndReleaseVariables = z.infer<typeof VARIABLES_SCHEMA>;

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
	recitalBlock: {
		marginBottom: 14,
	},
	paragraph: {
		marginBottom: 12,
		textAlign: 'justify',
	},
	emph: {
		fontFamily: 'Helvetica-Bold',
	},
	keyValueBlock: {
		marginVertical: 14,
		paddingVertical: 10,
		paddingHorizontal: 14,
		backgroundColor: '#f1f5f9',
		borderRadius: 4,
	},
	keyValueRow: {
		flexDirection: 'row',
		marginBottom: 4,
	},
	keyValueKey: {
		width: 130,
		fontFamily: 'Helvetica-Bold',
		fontSize: 9.5,
		color: '#475569',
		textTransform: 'uppercase',
		letterSpacing: 0.5,
	},
	keyValueValue: {
		flex: 1,
		fontSize: 11,
		color: '#0f172a',
	},
	signaturesHeader: {
		marginTop: 36,
		marginBottom: 6,
		fontSize: 10,
		letterSpacing: 1.5,
		color: '#0f172a',
		fontFamily: 'Helvetica-Bold',
	},
	sigBlock: {
		marginTop: 24,
	},
	sigLineRule: {
		borderBottomWidth: 0.75,
		borderBottomColor: '#0f172a',
		marginBottom: 4,
		marginTop: 28,
	},
	sigLabel: {
		fontSize: 9.5,
		color: '#64748b',
	},
	sigName: {
		fontSize: 10.5,
		fontFamily: 'Helvetica-Bold',
		color: '#0f172a',
		marginBottom: 2,
	},
	sigMeta: {
		fontSize: 8.5,
		color: '#64748b',
		marginTop: 2,
	},
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

const CHARACTER_LABEL: Record<ReceiptAndReleaseVariables['character'], string> = {
	principal: 'Distribution of Principal (Corpus)',
	income: 'Distribution of Income',
	dni: 'Distribution of Distributable Net Income (DNI)',
};

const CHARACTER_NOTE: Record<ReceiptAndReleaseVariables['character'], string> = {
	principal: 'The distribution acknowledged below is from trust corpus and is not income to the Beneficiary. No K-1 reporting is associated with this distribution.',
	income: 'The distribution acknowledged below carries out trust income. The Beneficiary will receive a Schedule K-1 reporting this amount as ordinary income for the applicable tax year.',
	dni: 'The distribution acknowledged below is a Distributable Net Income (DNI) distribution. Its character flows through to the Beneficiary via Schedule K-1 for the applicable tax year, taxable to the Beneficiary to the extent of DNI.',
};

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function beneficiaryReceiptAndReleasePdf(args: RenderArgs<ReceiptAndReleaseVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const beneficiary = args.signers.find((s) => s.role.toLowerCase().includes('beneficiary'));
	const stateClause = trust.governingState
		? ` This Receipt and Release shall be governed by the laws of ${trust.governingState}.`
		: '';
	const authRef = v.authorizationDocumentId
		? `Distribution Authorization id ${v.authorizationDocumentId.slice(0, 8)} dated ${formatDate(v.distributionDate)}`
		: `the Distribution Authorization dated ${formatDate(v.distributionDate)}`;

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>RECEIPT &amp; RELEASE</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · {formatDate(v.distributionDate)} · Tax year {v.taxYear}
				</Text>
				<View style={styles.hr} />

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						The undersigned <Text style={styles.emph}>{v.beneficiaryName}</Text>
						{v.beneficiaryRelationship ? ` (${v.beneficiaryRelationship})` : ''},
						as a beneficiary of <Text style={styles.emph}>{trustLabel}</Text>
						{trust.effectiveDate ? `, established ${formatDate(trust.effectiveDate)}` : ''},
						{trust.ein ? ` EIN ${trust.ein},` : ''} hereby acknowledges and confirms the following.
					</Text>
				</View>

				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Amount received</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.amountCents)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Date received</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.distributionDate)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Tax year</Text>
						<Text style={styles.keyValueValue}>{v.taxYear}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Character</Text>
						<Text style={styles.keyValueValue}>{CHARACTER_LABEL[v.character]}</Text>
					</View>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>1. Receipt.</Text> The Beneficiary acknowledges receipt of the distribution described above pursuant to {authRef}.
					</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>2. Tax character.</Text> {CHARACTER_NOTE[v.character]}
					</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>3. Release.</Text> In consideration of the foregoing distribution, the Beneficiary releases and forever discharges the Trustee from all claims, demands, and liabilities arising out of or relating to the foregoing distribution, including without limitation any claim that the distribution was improperly authorized, improperly calculated, or otherwise inconsistent with the terms of the Trust. This release is limited to the foregoing distribution and does not extend to any other act of the Trustee.{stateClause}
					</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>4. No coercion.</Text> The Beneficiary executes this Receipt and Release voluntarily, having had an opportunity to review the underlying records of the Trust and to consult with counsel of the Beneficiary&rsquo;s choosing.
					</Text>
				</View>

				<Text style={styles.signaturesHeader}>SIGNATURE</Text>

				<View style={styles.sigBlock}>
					<View style={styles.sigLineRule} />
					<Text style={styles.sigName}>{beneficiary?.signedName ?? beneficiary?.expectedName ?? v.beneficiaryName}</Text>
					<Text style={styles.sigLabel}>Beneficiary</Text>
					{beneficiary?.signedAt && (
						<Text style={styles.sigMeta}>
							Signed {beneficiary.signedAt}{beneficiary.signedIp ? ` · IP ${beneficiary.signedIp}` : ''}
						</Text>
					)}
				</View>

				<Text style={styles.footer}>
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template beneficiary-receipt-and-release v1
				</Text>
			</Page>
		</Document>
	);
}

export const beneficiaryReceiptAndReleaseTemplate: TemplateDefinition<ReceiptAndReleaseVariables> = {
	id: 'beneficiary-receipt-and-release',
	version: '1',
	label: 'Beneficiary Receipt & Release',
	description:
		'Beneficiary\'s acknowledgment of receipt + release of further claims for a specific distribution. Auto-paired with a Distribution Authorization when the Authorization is drafted.',
	category: 'operating',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Beneficiary' }],
	requiresState: true,
	renderPdf: beneficiaryReceiptAndReleasePdf,
};
