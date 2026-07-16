import { notFound } from 'next/navigation';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	assetCategories,
	chartOfAccounts,
	contacts,
	fixedAssets,
	loanAmortizationSchedules,
	loans,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { LoanForm, type AssetOption } from '../../_components/LoanForm';

interface PageProps {
	params: Promise<{ id: string }>;
}

export default async function EditLoanPage({ params }: PageProps) {
	const { id } = await params;
	const orgId = await getCurrentOrgId();

	const [loan] = await db
		.select({
			id: loans.id,
			displayName: loans.displayName,
			lenderContactId: loans.lenderContactId,
			noteDocumentUrl: loans.noteDocumentUrl,
			originalPrincipal: loans.originalPrincipal,
			annualInterestRate: loans.annualInterestRate,
			termMonths: loans.termMonths,
			paymentAmount: loans.paymentAmount,
			startDate: loans.startDate,
			firstPaymentDate: loans.firstPaymentDate,
			liabilityAccountId: loans.liabilityAccountId,
			interestExpenseAccountId: loans.interestExpenseAccountId,
			collateralAssetId: loans.collateralAssetId,
		})
		.from(loans)
		.where(and(eq(loans.id, id), eq(loans.organizationId, orgId)))
		.limit(1);
	if (!loan) notFound();

	const [postedCountRow] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(loanAmortizationSchedules)
		.where(
			and(
				eq(loanAmortizationSchedules.loanId, id),
				isNotNull(loanAmortizationSchedules.postedJournalEntryId),
			),
		);
	const postedCount = postedCountRow?.n ?? 0;

	const liabilityAccounts = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
			detailType: chartOfAccounts.detailType,
		})
		.from(chartOfAccounts)
		.where(
			sql`${chartOfAccounts.organizationId} = ${orgId}
				AND ${chartOfAccounts.accountType} IN ('long_term_liabilities','other_current_liabilities')`,
		)
		.orderBy(asc(chartOfAccounts.accountNumber));

	const interestExpenseAccounts = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
			detailType: chartOfAccounts.detailType,
		})
		.from(chartOfAccounts)
		.where(
			sql`${chartOfAccounts.organizationId} = ${orgId}
				AND ${chartOfAccounts.accountType} IN ('expenses','other_expense')
				AND (lower(${chartOfAccounts.accountName}) LIKE '%interest%' OR ${chartOfAccounts.detailType} LIKE '%interest%')`,
		)
		.orderBy(asc(chartOfAccounts.accountNumber));

	const lenderContacts = await db
		.select({ id: contacts.id, contactName: contacts.contactName })
		.from(contacts)
		.where(sql`${contacts.organizationId} = ${orgId} AND ${contacts.isActive} = true`)
		.orderBy(asc(contacts.contactName));

	// Active + draft assets, plus the currently-linked asset even if it
	// somehow ended up disposed (keep the dropdown showing the value the
	// user can see on the loan).
	const includeIds: string[] = [];
	if (loan.collateralAssetId) includeIds.push(loan.collateralAssetId);
	const collateralAssetRows = await db
		.select({
			id: fixedAssets.id,
			name: fixedAssets.name,
			assetNumber: fixedAssets.assetNumber,
			categoryName: assetCategories.name,
			status: fixedAssets.status,
		})
		.from(fixedAssets)
		.innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
		.where(
			and(
				eq(fixedAssets.organizationId, orgId),
				includeIds.length > 0
					? sql`(${fixedAssets.status} IN ('active','draft') OR ${fixedAssets.id} = ANY(${includeIds}))`
					: inArray(fixedAssets.status, ['active', 'draft']),
			),
		)
		.orderBy(asc(fixedAssets.name));
	const collateralAssets: AssetOption[] = collateralAssetRows.map((a) => ({
		id: a.id,
		label: a.assetNumber ? `${a.name} · #${a.assetNumber}` : a.name,
		categoryName: a.categoryName,
	}));

	return (
		<div className="flex flex-col gap-4">
			<header>
				<h1 className="text-2xl font-semibold">Edit loan</h1>
				<p className="text-sm text-zinc-500 dark:text-zinc-400">
					{loan.displayName}
				</p>
			</header>
			<LoanForm
				lenderContacts={lenderContacts}
				liabilityAccounts={liabilityAccounts}
				interestExpenseAccounts={interestExpenseAccounts}
				collateralAssets={collateralAssets}
				defaultLiabilityAccountId={loan.liabilityAccountId}
				defaultInterestAccountId={loan.interestExpenseAccountId}
				initial={{
					id: loan.id,
					displayName: loan.displayName,
					lenderContactId: loan.lenderContactId,
					noteDocumentUrl: loan.noteDocumentUrl,
					originalPrincipal: Number(loan.originalPrincipal),
					aprPercent: Math.round(Number(loan.annualInterestRate) * 10000) / 100,
					termMonths: loan.termMonths,
					startDate: loan.startDate,
					firstPaymentDate: loan.firstPaymentDate ?? loan.startDate,
					paymentAmount: loan.paymentAmount !== null ? Number(loan.paymentAmount) : null,
					liabilityAccountId: loan.liabilityAccountId,
					interestExpenseAccountId: loan.interestExpenseAccountId ?? '',
					collateralAssetId: loan.collateralAssetId,
					notes: null,
					postedCount,
				}}
			/>
		</div>
	);
}
