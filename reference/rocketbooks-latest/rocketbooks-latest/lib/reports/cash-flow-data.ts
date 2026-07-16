import 'server-only';
import { eq, and, asc, gte, lte, lt, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  chartOfAccounts,
  generalLedger,
  journalEntries,
  journalEntryLines,
  organizations,
} from '@/db/schema/schema';
import {
  generalLedgerBasisFilter,
  inlineBasisFilter,
  type ReportBasis,
} from './basis-filter';

export type CashFlowMode = 'simple' | 'real';

export type CashFlowSectionId =
  | 'cash_accounts'
  | 'operating'
  | 'investing'
  | 'financing'
  | 'unclassified';

export interface CashFlowRow {
  /** null for synthetic rows (e.g., grand totals, beginning/ending cash). */
  accountId: string | null;
  accountNumber: string | null;
  accountName: string;
  gaapType: string | null;
  accountType: string | null;
  inflow: number;
  outflow: number;
  net: number;
}

export interface CashFlowSection {
  id: CashFlowSectionId;
  title: string;
  rows: CashFlowRow[];
  inflow: number;
  outflow: number;
  net: number;
}

export interface CashFlowData {
  organizationName: string;
  fromDate: string;
  toDate: string;
  mode: CashFlowMode;
  /** IDs of the cash-like accounts driving the report (used for drilldown). */
  cashAccountIds: string[];
  sections: CashFlowSection[];
  totals: {
    cashIn: number;
    cashOut: number;
    netChange: number;
    operating: number;
    investing: number;
    financing: number;
    unclassified: number;
  };
  beginningCash: number;
  endingCash: number;
}

/**
 * Classify a non-cash account into Operating / Investing / Financing per the
 * standard direct-method cash flow conventions. Falls back to operating for
 * anything that doesn't clearly fit a long-term asset / long-term liability
 * / equity bucket — operating is the safe default for working-capital items
 * (AR, AP, prepaid, accrued, etc.).
 */
function classifyForCashFlow(
  gaap: string | null,
  type: string | null,
): Exclude<CashFlowSectionId, 'cash_accounts'> {
  const g = (gaap ?? '').toLowerCase();
  const t = (type ?? '').toLowerCase();

  // Financing: long-term debt, equity contributions / draws
  if (
    t === 'long_term_liability' ||
    t === 'long_term_liabilities' ||
    t === 'notes_payable'
  ) {
    return 'financing';
  }
  if (g === 'equity') return 'financing';

  // Investing: long-term assets
  if (
    t === 'fixed_asset' ||
    t === 'fixed_assets' ||
    g === 'fixed_asset' ||
    g === 'other_asset'
  ) {
    return 'investing';
  }

  // Everything else (income / expense / COGS / AR / AP / prepaid / accrued /
  // credit card / other current liability) → operating.
  return 'operating';
}

const SECTION_TITLES: Record<CashFlowSectionId, string> = {
  cash_accounts: 'Cash account movements',
  operating: 'Operating activities',
  investing: 'Investing activities',
  financing: 'Financing activities',
  unclassified: 'Unclassified',
};

export async function loadCashFlow(
  orgId: string,
  fromDate: string,
  toDate: string,
  mode: CashFlowMode,
  basis: ReportBasis = 'accrual',
): Promise<CashFlowData> {
  const [orgRow, cashAccounts] = await Promise.all([
    db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
    db
      .select({
        id: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
        gaapType: chartOfAccounts.gaapType,
        accountType: chartOfAccounts.accountType,
      })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.organizationId, orgId),
          eq(chartOfAccounts.accountType, 'bank'),
          eq(chartOfAccounts.isActive, true),
        ),
      )
      .orderBy(asc(chartOfAccounts.accountNumber)),
  ]);

  const cashIds = cashAccounts.map((a) => a.id);
  const organizationName = orgRow[0]?.name ?? 'Organization';

  // Empty result shell — used both when there are no cash accounts and when
  // there's no activity in the period.
  const empty: CashFlowData = {
    organizationName,
    fromDate,
    toDate,
    mode,
    cashAccountIds: cashIds,
    sections: [],
    totals: {
      cashIn: 0,
      cashOut: 0,
      netChange: 0,
      operating: 0,
      investing: 0,
      financing: 0,
      unclassified: 0,
    },
    beginningCash: 0,
    endingCash: 0,
  };

  if (cashIds.length === 0) return empty;

  // Beginning / ending cash via raw GL movement on cash accounts. These
  // anchor the report regardless of mode.
  const [beginRow, endRow] = await Promise.all([
    db
      .select({
        debit: sql<string>`COALESCE(SUM(${generalLedger.debit}), 0)`,
        credit: sql<string>`COALESCE(SUM(${generalLedger.credit}), 0)`,
      })
      .from(generalLedger)
      .where(
        and(
          eq(generalLedger.organizationId, orgId),
          inArray(generalLedger.accountId, cashIds),
          lt(generalLedger.date, `${fromDate}T00:00:00`),
          generalLedgerBasisFilter(basis),
        ),
      ),
    db
      .select({
        debit: sql<string>`COALESCE(SUM(${generalLedger.debit}), 0)`,
        credit: sql<string>`COALESCE(SUM(${generalLedger.credit}), 0)`,
      })
      .from(generalLedger)
      .where(
        and(
          eq(generalLedger.organizationId, orgId),
          inArray(generalLedger.accountId, cashIds),
          lte(generalLedger.date, `${toDate}T23:59:59`),
          generalLedgerBasisFilter(basis),
        ),
      ),
  ]);
  const beginningCash = Number(beginRow[0]?.debit ?? 0) - Number(beginRow[0]?.credit ?? 0);
  const endingCash = Number(endRow[0]?.debit ?? 0) - Number(endRow[0]?.credit ?? 0);

  if (mode === 'simple') {
    // Per-cash-account inflows / outflows over the period.
    const rows = await db
      .select({
        accountId: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
        gaapType: chartOfAccounts.gaapType,
        accountType: chartOfAccounts.accountType,
        totalDebit: sql<string>`COALESCE(SUM(${generalLedger.debit}), 0)`.as('total_debit'),
        totalCredit: sql<string>`COALESCE(SUM(${generalLedger.credit}), 0)`.as('total_credit'),
      })
      .from(generalLedger)
      .innerJoin(chartOfAccounts, eq(generalLedger.accountId, chartOfAccounts.id))
      .where(
        and(
          eq(generalLedger.organizationId, orgId),
          inArray(generalLedger.accountId, cashIds),
          gte(generalLedger.date, `${fromDate}T00:00:00`),
          lte(generalLedger.date, `${toDate}T23:59:59`),
          generalLedgerBasisFilter(basis),
        ),
      )
      .groupBy(
        chartOfAccounts.id,
        chartOfAccounts.accountNumber,
        chartOfAccounts.accountName,
        chartOfAccounts.gaapType,
        chartOfAccounts.accountType,
      )
      .orderBy(asc(chartOfAccounts.accountNumber));

    const cashSection: CashFlowSection = {
      id: 'cash_accounts',
      title: SECTION_TITLES.cash_accounts,
      rows: rows.map((r) => {
        const inflow = Number(r.totalDebit);
        const outflow = Number(r.totalCredit);
        return {
          accountId: r.accountId,
          accountNumber: r.accountNumber,
          accountName: r.accountName,
          gaapType: r.gaapType,
          accountType: r.accountType,
          inflow,
          outflow,
          net: inflow - outflow,
        };
      }),
      inflow: 0,
      outflow: 0,
      net: 0,
    };
    cashSection.inflow = cashSection.rows.reduce((s, r) => s + r.inflow, 0);
    cashSection.outflow = cashSection.rows.reduce((s, r) => s + r.outflow, 0);
    cashSection.net = cashSection.inflow - cashSection.outflow;

    return {
      ...empty,
      sections: cashSection.rows.length > 0 ? [cashSection] : [],
      totals: {
        ...empty.totals,
        cashIn: cashSection.inflow,
        cashOut: cashSection.outflow,
        netChange: cashSection.net,
      },
      beginningCash,
      endingCash,
    };
  }

  // ── REAL mode ──────────────────────────────────────────────────────
  // For every JE that touched a cash account in the period, look at the
  // *non-cash* lines on that JE and classify each by Operating / Investing
  // / Financing. The cash direction is the opposite of the non-cash line:
  //   non-cash DEBIT  → cash credited → cash OUTFLOW
  //   non-cash CREDIT → cash debited  → cash INFLOW
  const lines = await db
    .select({
      accountId: journalEntryLines.accountId,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
      accountType: chartOfAccounts.accountType,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(chartOfAccounts, eq(journalEntryLines.accountId, chartOfAccounts.id))
    .where(
      and(
        eq(journalEntries.organizationId, orgId),
        gte(journalEntries.date, `${fromDate}T00:00:00`),
        lte(journalEntries.date, `${toDate}T23:59:59`),
        notInArray(journalEntryLines.accountId, cashIds),
        // Only lines whose parent JE has a cash-side line — i.e. JEs that
        // moved cash. Subquery keeps the filter set-based and indexed.
        inArray(
          journalEntryLines.journalEntryId,
          db
            .select({ jeid: journalEntryLines.journalEntryId })
            .from(journalEntryLines)
            .where(inArray(journalEntryLines.accountId, cashIds)),
        ),
        // Cash-basis filter: cuts invoice/bill JEs out entirely.
        inlineBasisFilter(basis),
      ),
    );

  const buckets: Record<
    Exclude<CashFlowSectionId, 'cash_accounts'>,
    Map<string, CashFlowRow>
  > = {
    operating: new Map(),
    investing: new Map(),
    financing: new Map(),
    unclassified: new Map(),
  };

  for (const l of lines) {
    if (!l.accountId) continue;
    const cls = classifyForCashFlow(l.gaapType, l.accountType);
    const bucket = buckets[cls];
    let row = bucket.get(l.accountId);
    if (!row) {
      row = {
        accountId: l.accountId,
        accountNumber: l.accountNumber,
        accountName: l.accountName ?? '',
        gaapType: l.gaapType,
        accountType: l.accountType,
        inflow: 0,
        outflow: 0,
        net: 0,
      };
      bucket.set(l.accountId, row);
    }
    const debit = Number(l.debit ?? 0);
    const credit = Number(l.credit ?? 0);
    // non-cash debit → cash outflow ; non-cash credit → cash inflow
    row.outflow += debit;
    row.inflow += credit;
    row.net = row.inflow - row.outflow;
  }

  const sections: CashFlowSection[] = (
    ['operating', 'investing', 'financing', 'unclassified'] as const
  )
    .map((id) => {
      const rows = Array.from(buckets[id].values()).sort((a, b) => {
        const an = a.accountNumber ?? '';
        const bn = b.accountNumber ?? '';
        return an.localeCompare(bn);
      });
      const inflow = rows.reduce((s, r) => s + r.inflow, 0);
      const outflow = rows.reduce((s, r) => s + r.outflow, 0);
      return {
        id,
        title: SECTION_TITLES[id],
        rows,
        inflow,
        outflow,
        net: inflow - outflow,
      };
    })
    .filter((s) => s.rows.length > 0);

  const totals = {
    cashIn: sections.reduce((s, x) => s + x.inflow, 0),
    cashOut: sections.reduce((s, x) => s + x.outflow, 0),
    netChange: sections.reduce((s, x) => s + x.net, 0),
    operating: sections.find((s) => s.id === 'operating')?.net ?? 0,
    investing: sections.find((s) => s.id === 'investing')?.net ?? 0,
    financing: sections.find((s) => s.id === 'financing')?.net ?? 0,
    unclassified: sections.find((s) => s.id === 'unclassified')?.net ?? 0,
  };

  return {
    organizationName,
    fromDate,
    toDate,
    mode,
    cashAccountIds: cashIds,
    sections,
    totals,
    beginningCash,
    endingCash,
  };
}
