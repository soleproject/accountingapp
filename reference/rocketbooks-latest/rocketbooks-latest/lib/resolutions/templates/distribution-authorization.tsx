import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Distribution Authorization — the trustee's formal record that a
 * specific distribution to a specific beneficiary was authorized.
 * Pairs with the GL post on account 310 (Distributions); produces
 * the audit document IRS Pub 559 and UTC §813 expect to back the
 * K-1 the beneficiary receives.
 *
 * Phase 2 will add a separate Beneficiary Receipt & Release template
 * the beneficiary signs to acknowledge the distribution. That can
 * reference this authorization's id.
 */

const VARIABLES_SCHEMA = z.object({
	beneficiaryName: z.string().min(1),
	beneficiaryRelationship: z.string().optional().nullable(),
	/** Cents, to dodge float drift relative to the GL post. */
	amountCents: z.number().int().nonnegative(),
	distributionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Tax year the distribution falls into. Often equals the year of
	 *  distributionDate but a trust on a fiscal year may straddle. */
	taxYear: z.number().int().min(1900).max(3000),
	/** Character drives the K-1 line mapping later:
	 *    principal   → trust corpus distribution (no K-1 income)
	 *    income      → ordinary income to beneficiary
	 *    dni         → Distributable Net Income flow-through */
	character: z.enum(['principal', 'income', 'dni']),
	/** The standard from the trust agreement that was applied (HEMS,
	 *  best-interests, support-of-beneficiary, etc.). Required so the
	 *  audit trail records WHY the trustee determined the distribution
	 *  was authorized — not just THAT it happened. */
	standardApplied: z.string().min(1),
	/** HEMS category — health / education / maintenance / support /
	 *  none. For spendthrift trusts the HEMS finding is the asset-
	 *  protection backbone: it's what protects the distribution from
	 *  a creditor challenge if the beneficiary is in financial
	 *  trouble. */
	hemsCategory: z.enum(['health', 'education', 'maintenance', 'support', 'none']).optional().nullable(),
	/** Free-text narrative supporting the HEMS finding. UTC §814
	 *  default rule requires the trustee to consider the beneficiary's
	 *  other resources unless the instrument says otherwise — this
	 *  field is where the trustee records that consideration. */
	hemsFindings: z.string().optional().nullable(),
	/** True if the trustee considered (or formally chose to disregard)
	 *  the beneficiary's other resources. Drives a different recital
	 *  paragraph. */
	otherResourcesConsidered: z.boolean().optional().nullable(),
	/** Free-text purpose. "Tuition", "Medical", "Annual support",
	 *  etc. */
	purpose: z.string().min(1),
	/** Optional GL backstop — the source account number that funded
	 *  the distribution (typically 310 itself). Lets the resolution
	 *  cite the exact account. */
	sourceAccountLabel: z.string().optional().nullable(),
	/** Optional finding-id back-pointer for the audit trail — when
	 *  drafted from a trust-review finding, we record which one. */
	sourceFindingId: z.string().optional().nullable(),
});

type DistributionVariables = z.infer<typeof VARIABLES_SCHEMA>;

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

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

const CHARACTER_LABEL: Record<DistributionVariables['character'], string> = {
	principal: 'Distribution of Principal (Corpus)',
	income: 'Distribution of Income',
	dni: 'Distribution of Distributable Net Income (DNI)',
};

const HEMS_LABEL: Record<'health' | 'education' | 'maintenance' | 'support', string> = {
	health: 'Health',
	education: 'Education',
	maintenance: 'Maintenance',
	support: 'Support',
};

function hemsAuthority(state: string | null): string {
	return state
		? `(IRC §2041(b)(1)(A) / Treas. Reg. §20.2041-1(c)(2)), as applied under the laws of ${state}`
		: '(IRC §2041(b)(1)(A) / Treas. Reg. §20.2041-1(c)(2))';
}

const CHARACTER_NOTE: Record<DistributionVariables['character'], string> = {
	principal: 'This distribution is from trust corpus and is not income to the beneficiary. No K-1 reporting is required for this distribution.',
	income: 'This distribution carries out trust income to the beneficiary. The beneficiary will receive a Schedule K-1 for the applicable tax year reporting this amount as ordinary income.',
	dni: 'This distribution is a Distributable Net Income (DNI) distribution. The character of the income (interest, dividends, capital gains, etc.) flows through to the beneficiary via the Schedule K-1 for the applicable tax year, and is taxable to the beneficiary to the extent of DNI.',
};

function distributionAuthorizationPdf(args: RenderArgs<DistributionVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const trustLabel = trust.trustName ?? 'the Trust';
	const stateClause = trust.governingState
		? ` This Authorization shall be governed by the laws of ${trust.governingState}.`
		: '';

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>DISTRIBUTION AUTHORIZATION</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · {formatDate(v.distributionDate)} · Tax year {v.taxYear}
				</Text>
				<View style={styles.hr} />

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						The undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
						{trust.effectiveDate ? `, established ${formatDate(trust.effectiveDate)}` : ''},
						{trust.ein ? ` EIN ${trust.ein},` : ''} hereby authorizes the following distribution to the beneficiary identified below.
					</Text>
				</View>

				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Beneficiary</Text>
						<Text style={styles.keyValueValue}>
							{v.beneficiaryName}
							{v.beneficiaryRelationship ? ` (${v.beneficiaryRelationship})` : ''}
						</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Amount</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.amountCents)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Distribution date</Text>
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
					{v.sourceAccountLabel && (
						<View style={styles.keyValueRow}>
							<Text style={styles.keyValueKey}>Source account</Text>
							<Text style={styles.keyValueValue}>{v.sourceAccountLabel}</Text>
						</View>
					)}
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>1. Purpose.</Text> {v.purpose}
					</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>2. Standard Applied.</Text> The Trustee has determined that this distribution is consistent with the standard set forth in the Trust Agreement: <Text style={styles.emph}>{v.standardApplied}</Text>.
					</Text>
				</View>

				{v.hemsCategory && v.hemsCategory !== 'none' && (
					<View style={styles.recitalBlock}>
						<Text style={styles.paragraph}>
							<Text style={styles.emph}>3. HEMS Findings.</Text> This distribution is supported by the {HEMS_LABEL[v.hemsCategory]} category of the ascertainable standard {hemsAuthority(trust.governingState)}. {v.hemsFindings ?? 'Specific findings supporting this category are recorded in the trustee’s contemporaneous file.'}
						</Text>
						{typeof v.otherResourcesConsidered === 'boolean' && (
							<Text style={styles.paragraph}>
								{v.otherResourcesConsidered
									? 'Pursuant to UTC §814 the Trustee has considered the Beneficiary’s other resources known to the Trustee in determining the appropriate amount of this distribution.'
									: 'The Trust Agreement directs the Trustee to disregard the Beneficiary’s other resources in making distributions; this distribution is made on that footing.'}
							</Text>
						)}
					</View>
				)}

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>{v.hemsCategory && v.hemsCategory !== 'none' ? '4' : '3'}. Tax Character &amp; Reporting.</Text> {CHARACTER_NOTE[v.character]}
					</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>{v.hemsCategory && v.hemsCategory !== 'none' ? '5' : '4'}. Authorization.</Text> The Trustee, having reviewed the financial state of the Trust and the foregoing standard, hereby authorizes the distribution described above and directs that the corresponding journal entry be posted to the Trust&rsquo;s general ledger.{stateClause}
					</Text>
				</View>

				<Text style={styles.signaturesHeader}>SIGNATURES</Text>

				<View style={styles.sigBlock}>
					<View style={styles.sigLineRule} />
					<Text style={styles.sigName}>{trustee?.signedName ?? trustee?.expectedName ?? 'Trustee'}</Text>
					<Text style={styles.sigLabel}>
						Trustee of {trustLabel}
					</Text>
					{trustee?.signedAt && (
						<Text style={styles.sigMeta}>
							Signed {trustee.signedAt}{trustee.signedIp ? ` · IP ${trustee.signedIp}` : ''}
						</Text>
					)}
				</View>

				<Text style={styles.footer}>
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template distribution-authorization v1
				</Text>
			</Page>
		</Document>
	);
}

export const distributionAuthorizationTemplate: TemplateDefinition<DistributionVariables> = {
	id: 'distribution-authorization',
	version: '1',
	label: 'Distribution Authorization',
	description:
		'Trustee’s formal record authorizing a distribution to a beneficiary. Pairs with the GL post on 310 and backs the K-1 the beneficiary will receive.',
	category: 'operating',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: distributionAuthorizationPdf,
};
