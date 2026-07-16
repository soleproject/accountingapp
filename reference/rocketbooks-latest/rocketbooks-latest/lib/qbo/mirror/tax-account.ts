import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Find (or create) the Sales Tax Payable account for an org. Invoice JEs
 * credit this account for the tax portion of each invoice. Migration
 * doesn't seed it -- we create it lazily the first time a taxable
 * invoice is mirrored.
 *
 * Match priority:
 *   1. Existing account with detailType='SalesTaxPayable' (what QBO's
 *      AccountSubType maps to)
 *   2. Existing account named "Sales Tax Payable" (case-insensitive
 *      handled by accountName equality since the user is unlikely to
 *      have variant casing)
 *   3. Create a new one as gaapType='liability', accountType=
 *      'other_current_liability', detailType='SalesTaxPayable'
 */
export async function ensureSalesTaxPayableAccount(
  organizationId: string,
  tx: Tx | typeof db = db,
): Promise<string> {
  const [bySlot] = await tx
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(
      eq(chartOfAccounts.organizationId, organizationId),
      eq(chartOfAccounts.detailType, 'SalesTaxPayable'),
    ))
    .limit(1);
  if (bySlot) return bySlot.id;

  const [byName] = await tx
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(
      eq(chartOfAccounts.organizationId, organizationId),
      eq(chartOfAccounts.accountName, 'Sales Tax Payable'),
    ))
    .limit(1);
  if (byName) return byName.id;

  const id = randomUUID();
  await tx.insert(chartOfAccounts).values({
    id,
    organizationId,
    accountNumber: `qbo:sales_tax_payable`,
    accountName: 'Sales Tax Payable',
    gaapType: 'liability',
    accountType: 'other_current_liability',
    detailType: 'SalesTaxPayable',
    normalBalance: 'credit',
    isActive: true,
    passedNameContactCheck: false,
  });
  return id;
}

/**
 * Sister to ensureSalesTaxPayableAccount but for the EXPENSE side --
 * sales tax PAID on vendor bills. In US small business, sales tax paid
 * on purchases is typically expensed (not recovered like VAT), so it
 * lands in an expense account named "Sales Tax Expense".
 *
 * Match priority mirrors the payable helper: by detailType, then by
 * name, then create.
 */
export async function ensureSalesTaxExpenseAccount(
  organizationId: string,
  tx: Tx | typeof db = db,
): Promise<string> {
  const [bySlot] = await tx
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(
      eq(chartOfAccounts.organizationId, organizationId),
      eq(chartOfAccounts.detailType, 'TaxesPaid'),
    ))
    .limit(1);
  if (bySlot) return bySlot.id;

  const [byName] = await tx
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(
      eq(chartOfAccounts.organizationId, organizationId),
      eq(chartOfAccounts.accountName, 'Sales Tax Expense'),
    ))
    .limit(1);
  if (byName) return byName.id;

  const id = randomUUID();
  await tx.insert(chartOfAccounts).values({
    id,
    organizationId,
    accountNumber: `qbo:sales_tax_expense`,
    accountName: 'Sales Tax Expense',
    gaapType: 'expense',
    accountType: 'expense',
    detailType: 'TaxesPaid',
    normalBalance: 'debit',
    isActive: true,
    passedNameContactCheck: false,
  });
  return id;
}
