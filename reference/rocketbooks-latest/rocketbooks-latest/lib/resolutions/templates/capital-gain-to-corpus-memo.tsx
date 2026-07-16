import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Long-Term Capital Gain — Allocation to Principal (Corpus) memo.
 *
 * UPIA (Uniform Principal and Income Act) and most state variants
 * default long-term capital gains to PRINCIPAL, not DNI. When the
 * trustee routes a long-term gain to the corpus account via the
 * trust-review classifier, this memo documents the discretionary
 * allocation — what asset was sold, the gain amount, why it sits on
 * principal rather than flowing through to beneficiaries as DNI.
 *
 * Triggers on TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_CORPUS decision.
 * Distinct from Bill of Sale (which documents outside-in
 * contributions) — this documents an internal reclassification of
 * trust earnings.
 */

const VARIABLES_SCHEMA = z.object({
	/** Description of the asset that generated the gain. Pulled from
	 *  the line memo / JE memo when prefilled. */
	assetDescription: z.string().min(1),
	/** Total gain allocated to corpus, in cents. */
	amountCents: z.number().int().positive(),
	/** Realization date — when the gain hit the GL. */
	gainDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Tax year the gain falls into. */
	taxYear: z.number().int().min(1900).max(3000),
	/** Free-text holding-period note. "Held more than 12 months" or
	 *  "Acquired 2024-03-15, sold 2026-04-20 — long-term." */
	holdingPeriodNote: z.string().optional().nullable(),
	/** Trustee's discretionary rationale for allocating to principal
	 *  rather than DNI. Required so the audit trail captures WHY the
	 *  decision was made. */
	allocationJustification: z.string().min(1),
	/** Optional trust-instrument citation that grants the allocation
	 *  authority (e.g., "Section 5.3 of the Trust Agreement"). */
	trustInstrumentCitation: z.string().optional().nullable(),
	/** Back-pointer to the trust-review finding that triggered this
	 *  memo. */
	sourceFindingId: z.string().optional().nullable(),
});

type CapitalGainVariables = z.infer<typeof VARIABLES_SCHEMA>;

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
		width: 140,
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

function capitalGainToCorpusMemoPdf(args: RenderArgs<CapitalGainVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const stateClause = trust.governingState
		? ` Allocation is made under the laws of ${trust.governingState}, including its enactment of the Uniform Principal and Income Act.`
		: ' Allocation is made under the Uniform Principal and Income Act as adopted by the governing jurisdiction.';

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>ALLOCATION OF LONG-TERM CAPITAL GAIN TO PRINCIPAL</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · {formatDate(v.gainDate)} · Tax year {v.taxYear}
				</Text>
				<View style={styles.hr} />

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						The undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
						{trust.effectiveDate ? `, established ${formatDate(trust.effectiveDate)}` : ''},
						{trust.ein ? ` EIN ${trust.ein},` : ''} hereby records the discretionary allocation of the long-term capital gain described below to the principal (corpus) of the Trust rather than to distributable net income.
					</Text>
				</View>

				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Asset</Text>
						<Text style={styles.keyValueValue}>{v.assetDescription}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Gain amount</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.amountCents)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Realization date</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.gainDate)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Tax year</Text>
						<Text style={styles.keyValueValue}>{v.taxYear}</Text>
					</View>
					{v.holdingPeriodNote && (
						<View style={styles.keyValueRow}>
							<Text style={styles.keyValueKey}>Holding period</Text>
							<Text style={styles.keyValueValue}>{v.holdingPeriodNote}</Text>
						</View>
					)}
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Allocation</Text>
						<Text style={styles.keyValueValue}>Principal (corpus)</Text>
					</View>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>1. Character of the gain.</Text> The gain described above resulted from the disposition of a trust asset held for more than one year. Under the Uniform Principal and Income Act, long-term capital gains are presumptively allocable to principal absent a contrary direction in the Trust Agreement.
					</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>2. Discretionary determination.</Text> The Trustee, having reviewed the financial position of the Trust and the interests of the beneficiaries, allocates the gain to principal for the following reason(s):
					</Text>
					<Text style={styles.paragraph}>{v.allocationJustification}</Text>
				</View>

				{v.trustInstrumentCitation && (
					<View style={styles.recitalBlock}>
						<Text style={styles.paragraph}>
							<Text style={styles.emph}>3. Authority.</Text> The Trustee acts pursuant to {v.trustInstrumentCitation}.
						</Text>
					</View>
				)}

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>{v.trustInstrumentCitation ? '4' : '3'}. Tax reporting.</Text> Because the gain is allocated to principal and not distributed to any beneficiary, no K-1 reporting is required with respect to this gain for the applicable tax year. The gain will be reflected on the Trust&rsquo;s Form 1041 Schedule D as a long-term capital gain retained at the trust level.{stateClause}
					</Text>
				</View>

				<Text style={styles.signaturesHeader}>SIGNATURE</Text>

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
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template capital-gain-to-corpus-memo v1
				</Text>
			</Page>
		</Document>
	);
}

export const capitalGainToCorpusMemoTemplate: TemplateDefinition<CapitalGainVariables> = {
	id: 'capital-gain-to-corpus-memo',
	version: '1',
	label: 'Capital Gain Allocation to Principal',
	description:
		'Documents the trustee\'s discretionary allocation of a long-term capital gain to corpus (principal) rather than distributable income. Triggered when the user routes a gain via the trust-review classifier.',
	category: 'corpus',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: capitalGainToCorpusMemoPdf,
	formFields: [
		{
			name: 'assetDescription',
			label: 'Asset description',
			widget: 'textarea',
			rows: 2,
			placeholder:
				'What asset was sold? Year/make/model + VIN for vehicles, address for real property, # of shares + ticker for securities.',
			span: 2,
		},
		{ name: 'amountCents', label: 'Gain amount ($)', widget: 'dollars', cents: true },
		{ name: 'gainDate', label: 'Realization date', widget: 'date' },
		{ name: 'taxYear', label: 'Tax year', widget: 'integer' },
		{
			name: 'holdingPeriodNote',
			label: 'Holding period note',
			widget: 'text',
			required: false,
			placeholder: 'Held more than 12 months',
		},
		{
			name: 'allocationJustification',
			label: 'Allocation rationale',
			widget: 'textarea',
			rows: 3,
			placeholder:
				"Why is the trustee allocating this gain to principal rather than distributing? (e.g., 'Preserving trust corpus for future generations'; 'Reinvestment of proceeds in replacement asset already identified'; 'Beneficiaries' current-year distributions are sufficient.')",
			span: 2,
		},
		{
			name: 'trustInstrumentCitation',
			label: 'Trust instrument citation (optional)',
			widget: 'text',
			required: false,
			placeholder: 'e.g., Section 5.3 of the Trust Agreement grants discretion over principal-vs-income',
			span: 2,
		},
	],
};
