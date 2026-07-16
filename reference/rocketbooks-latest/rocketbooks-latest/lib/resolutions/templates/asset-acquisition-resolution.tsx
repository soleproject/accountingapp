import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Asset Acquisition Resolution — the trustee's formal authorization
 * to use trust funds (or trust debt) to buy an asset from a third
 * party. Sits next to Bill of Sale in the catalog but covers a
 * different fact pattern:
 *
 *   Bill of Sale            : grantor / third party transfers an
 *                             asset INTO trust corpus, usually
 *                             offset by a 26x demand note. The
 *                             trust is receiving.
 *   Acquisition Resolution  : trust BUYS an asset from a third
 *                             party using trust cash, financing,
 *                             or both. The trust is purchasing.
 *
 * Trigger: a fixed_assets row with acquisitionType='purchased'.
 * The /assets/[id] page surfaces a "Draft acquisition resolution"
 * link that lands here pre-filled from the row.
 */

const FUNDING_SOURCES = ['cash', 'financed', 'mixed'] as const;

const VARIABLES_SCHEMA = z.object({
	/** Asset description — pulled from fixed_assets.name + serial /
	 *  asset number. Free-text so a real-property "legal description"
	 *  or a vehicle VIN block can be substituted by the user. */
	assetDescription: z.string().min(1),
	/** Vendor / seller — the third party the trust is buying from.
	 *  Falls through to free text when the contact isn't in the
	 *  contacts table. */
	vendorName: z.string().min(1),
	vendorAddress: z.string().optional().nullable(),
	/** Acquisition cost, cents. Stored as cents to mirror the GL
	 *  basis amount; the template formats. */
	costCents: z.number().int().positive(),
	/** How the trust funded the purchase. Drives the recital language
	 *  in section 2. */
	fundingSource: z.enum(FUNDING_SOURCES),
	/** Financing detail (lender, term, rate) when fundingSource is
	 *  financed or mixed. */
	financingDetails: z.string().optional().nullable(),
	/** Acquisition date / closing date. Also drives the GL post date. */
	acquisitionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Why the trust is acquiring this asset. Trustee's audit-trail
	 *  rationale (e.g., "to generate rental income for beneficiaries",
	 *  "to provide housing for the incapacitated beneficiary"). */
	businessPurpose: z.string().min(1),
	/** Trust-power citation. e.g., "Section 4.2 of the Trust Agreement
	 *  grants the Trustee power to acquire real property." */
	powerCitation: z.string().optional().nullable(),
	/** Optional back-pointer to the fixed_assets row so the audit
	 *  trail records which asset this resolution authorized. */
	fixedAssetId: z.string().optional().nullable(),
});

type AcquisitionVariables = z.infer<typeof VARIABLES_SCHEMA>;

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

const FUNDING_LABEL: Record<AcquisitionVariables['fundingSource'], string> = {
	cash: 'Cash from trust operating funds',
	financed: 'Financed (debt instrument)',
	mixed: 'Mixed (cash + financing)',
};

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function fundingParagraph(v: AcquisitionVariables): string {
	const amt = formatMoney(v.costCents);
	const tail = v.financingDetails ? ` Financing terms: ${v.financingDetails}.` : '';
	if (v.fundingSource === 'cash') {
		return `The Trust shall fund the acquisition in the amount of ${amt} from trust operating funds.`;
	}
	if (v.fundingSource === 'financed') {
		return `The Trust shall fund the acquisition in the amount of ${amt} through financing.${tail}`;
	}
	return `The Trust shall fund the acquisition in the amount of ${amt} through a combination of trust operating funds and financing.${tail}`;
}

function assetAcquisitionResolutionPdf(args: RenderArgs<AcquisitionVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const stateClause = trust.governingState
		? ` This Resolution shall be governed by the laws of ${trust.governingState}.`
		: '';

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>ASSET ACQUISITION RESOLUTION</Text>
				<Text style={styles.subtitle}>
					{trustLabel} · {formatDate(v.acquisitionDate)}
				</Text>
				<View style={styles.hr} />

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						The undersigned Trustee of <Text style={styles.emph}>{trustLabel}</Text>
						{trust.effectiveDate ? `, established ${formatDate(trust.effectiveDate)}` : ''},
						{trust.ein ? ` EIN ${trust.ein},` : ''} hereby authorizes the acquisition of the asset described below for the benefit of the Trust.
					</Text>
				</View>

				<View style={styles.keyValueBlock}>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Asset</Text>
						<Text style={styles.keyValueValue}>{v.assetDescription}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Vendor / Seller</Text>
						<Text style={styles.keyValueValue}>
							{v.vendorName}
							{v.vendorAddress ? `, ${v.vendorAddress}` : ''}
						</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Acquisition cost</Text>
						<Text style={styles.keyValueValue}>{formatMoney(v.costCents)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Acquisition date</Text>
						<Text style={styles.keyValueValue}>{formatDate(v.acquisitionDate)}</Text>
					</View>
					<View style={styles.keyValueRow}>
						<Text style={styles.keyValueKey}>Funding source</Text>
						<Text style={styles.keyValueValue}>{FUNDING_LABEL[v.fundingSource]}</Text>
					</View>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>1. Business purpose.</Text> {v.businessPurpose}
					</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>2. Funding.</Text> {fundingParagraph(v)}
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
						<Text style={styles.emph}>{v.powerCitation ? '4' : '3'}. Authorization.</Text> The Trustee, having determined that the foregoing acquisition is consistent with the purposes of the Trust and the prudent-investor standard, hereby authorizes the acquisition described above and directs that title be taken in the name of the Trust and the corresponding journal entry be posted to the Trust&rsquo;s general ledger.{stateClause}
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
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template asset-acquisition-resolution v1
				</Text>
			</Page>
		</Document>
	);
}

export const assetAcquisitionResolutionTemplate: TemplateDefinition<AcquisitionVariables> = {
	id: 'asset-acquisition-resolution',
	version: '1',
	label: 'Asset Acquisition Resolution',
	description:
		'Trustee’s authorization to buy an asset from a third party using trust funds (cash, financing, or both). Distinct from Bill of Sale, which covers asset contributions INTO the trust corpus.',
	category: 'operating',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [{ role: 'Trustee' }],
	requiresState: true,
	renderPdf: assetAcquisitionResolutionPdf,
	formFields: [
		{
			name: 'assetDescription',
			label: 'Asset description',
			widget: 'textarea',
			rows: 3,
			placeholder:
				'Year/make/model + VIN for vehicles; legal description from the prior deed for real property.',
			span: 2,
		},
		{ name: 'vendorName', label: 'Vendor / seller', widget: 'text' },
		{ name: 'vendorAddress', label: 'Vendor address', widget: 'text', required: false },
		{ name: 'costCents', label: 'Acquisition cost ($)', widget: 'dollars', cents: true },
		{ name: 'acquisitionDate', label: 'Acquisition date', widget: 'date' },
		{
			name: 'fundingSource',
			label: 'Funding source',
			widget: 'select',
			options: [
				{ value: 'cash', label: 'Cash from trust operating funds' },
				{ value: 'financed', label: 'Financed (debt instrument)' },
				{ value: 'mixed', label: 'Mixed (cash + financing)' },
			],
		},
		{
			name: 'financingDetails',
			label: 'Financing details',
			widget: 'text',
			required: false,
			placeholder: 'Lender, principal, rate, term',
			span: 2,
			visibleWhen: { field: 'fundingSource', in: ['financed', 'mixed'] },
		},
		{
			name: 'businessPurpose',
			label: 'Business purpose',
			widget: 'textarea',
			rows: 2,
			placeholder:
				"Why is the trust acquiring this asset? (e.g., 'to generate rental income for beneficiaries', 'to house the incapacitated beneficiary', etc.)",
			span: 2,
		},
		{
			name: 'powerCitation',
			label: 'Trust power citation (optional)',
			widget: 'text',
			required: false,
			placeholder: 'e.g., Section 4.2 of the Trust Agreement grants the Trustee power to acquire real property',
			span: 2,
		},
	],
};
