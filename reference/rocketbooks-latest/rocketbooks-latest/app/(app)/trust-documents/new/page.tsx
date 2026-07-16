import { redirect } from 'next/navigation';
import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { trustBeneficiaries, trustMetadata } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getTemplate } from '@/lib/resolutions/registry';
import {
	prefillDistributionFromFinding,
	prefillAssetAcquisitionFromAsset,
	prefillAssetDispositionFromAsset,
	prefillBillOfSaleFromAsset,
	prefillBillOfSaleFromCorpusFinding,
	prefillCapitalGainToCorpusFromFinding,
	prefillScheduleA,
	prefillExtraordinaryDividendForYear,
	prefillAnnualBeneficiaryAccounting,
	prefillPromissoryNoteFromDemandFinding,
	prefillRealEstatePurchaseFromAsset,
	prefillRealEstateSaleFromAsset,
	prefillInsuranceFromAsset,
	prefillLeaseResolutionFromRentalProperty,
} from '@/lib/resolutions/from-finding';
import { GenericTemplateForm } from './_components/GenericTemplateForm';
import { DistributionAuthorizationForm } from './_components/DistributionAuthorizationForm';
import { DeclarationOfExtraordinaryDividendForm } from './_components/DeclarationOfExtraordinaryDividendForm';
import { BeneficiaryReceiptAndReleaseForm } from './_components/BeneficiaryReceiptAndReleaseForm';
import { AnnualBeneficiaryAccountingForm } from './_components/AnnualBeneficiaryAccountingForm';
import { ScheduleAForm } from './_components/ScheduleAForm';
import { TrustMetadataPrompt } from './_components/TrustMetadataPrompt';

interface PageProps {
	searchParams: Promise<{
		template?: string;
		fromFinding?: string;
		fromAsset?: string;
		/** Rental-property id; routes to the Lease Resolution prefill. */
		fromRental?: string;
		/** Tax-year override for the annual Declaration template. */
		taxYear?: string;
	}>;
}

/**
 * Per-template draft form. For Phase 1 we only have a single template
 * (Bill of Sale) so the form is hardcoded against that variable
 * schema. Phase 2 onward will generate the form from each template's
 * zod schema so adding a template doesn't mean writing a form by hand.
 *
 * Lazy-prompts for trust metadata when the template marks
 * requiresState: true and the org hasn't filled it in yet. The
 * BillOfSaleForm reads our governing state from the prefilled metadata
 * and renders the recital language accordingly.
 */
export default async function NewResolutionPage({ searchParams }: PageProps) {
	const orgId = await getCurrentOrgId();
	const sp = await searchParams;
	const templateId = sp.template;
	if (!templateId) redirect('/trust-documents');

	const template = getTemplate(templateId);
	if (!template) redirect('/trust-documents');

	const [meta] = await db
		.select({
			trustName: trustMetadata.trustName,
			effectiveDate: trustMetadata.effectiveDate,
			governingState: trustMetadata.governingState,
			situsState: trustMetadata.situsState,
			ein: trustMetadata.ein,
			grantorName: trustMetadata.grantorName,
			defaultSigningAuthority: trustMetadata.defaultSigningAuthority,
		})
		.from(trustMetadata)
		.where(eq(trustMetadata.organizationId, orgId))
		.limit(1);

	const needsState = template.requiresState && !meta?.governingState;

	// Auto-prefill from a finding when the template + finding code are
	// compatible. Today: only TRUST_310_FLAG_K1_ISSUANCE →
	// distribution-authorization. As we add finding→template
	// mappings, add the parallel prefill calls here.
	const prefillDistribution =
		!needsState && template.id === 'distribution-authorization' && sp.fromFinding
			? await prefillDistributionFromFinding({
					organizationId: orgId,
					findingId: sp.fromFinding,
				})
			: null;

	// Asset Acquisition Resolution can be drafted from an existing
	// fixed_assets row (acquisitionType='purchased' only). The asset
	// detail page surfaces a "Draft acquisition resolution" link with
	// ?fromAsset=<assetId>.
	const prefillAcquisition =
		!needsState && template.id === 'asset-acquisition-resolution' && sp.fromAsset
			? await prefillAssetAcquisitionFromAsset({
					organizationId: orgId,
					fixedAssetId: sp.fromAsset,
				})
			: null;

	// Asset Disposition Resolution prefills from a disposed
	// fixed_assets row.
	const prefillDisposition =
		!needsState && template.id === 'asset-disposition-resolution' && sp.fromAsset
			? await prefillAssetDispositionFromAsset({
					organizationId: orgId,
					fixedAssetId: sp.fromAsset,
				})
			: null;

	// Bill of Sale prefill paths:
	//   ?fromAsset=X       → contributed / inherited asset (asset
	//                        detail's "Draft Bill of Sale" link)
	//   ?fromFinding=X     → TRUST_DEPOSIT_CLASSIFIED_AS_CORPUS or
	//                        _SPLIT_CORPUS_AND_INCOME (corpus cash
	//                        contribution)
	const prefillBillOfSale =
		!needsState && template.id === 'bill-of-sale' && sp.fromAsset
			? await prefillBillOfSaleFromAsset({
					organizationId: orgId,
					fixedAssetId: sp.fromAsset,
				})
			: !needsState && template.id === 'bill-of-sale' && sp.fromFinding
				? await prefillBillOfSaleFromCorpusFinding({
						organizationId: orgId,
						findingId: sp.fromFinding,
					})
				: null;

	// Capital Gain to Corpus memo prefills from a
	// TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_CORPUS audit finding.
	const prefillCapitalGain =
		!needsState && template.id === 'capital-gain-to-corpus-memo' && sp.fromFinding
			? await prefillCapitalGainToCorpusFromFinding({
					organizationId: orgId,
					findingId: sp.fromFinding,
				})
			: null;

	// Schedule A always auto-loads the contributed/inherited asset
	// roster — no per-draft trigger needed. The prefill also picks
	// the next revision number (1 for initial, 2+ for amendments).
	const prefillSchedule =
		!needsState && template.id === 'schedule-a'
			? await prefillScheduleA({ organizationId: orgId })
			: null;

	// Annual Declaration auto-loads 4xx income + distribution totals
	// for the chosen tax year (defaults to prior calendar year — the
	// year a trustee would actually be declaring for at year-end).
	const declaredTaxYear =
		template.id === 'declaration-of-extraordinary-dividend'
			? Number.parseInt(sp.taxYear ?? '', 10) || new Date().getFullYear() - 1
			: 0;
	const prefillDividend =
		!needsState && template.id === 'declaration-of-extraordinary-dividend'
			? await prefillExtraordinaryDividendForYear({
					organizationId: orgId,
					taxYear: declaredTaxYear,
				})
			: null;

	// Promissory Note prefills from a TRUST_DEMAND_NOTE_MISSING_NOTE
	// finding — the standing audit warning that fires when 250/260
	// demand-note activity hits the GL without a backing note on
	// file. Pulls the outstanding balance from the GL as principal.
	const prefillPromissory =
		!needsState && template.id === 'promissory-note' && sp.fromFinding
			? await prefillPromissoryNoteFromDemandFinding({
					organizationId: orgId,
					findingId: sp.fromFinding,
				})
			: null;

	// Real Estate Purchase prefills from a purchased fixed_assets row
	// whose category reads as real property (land / building / real /
	// property in the name). Address ← asset.location, legal description
	// ← asset.notes, purchase price ← cost_basis.
	const prefillRePurchase =
		!needsState && template.id === 'real-estate-purchase' && sp.fromAsset
			? await prefillRealEstatePurchaseFromAsset({
					organizationId: orgId,
					fixedAssetId: sp.fromAsset,
				})
			: null;

	// Real Estate Sale prefills from a disposed real-property
	// fixed_assets row. Sale price ← disposalProceeds, basis ←
	// cost_basis (or fmvAtDod for inherited), accumulated depreciation
	// pulled from the fiduciary book — the PDF computes the §1001
	// gain + §1250 split + §121 recital from these inputs.
	const prefillReSale =
		!needsState && template.id === 'real-estate-sale' && sp.fromAsset
			? await prefillRealEstateSaleFromAsset({
					organizationId: orgId,
					fixedAssetId: sp.fromAsset,
				})
			: null;

	// Lease Resolution prefills from a rental_properties row. Address
	// flattened from the rental_properties.address jsonb; tenant /
	// rent / deposit / utilities left blank (trustee judgment).
	const prefillLease =
		!needsState && template.id === 'lease-resolution' && sp.fromRental
			? await prefillLeaseResolutionFromRentalProperty({
					organizationId: orgId,
					rentalPropertyId: sp.fromRental,
				})
			: null;

	// Insurance Authorization prefills from any fixed_assets row —
	// the asset becomes the insured interest. Coverage type defaults
	// to property_hazard (or valuable_items_fine_art for art /
	// jewelry / collectibles per category heuristic). Effective date
	// defaults to today, expiration to today + 1 year (12-month P&C
	// term).
	const prefillInsurance =
		!needsState && template.id === 'insurance-authorization' && sp.fromAsset
			? await prefillInsuranceFromAsset({
					organizationId: orgId,
					fixedAssetId: sp.fromAsset,
				})
			: null;

	// Annual Beneficiary Accounting — full year of GL activity rollup.
	// Same prior-year default as the Declaration.
	const accountingTaxYear =
		template.id === 'annual-beneficiary-accounting'
			? Number.parseInt(sp.taxYear ?? '', 10) || new Date().getFullYear() - 1
			: 0;
	const prefillAccounting =
		!needsState && template.id === 'annual-beneficiary-accounting'
			? await prefillAnnualBeneficiaryAccounting({
					organizationId: orgId,
					taxYear: accountingTaxYear,
				})
			: null;

	// Beneficiaries roster for templates whose form needs a picker.
	// Loaded server-side so the form gets typed options on first paint
	// (avoids the empty-dropdown flash a client fetch would produce).
	const beneficiariesForPicker =
		template.id === 'distribution-authorization' || template.id === 'beneficiary-receipt-and-release'
			? await db
					.select({
						id: trustBeneficiaries.id,
						fullName: trustBeneficiaries.fullName,
						relationship: trustBeneficiaries.relationship,
					})
					.from(trustBeneficiaries)
					.where(eq(trustBeneficiaries.organizationId, orgId))
					.orderBy(asc(trustBeneficiaries.fullName))
			: [];

	return (
		<div className="flex flex-col gap-6">
			<header>
				<Link
					href="/trust-documents"
					className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
				>
					← All trust documents
				</Link>
				<h1 className="mt-2 text-2xl font-semibold">{template.label}</h1>
				<p className="text-sm text-zinc-500 dark:text-zinc-400">{template.description}</p>
			</header>

			{needsState && (
				<TrustMetadataPrompt
					organizationId={orgId}
					initial={meta ?? null}
				/>
			)}

			{!needsState && template.formFields && (
				<GenericTemplateForm
					templateId={template.id}
					fields={template.formFields}
					initial={pickInitial(template.id, {
						billOfSale: prefillBillOfSale,
						acquisition: prefillAcquisition,
						disposition: prefillDisposition,
						capitalGain: prefillCapitalGain,
						promissory: prefillPromissory,
						rePurchase: prefillRePurchase,
						reSale: prefillReSale,
						insurance: prefillInsurance,
						lease: prefillLease,
					})}
					source={
						sp.fromAsset
							? { kind: 'fixed_asset', id: sp.fromAsset }
							: sp.fromRental
								? { kind: 'rental_property', id: sp.fromRental }
								: sp.fromFinding
									? { kind: 'deposit_finding', id: sp.fromFinding }
									: undefined
					}
					intro={template.formIntro}
					submitLabel={`Draft ${template.label}`}
				/>
			)}

			{!needsState && template.id === 'distribution-authorization' && (
				<DistributionAuthorizationForm
					initial={prefillDistribution ?? undefined}
					beneficiaries={beneficiariesForPicker}
				/>
			)}

			{!needsState && template.id === 'schedule-a' && (
				<ScheduleAForm initial={prefillSchedule ?? undefined} />
			)}

			{!needsState && template.id === 'declaration-of-extraordinary-dividend' && (
				<DeclarationOfExtraordinaryDividendForm initial={prefillDividend ?? undefined} />
			)}

			{!needsState && template.id === 'beneficiary-receipt-and-release' && (
				<BeneficiaryReceiptAndReleaseForm beneficiaries={beneficiariesForPicker} />
			)}

			{!needsState && template.id === 'annual-beneficiary-accounting' && (
				<AnnualBeneficiaryAccountingForm initial={prefillAccounting ?? undefined} />
			)}
		</div>
	);
}

function pickInitial(
	templateId: string,
	prefills: {
		billOfSale: unknown;
		acquisition: unknown;
		disposition: unknown;
		capitalGain: unknown;
		promissory: unknown;
		rePurchase: unknown;
		reSale: unknown;
		insurance: unknown;
		lease: unknown;
	},
): Record<string, unknown> | undefined {
	const p =
		templateId === 'bill-of-sale' ? prefills.billOfSale
		: templateId === 'asset-acquisition-resolution' ? prefills.acquisition
		: templateId === 'asset-disposition-resolution' ? prefills.disposition
		: templateId === 'capital-gain-to-corpus-memo' ? prefills.capitalGain
		: templateId === 'promissory-note' ? prefills.promissory
		: templateId === 'real-estate-purchase' ? prefills.rePurchase
		: templateId === 'real-estate-sale' ? prefills.reSale
		: templateId === 'insurance-authorization' ? prefills.insurance
		: templateId === 'lease-resolution' ? prefills.lease
		: null;
	return p ? (p as Record<string, unknown>) : undefined;
}
