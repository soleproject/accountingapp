import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { assetCategories, chartOfAccounts, contacts, fixedAssets } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { LoanForm, type AssetOption } from '../_components/LoanForm';

export default async function NewLoanPage() {
	const orgId = await getCurrentOrgId();

	// Liability candidates: anything whose account_type is liability. We
	// default-pick by detail_type preference (notes_payable > long_term_
	// liability > other_current_liability) so the first long-term loan
	// account auto-fills.
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

	// Collateral asset picker — active + draft only; disposed assets can't
	// take on new debt. Joined with the category name so the dropdown
	// can show "Test IP (Intangibles & IP)" instead of just the asset name.
	const collateralAssetRows = await db
		.select({
			id: fixedAssets.id,
			name: fixedAssets.name,
			assetNumber: fixedAssets.assetNumber,
			categoryName: assetCategories.name,
		})
		.from(fixedAssets)
		.innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
		.where(
			and(
				eq(fixedAssets.organizationId, orgId),
				inArray(fixedAssets.status, ['active', 'draft']),
			),
		)
		.orderBy(asc(fixedAssets.name));
	const collateralAssets: AssetOption[] = collateralAssetRows.map((a) => ({
		id: a.id,
		label: a.assetNumber ? `${a.name} · #${a.assetNumber}` : a.name,
		categoryName: a.categoryName,
	}));

	// Default picks: first long-term, otherwise first liability; first
	// interest expense match. Form treats these as defaults the user can
	// override via the dropdown.
	const defaultLiabilityId =
		liabilityAccounts.find((a) =>
			['notes_payable', 'long_term_liability'].includes(a.detailType ?? ''),
		)?.id
		?? liabilityAccounts[0]?.id
		?? null;
	const defaultInterestId = interestExpenseAccounts[0]?.id ?? null;

	return (
		<div className="flex flex-col gap-4">
			<header>
				<h1 className="text-2xl font-semibold">New loan</h1>
				<p className="text-sm text-zinc-500 dark:text-zinc-400">
					Mortgages, auto loans, SBA notes, lines of credit — anything you owe
					with a fixed-rate amortizing payment.
				</p>
			</header>
			<LoanForm
				lenderContacts={lenderContacts}
				liabilityAccounts={liabilityAccounts}
				interestExpenseAccounts={interestExpenseAccounts}
				collateralAssets={collateralAssets}
				defaultLiabilityAccountId={defaultLiabilityId}
				defaultInterestAccountId={defaultInterestId}
			/>
			{(liabilityAccounts.length === 0 || interestExpenseAccounts.length === 0) && (
				<div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
					{liabilityAccounts.length === 0 && (
						<div>
							No liability accounts on this org yet. Add one in{' '}
							<a className="underline" href="/chart-of-accounts">
								Chart of Accounts
							</a>{' '}
							before creating a loan.
						</div>
					)}
					{interestExpenseAccounts.length === 0 && (
						<div className="mt-1">
							No interest-expense account found. Create one (e.g. <em>Loan
							interest</em>) in the Chart of Accounts.
						</div>
					)}
				</div>
			)}
		</div>
	);
}
