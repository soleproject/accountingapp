import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Asset Disposition Resolution — trustee's formal authorization to
 * sell, write off, or otherwise dispose of a trust asset. Pairs with
 * the fixed_asset disposal flow (status='disposed'). Provides the
 * audit-trail document for Form 1041 Schedule D backup and the
 * proceeds accounting.
 *
 * Auto-drafted by disposeAsset on success. Source linkage:
 *   sourceKind = 'fixed_asset'
 *   sourceId   = fixed_assets.id
 *
 * Note: shares the 'fixed_asset' source kind with the Acquisition /
 * Bill of Sale documents (different templateId on the same source).
 * The (org, source_kind, source_id) unique-index allows this because
 * we keyed it on the entire tuple including template_id... actually
 * we didn't — see the migration in 0045. The auto-draft idempotency
 * in draftResolution checks source AND IGNORES template, so re-
 * draft of a disposition won't conflict with the existing acquisition
 * doc on the same asset because the acquisition doc references a
 * DIFFERENT asset (one is the source asset; the other only fires for
 * contributed/inherited). For 'purchased' assets with both an
 * Acquisition Resolution and (later) a Disposition Resolution, the
 * acquisition row's source IS the asset and would conflict. We
 * resolve this by using a different source_kind for disposition.
 */

const DISPOSITION_METHODS = ['sale', 'write_off', 'trade_in', 'abandonment', 'other'] as const;

const VARIABLES_SCHEMA = z.object({
	assetDescription: z.string().min(1),
	dispositionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Buyer / transferee. Free-text — often a third party not in
	 *  contacts. Optional for write-offs. */
	buyerName: z.string().optional().nullable(),
	buyerAddress: z.string().optional().nullable(),
	/** Method drives the recital language. */
	method: z.enum(DISPOSITION_METHODS),
	/** Sale price / proceeds before fees, in cents. */
	proceedsCents: z.number().int().nonnegative(),
	/** Selling fees / closing costs, in cents. */
	feesCents: z.number().int().nonnegative(),
	/** Asset's recorded basis at disposition, in cents. */
	costBasisCents: z.number().int().nonnegative(),
	/** Accumulated depreciation reversed at disposition, in cents. */
	accumulatedDepreciationCents: z.number().int().nonnegative(),
	/** Gain or loss recognized, in cents (signed; positive = gain). */
	gainOrLossCents: z.number().int(),
	/** Free-text holding-period note ("Acquired 2024-03-15, sold
	 *  2026-04-20 — long-term"). */
	holdingPeriodNote: z.string().optional().nullable(),
	/** Why dispose? Audit rationale ("Property no longer serves trust
	 *  purposes", "Equipment obsolete", etc.). */
	dispositionRationale: z.string().min(1),
	/** Optional trust-instrument citation that grants the disposal
	 *  authority. */
	powerCitation: z.string().optional().nullable(),
	/** Back-pointer to the fixed_assets row. */
	fixedAssetId: z.string().optional().nullable(),
});

type DispositionVariables = z.infer<typeof VARIABLES_SCHEMA>;

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
		width: 150,
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

const METHOD_LABEL: Record<DispositionVariables['method'], string> = {
	sale: 'Sale to a third party',
	write_off: 'Write-off (asset destroyed, lost, or worthless)',
	trade_in: 'Trade-in toward replacement asset',
	abandonment: 'Abandonment',
	other: 'Other',
};

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function dispositionParagraph(v: DispositionVariables): string {
	const proceedsLabel = formatMoney(v.proceedsCents);
	const netLabel = formatMoney(v.proceedsCents - v.feesCents);
	switch (v.method) {
		case 'sale':
			return `The Trustee has authorized the sale of the Asset to ${v.buyerName ?? 'a third party'} for ${proceedsLabel}${v.feesCents > 0 ? ` (less ${formatMoney(v.feesCents)} in selling fees, net ${netLabel})` : ''}.`;
		case 'trade_in':
			return `The Asset has been traded in toward a replacement asset; trade-in credit of ${proceedsLabel} was applied.`;
		case 'write_off':
			return `The Asset has been written off as destroyed, lost, or otherwise worthless. Proceeds: ${proceedsLabel}.`;
		case 'abandonment':
			return `The Trust has abandoned the Asset effective ${formatDate(v.dispositionDate)}. Proceeds: ${proceedsLabel}.`;
		case 'other':
			return `The Asset has been disposed of by other means. Proceeds: ${proceedsLabel}.`;
	}
}

function assetDispositionResolutionPdf(args: RenderArgs<DispositionVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const stateClause = trust.governingState
		? ` This Resolution shall be governed by the laws of ${trust.governingState}.`
		: '';
	const isGain = v.gainOrLossCents >= 0;

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>ASSET DISPOSITION RESOLUTION</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · {formatDate(v.dispositionDate)}
				</Text>
				<View style={styles.hr} />

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						The undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
						{trust.effectiveDate ? `, established ${formatDate(trust.effectiveDate)}` : ''},
						{trust.ein ? ` EIN ${trust.ein},` : ''} hereby authorizes and confirms the disposition of the asset described below.
					</Text>
				</View>

				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Asset</Text>
						<Text style={styles.keyValueValue}>{v.assetDescription}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Disposition method</Text>
						<Text style={styles.keyValueValue}>{METHOD_LABEL[v.method]}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Disposition date</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.dispositionDate)}</Text>
					</View>
					{v.buyerName && (
						<View style={styles.keyValueRow}>
							<Text style={styles.keyValueKey}>Buyer / transferee</Text>
							<Text style={styles.keyValueValue}>
								{v.buyerName}
								{v.buyerAddress ? `, ${v.buyerAddress}` : ''}
							</Text>
						</View>
					)}
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Gross proceeds</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.proceedsCents)}</Text>
					</View>
					{v.feesCents > 0 && (
						<View style={styles.keyValueRow}>
							<Text style={styles.keyValueKey}>Selling fees</Text>
							<Text style={styles.keyValueValue}>{formatMoney(v.feesCents)}</Text>
						</View>
					)}
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Cost basis</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.costBasisCents)}</Text>
					</View>
					{v.accumulatedDepreciationCents > 0 && (
						<View style={styles.keyValueRow}>
							<Text style={styles.keyValueKey}>Accumulated dep.</Text>
							<Text style={styles.keyValueValue}>{formatMoney(v.accumulatedDepreciationCents)}</Text>
						</View>
					)}
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>{isGain ? 'Gain recognized' : 'Loss recognized'}</Text>
						<Text style={styles.keyValueValue}>{formatMoney(Math.abs(v.gainOrLossCents))}</Text>
					</View>
					{v.holdingPeriodNote && (
						<View style={styles.keyValueRow}>
							<Text style={styles.keyValueKey}>Holding period</Text>
							<Text style={styles.keyValueValue}>{v.holdingPeriodNote}</Text>
						</View>
					)}
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>1. Disposition.</Text> {dispositionParagraph(v)}
					</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>2. Rationale.</Text> {v.dispositionRationale}
					</Text>
				</View>

				{v.powerCitation && (
					<View style={styles.recitalBlock}>
						<Text style={styles.paragraph}>
							<Text style={styles.emph}>3. Authority.</Text> The Trustee acts pursuant to {v.powerCitation}.
						</Text>
					</View>
				)}

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>{v.powerCitation ? '4' : '3'}. Tax reporting.</Text> The {isGain ? 'gain' : 'loss'} recognized above will be reflected on the Trust&rsquo;s Form 1041 Schedule D for the applicable tax year. Holding-period classification (long-term vs. short-term) is determined by the period between acquisition and disposition dates.{stateClause}
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
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template asset-disposition-resolution v1
				</Text>
			</Page>
		</Document>
	);
}

export const assetDispositionResolutionTemplate: TemplateDefinition<DispositionVariables> = {
	id: 'asset-disposition-resolution',
	version: '1',
	label: 'Asset Disposition Resolution',
	description:
		'Trustee\'s authorization to sell, write off, or otherwise dispose of a trust asset. Auto-drafts when an asset is disposed via the assets module; backs Form 1041 Schedule D reporting.',
	category: 'operating',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: assetDispositionResolutionPdf,
	formFields: [
		{ name: 'assetDescription', label: 'Asset description', widget: 'textarea', rows: 2, span: 2 },
		{ name: 'dispositionDate', label: 'Disposition date', widget: 'date' },
		{
			name: 'method',
			label: 'Method',
			widget: 'select',
			options: [
				{ value: 'sale', label: 'Sale to a third party' },
				{ value: 'write_off', label: 'Write-off (asset destroyed, lost, or worthless)' },
				{ value: 'trade_in', label: 'Trade-in toward replacement asset' },
				{ value: 'abandonment', label: 'Abandonment' },
				{ value: 'other', label: 'Other' },
			],
		},
		{ name: 'buyerName', label: 'Buyer / transferee', widget: 'text', required: false },
		{ name: 'buyerAddress', label: 'Buyer address', widget: 'text', required: false },
		{ name: 'proceedsCents', label: 'Gross proceeds ($)', widget: 'dollars', cents: true, required: false },
		{ name: 'feesCents', label: 'Selling fees ($)', widget: 'dollars', cents: true, required: false },
		{ name: 'costBasisCents', label: 'Cost basis ($)', widget: 'dollars', cents: true, required: false },
		{ name: 'accumulatedDepreciationCents', label: 'Accumulated depreciation ($)', widget: 'dollars', cents: true, required: false },
		{ name: 'gainOrLossCents', label: 'Gain (positive) / Loss (negative) ($)', widget: 'dollars', cents: true, signed: true, required: false },
		{ name: 'holdingPeriodNote', label: 'Holding period note', widget: 'text', required: false, span: 2 },
		{
			name: 'dispositionRationale',
			label: 'Disposition rationale',
			widget: 'textarea',
			rows: 3,
			placeholder:
				"Why is the trustee disposing of this asset? E.g., 'Property no longer fits trust purposes', 'Equipment obsolete', 'Replacing with newer model through trade-in'.",
			span: 2,
		},
		{
			name: 'powerCitation',
			label: 'Trust power citation (optional)',
			widget: 'text',
			required: false,
			placeholder: 'e.g., Section 4.4 of the Trust Agreement grants the Trustee power to sell trust assets.',
			span: 2,
		},
	],
};
