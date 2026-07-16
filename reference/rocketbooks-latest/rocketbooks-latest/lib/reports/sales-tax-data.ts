import 'server-only';
import { and, asc, desc, eq, gte, ilike, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { generalLedger, chartOfAccounts, organizations, contacts } from '@/db/schema/schema';
import { generalLedgerBasisFilter, type ReportBasis } from './basis-filter';

/**
 * Sales Tax Liability report. Invoices already credit a "Sales Tax Payable"
 * liability account for the tax they collect (lib/qbo/mirror/tax-account.ts),
 * and remittances debit it — so the running liability lives in that account's
 * general-ledger activity. This reads it: opening balance, tax collected and
 * remitted over a period, the ending balance still owed, and the line detail.
 * No new schema — purely derived from the GL.
 */

export interface SalesTaxLine {
  id: string;
  date: string | null;
  memo: string | null;
  contactName: string | null;
  collected: number; // credit to the payable (tax charged to customers)
  remitted: number; // debit to the payable (tax paid to the authority)
}

export interface SalesTaxData {
  organizationName: string;
  fromDate: string;
  toDate: string;
  hasAccount: boolean;
  accountNames: string[];
  openingBalance: number;
  collected: number;
  remitted: number;
  endingBalance: number;
  lines: SalesTaxLine[];
  linesCapped: boolean;
}

const LINE_CAP = 500;

export async function loadSalesTaxLiability(
  orgId: string,
  fromDate: string,
  toDate: string,
  basis: ReportBasis = 'accrual',
): Promise<SalesTaxData> {
  const [orgRow] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const organizationName = orgRow?.name ?? 'Organization';

  // Identify the Sales Tax Payable account(s) — by the QBO detail slot or name.
  const taxAccounts = await db
    .select({ id: chartOfAccounts.id, name: chartOfAccounts.accountName })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.organizationId, orgId),
        or(eq(chartOfAccounts.detailType, 'SalesTaxPayable'), ilike(chartOfAccounts.accountName, '%sales tax payable%')),
      ),
    );

  const empty: SalesTaxData = {
    organizationName,
    fromDate,
    toDate,
    hasAccount: false,
    accountNames: [],
    openingBalance: 0,
    collected: 0,
    remitted: 0,
    endingBalance: 0,
    lines: [],
    linesCapped: false,
  };
  if (taxAccounts.length === 0) return empty;

  const accountIds = taxAccounts.map((a) => a.id);
  const fromTs = `${fromDate}T00:00:00`;
  const toTs = `${toDate}T23:59:59`;

  const scope = and(
    eq(generalLedger.organizationId, orgId),
    inArray(generalLedger.accountId, accountIds),
    generalLedgerBasisFilter(basis),
  );

  const [openingRow, periodRow, lineRows] = await Promise.all([
    // Opening liability = credits − debits before the window (credit-normal account).
    db
      .select({
        credit: sql<string>`COALESCE(SUM(${generalLedger.credit}), 0)`.as('c'),
        debit: sql<string>`COALESCE(SUM(${generalLedger.debit}), 0)`.as('d'),
      })
      .from(generalLedger)
      .where(and(scope, lt(generalLedger.date, fromTs))),
    db
      .select({
        credit: sql<string>`COALESCE(SUM(${generalLedger.credit}), 0)`.as('c'),
        debit: sql<string>`COALESCE(SUM(${generalLedger.debit}), 0)`.as('d'),
      })
      .from(generalLedger)
      .where(and(scope, gte(generalLedger.date, fromTs), lte(generalLedger.date, toTs))),
    db
      .select({
        id: generalLedger.id,
        date: generalLedger.date,
        memo: generalLedger.memo,
        debit: generalLedger.debit,
        credit: generalLedger.credit,
        contactName: contacts.contactName,
      })
      .from(generalLedger)
      .leftJoin(contacts, eq(contacts.id, generalLedger.contactId))
      .where(and(scope, gte(generalLedger.date, fromTs), lte(generalLedger.date, toTs)))
      .orderBy(desc(generalLedger.date), asc(generalLedger.id))
      .limit(LINE_CAP + 1),
  ]);

  const openingBalance = Number(openingRow[0]?.credit ?? 0) - Number(openingRow[0]?.debit ?? 0);
  const collected = Number(periodRow[0]?.credit ?? 0);
  const remitted = Number(periodRow[0]?.debit ?? 0);
  const endingBalance = openingBalance + collected - remitted;

  const linesCapped = lineRows.length > LINE_CAP;
  const lines: SalesTaxLine[] = lineRows.slice(0, LINE_CAP).map((r) => ({
    id: r.id,
    date: r.date,
    memo: r.memo,
    contactName: r.contactName ?? null,
    collected: Number(r.credit ?? 0),
    remitted: Number(r.debit ?? 0),
  }));

  return {
    organizationName,
    fromDate,
    toDate,
    hasAccount: true,
    accountNames: taxAccounts.map((a) => a.name),
    openingBalance,
    collected,
    remitted,
    endingBalance,
    lines,
    linesCapped,
  };
}
