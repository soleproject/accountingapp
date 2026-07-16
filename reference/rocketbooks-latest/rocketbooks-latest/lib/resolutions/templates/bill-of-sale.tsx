import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Bill of Sale — the most-repeated artifact in the beneficial-trust
 * funding flow. Per the source-doc spec, each asset contributed to
 * the trust is transferred via a sale (not a gift) with the buyer
 * being the trust by its trustee. The accompanying GL post offsets
 * with the seller's demand note (260/265). This template generates
 * the legal cover for that pair of postings.
 */

const VARIABLES_SCHEMA = z.object({
	/** Seller — typically the grantor or the original asset owner.
	 *  Free-text so a non-contact party (e.g., the deceased grantor's
	 *  estate, an outside vendor) can be named. */
	sellerName: z.string().min(1),
	sellerAddress: z.string().optional().nullable(),
	/** Description of the asset. Vehicles: include year/make/model/VIN.
	 *  Real property: legal description from the prior deed. Personal
	 *  property: enough to identify the item if a successor trustee
	 *  ever has to inventory it. */
	assetDescription: z.string().min(1),
	/** Asset class — drives the recital language ("the Vehicle",
	 *  "the Property", "the Equipment"). Pulled from the source-doc
	 *  vocabulary. */
	assetType: z.enum(['vehicle', 'real_property', 'equipment', 'investment', 'other']),
	/** Cost basis / consideration. Stored as cents to avoid float
	 *  surprises in the GL pairing. The template formats. */
	considerationCents: z.number().int().nonnegative(),
	/** Either 'demand_note' (the typical case — buyer issues a demand
	 *  note that goes to 260/265) or 'cash' or 'mixed'. Drives the
	 *  payment-terms paragraph. */
	paymentTerms: z.enum(['demand_note', 'cash', 'mixed']),
	/** Transfer date — the date of sale, which also drives the GL
	 *  post date. */
	transferDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Demand-note account number (e.g., '260' or '265.john_doe') when
	 *  paymentTerms === 'demand_note'. Lets the template cite the
	 *  exact GL account in the payment-terms paragraph. */
	demandNoteAccountLabel: z.string().optional().nullable(),
});

type BillOfSaleVariables = z.infer<typeof VARIABLES_SCHEMA>;

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

const ASSET_NOUN: Record<BillOfSaleVariables['assetType'], string> = {
	vehicle: 'Vehicle',
	real_property: 'Property',
	equipment: 'Equipment',
	investment: 'Investment',
	other: 'Property',
};

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function paymentParagraph(v: BillOfSaleVariables, noun: string): string {
	const amt = formatMoney(v.considerationCents);
	if (v.paymentTerms === 'cash') {
		return `In consideration of the payment of ${amt} in cash, receipt of which is hereby acknowledged, Seller hereby sells, transfers, and assigns the ${noun} to Buyer.`;
	}
	if (v.paymentTerms === 'mixed') {
		return `In consideration of the payment of ${amt}, paid in a combination of cash and a demand note from Buyer, Seller hereby sells, transfers, and assigns the ${noun} to Buyer.`;
	}
	const acct = v.demandNoteAccountLabel ? ` (recorded on account ${v.demandNoteAccountLabel})` : '';
	return `In consideration of the payment of ${amt}, evidenced by a demand promissory note from Buyer to Seller${acct}, payable on demand, Seller hereby sells, transfers, and assigns the ${noun} to Buyer.`;
}

function billOfSalePdf(args: RenderArgs<BillOfSaleVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const buyerLine = trust.trustName
		? `${trust.trustName}${trust.effectiveDate ? `, dated ${formatDate(trust.effectiveDate)}` : ''}`
		: 'the Trust';
	const noun = ASSET_NOUN[v.assetType];
	const stateClause = trust.governingState
		? ` This Bill of Sale shall be governed by the laws of ${trust.governingState}.`
		: '';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>BILL OF SALE</Text>
				<Text style={styles.subtitle}>
					Transferred {formatDate(v.transferDate)}{trust.trustName ? ` to ${trust.trustName}` : ''}
				</Text>
				<View style={styles.hr} />

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						This Bill of Sale is made and entered into as of <Text style={styles.emph}>{formatDate(v.transferDate)}</Text> by and between{' '}
						<Text style={styles.emph}>{v.sellerName}</Text>
						{v.sellerAddress ? `, of ${v.sellerAddress}` : ''} (&ldquo;Seller&rdquo;)
						and <Text style={styles.emph}>{buyerLine}</Text> (&ldquo;Buyer&rdquo;), acting by and through its Trustee.
					</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>1. Property.</Text> Seller is the lawful owner of, and has full right and authority to convey, the following {noun.toLowerCase()} (the &ldquo;{noun}&rdquo;):
					</Text>
					<Text style={styles.paragraph}>{v.assetDescription}</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>2. Consideration.</Text> {paymentParagraph(v, noun)}
					</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>3. Warranty of Title.</Text> Seller warrants that Seller is the lawful owner of the {noun}, that the {noun.toLowerCase()} is free from all liens and encumbrances except as expressly disclosed herein, and that Seller has the right to sell the {noun} as aforesaid.
					</Text>
				</View>

				<View style={styles.recitalBlock}>
					<Text style={styles.paragraph}>
						<Text style={styles.emph}>4. Acceptance into Trust Corpus.</Text> Buyer, by its Trustee, hereby accepts the {noun} into the corpus of the Trust to be held, administered, and disposed of in accordance with the Trust Agreement.{stateClause}
					</Text>
				</View>

				<Text style={styles.signaturesHeader}>SIGNATURES</Text>

				<View style={styles.sigBlock}>
					<View style={styles.sigLineRule} />
					<Text style={styles.sigName}>{v.sellerName}</Text>
					<Text style={styles.sigLabel}>Seller</Text>
				</View>

				<View style={styles.sigBlock}>
					<View style={styles.sigLineRule} />
					<Text style={styles.sigName}>{trustee?.signedName ?? trustee?.expectedName ?? 'Trustee'}</Text>
					<Text style={styles.sigLabel}>
						Trustee of {trust.trustName ?? 'the Trust'}
					</Text>
					{trustee?.signedAt && (
						<Text style={styles.sigMeta}>
							Signed {trustee.signedAt}{trustee.signedIp ? ` · IP ${trustee.signedIp}` : ''}
						</Text>
					)}
				</View>

				<Text style={styles.footer}>
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template bill-of-sale v1
				</Text>
			</Page>
		</Document>
	);
}

export const billOfSaleTemplate: TemplateDefinition<BillOfSaleVariables> = {
	id: 'bill-of-sale',
	version: '1',
	label: 'Bill of Sale',
	description:
		'Transfers a single asset into trust corpus. Pairs with the GL post on a 100-series asset account and the offsetting demand-note credit on 260/265.',
	category: 'corpus',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [
		{ role: 'Seller' },
		{ role: 'Trustee' },
	],
	requiresState: true,
	renderPdf: billOfSalePdf,
	formFields: [
		{ name: 'sellerName', label: 'Seller name', widget: 'text', span: 2 },
		{ name: 'sellerAddress', label: 'Seller address', widget: 'text', required: false, span: 2 },
		{
			name: 'assetType',
			label: 'Asset type',
			widget: 'select',
			options: [
				{ value: 'vehicle', label: 'Vehicle' },
				{ value: 'real_property', label: 'Real property' },
				{ value: 'equipment', label: 'Equipment' },
				{ value: 'investment', label: 'Investment' },
				{ value: 'other', label: 'Other personal property' },
			],
		},
		{ name: 'transferDate', label: 'Transfer date', widget: 'date' },
		{
			name: 'assetDescription',
			label: 'Asset description',
			widget: 'textarea',
			placeholder:
				'Year/make/model + VIN for vehicles; legal description from prior deed for real property.',
			span: 2,
		},
		{
			name: 'considerationCents',
			label: 'Consideration ($)',
			widget: 'dollars',
			cents: true,
		},
		{
			name: 'paymentTerms',
			label: 'Payment terms',
			widget: 'select',
			options: [
				{ value: 'demand_note', label: 'Demand note (typical — offsets to 260/265)' },
				{ value: 'cash', label: 'Cash' },
				{ value: 'mixed', label: 'Mixed (cash + demand note)' },
			],
		},
		{
			name: 'demandNoteAccountLabel',
			label: 'Demand-note account (optional)',
			widget: 'text',
			required: false,
			span: 2,
			placeholder: '260 — Trustee Demand Note',
			visibleWhen: { field: 'paymentTerms', in: ['demand_note', 'mixed'] },
		},
	],
};
