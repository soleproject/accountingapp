import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	documentRecords,
	trustBeneficiaries,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getTemplate } from '@/lib/resolutions/registry';
import type { Signer } from '@/lib/resolutions/types';
import { GenericTemplateForm } from '../../new/_components/GenericTemplateForm';
import { DistributionAuthorizationForm } from '../../new/_components/DistributionAuthorizationForm';
import { DeclarationOfExtraordinaryDividendForm } from '../../new/_components/DeclarationOfExtraordinaryDividendForm';
import { BeneficiaryReceiptAndReleaseForm } from '../../new/_components/BeneficiaryReceiptAndReleaseForm';
import { AnnualBeneficiaryAccountingForm } from '../../new/_components/AnnualBeneficiaryAccountingForm';
import { ScheduleAForm } from '../../new/_components/ScheduleAForm';

interface PageProps {
	params: Promise<{ id: string }>;
}

// Vars-shape interfaces — only the templates whose forms are still
// hand-written need their per-shape typing. Generic-form templates
// (bill-of-sale, asset-acquisition-resolution, asset-disposition-
// resolution, capital-gain-to-corpus-memo) get the raw Record<string,
// unknown> passed to GenericTemplateForm and validated by zod on
// submit.

interface DistributionVars {
	beneficiaryName?: string;
	beneficiaryRelationship?: string | null;
	amountCents?: number;
	distributionDate?: string;
	taxYear?: number;
	character?: 'principal' | 'income' | 'dni';
	purpose?: string;
	standardApplied?: string;
	sourceAccountLabel?: string | null;
	sourceFindingId?: string;
}

interface AnnualAccountingVars {
	taxYear?: number;
	periodStartDate?: string;
	periodEndDate?: string;
	assetBalances?: Array<{ accountNumber: string | null; accountName: string; balanceCents: number }>;
	liabilityBalances?: Array<{ accountNumber: string | null; accountName: string; balanceCents: number }>;
	receipts?: Array<{ accountNumber: string | null; accountName: string; amountCents: number }>;
	disbursements?: Array<{ accountNumber: string | null; accountName: string; amountCents: number }>;
	distributions?: Array<{ beneficiaryName: string; amountCents: number; distributionCount: number }>;
	trusteeCompensationCents?: number;
	notes?: string | null;
}

interface ReceiptAndReleaseVars {
	beneficiaryName?: string;
	beneficiaryRelationship?: string | null;
	amountCents?: number;
	distributionDate?: string;
	taxYear?: number;
	character?: 'principal' | 'income' | 'dni';
	authorizationDocumentId?: string | null;
}

interface DividendVars {
	taxYear?: number;
	periodEndDate?: string;
	items?: Array<{
		accountNumber: string | null;
		accountName: string;
		incomeCents: number;
		distributedCents: number;
		retainedCents: number;
	}>;
	retentionRationale?: string | null;
	authorityCitation?: string | null;
}

interface ScheduleAVars {
	revision?: number;
	asOfDate?: string;
	notes?: string | null;
	assets?: Array<{
		name: string;
		categoryName: string | null;
		acquisitionType: 'contributed' | 'inherited';
		costBasisCents: number;
		fmvCents: number | null;
		inServiceDate: string;
		assetNumber: string | null;
		serialNumber: string | null;
		location: string | null;
	}>;
}

/**
 * Edit form for a draft document. Same per-template forms as the
 * /new page, but submits to updateDocumentVariables and re-renders
 * the PDF on success. Refuses to load when any signature has
 * already been captured — that state mirrors the server-side guard
 * in updateDocumentVariables.
 */
export default async function EditDocumentPage({ params }: PageProps) {
	const orgId = await getCurrentOrgId();
	const { id } = await params;

	const [doc] = await db
		.select({
			id: documentRecords.id,
			templateId: documentRecords.templateId,
			variables: documentRecords.variables,
			signers: documentRecords.signers,
			status: documentRecords.status,
		})
		.from(documentRecords)
		.where(
			and(
				eq(documentRecords.id, id),
				eq(documentRecords.organizationId, orgId),
			),
		)
		.limit(1);
	if (!doc) notFound();

	const signers = (doc.signers ?? []) as Signer[];
	if (signers.some((s) => !!s.signedAt)) {
		// Signed documents can't be edited — they have to be deleted +
		// redrafted, otherwise the audit trail lies. Bounce back to the
		// detail page.
		redirect(`/trust-documents/${id}`);
	}

	const template = getTemplate(doc.templateId);
	if (!template) notFound();

	const variables = (doc.variables ?? {}) as Record<string, unknown>;

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
					href={`/trust-documents/${id}`}
					className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
				>
					← Back to document
				</Link>
				<h1 className="mt-2 text-2xl font-semibold">Edit {template.label}</h1>
				<p className="text-sm text-zinc-500 dark:text-zinc-400">
					{template.description} · Saving re-renders the PDF; the old version
					stays in the version history.
				</p>
			</header>

			{template.formFields && (
				<GenericTemplateForm
					templateId={template.id}
					fields={template.formFields}
					initial={variables}
					editingDocumentId={id}
					intro={template.formIntro}
				/>
			)}

			{template.id === 'distribution-authorization' && (
				<DistributionAuthorizationForm
					editingDocumentId={id}
					initial={variables as DistributionVars}
					beneficiaries={beneficiariesForPicker}
				/>
			)}

			{template.id === 'schedule-a' && (
				<ScheduleAForm
					editingDocumentId={id}
					initial={variables as ScheduleAVars}
				/>
			)}

			{template.id === 'declaration-of-extraordinary-dividend' && (
				<DeclarationOfExtraordinaryDividendForm
					editingDocumentId={id}
					initial={variables as DividendVars}
				/>
			)}

			{template.id === 'beneficiary-receipt-and-release' && (
				<BeneficiaryReceiptAndReleaseForm
					editingDocumentId={id}
					initial={variables as ReceiptAndReleaseVars}
					beneficiaries={beneficiariesForPicker}
				/>
			)}

			{template.id === 'annual-beneficiary-accounting' && (
				<AnnualBeneficiaryAccountingForm
					editingDocumentId={id}
					initial={variables as AnnualAccountingVars}
				/>
			)}
		</div>
	);
}
