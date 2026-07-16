import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { generalLedger, reconciliationPeriods } from '@/db/schema/schema';

/**
 * Reconciliation coverage helpers — enumerate the months an account should have
 * a reconciliation for (first activity → current month) and list every account
 * that's reconcilable (in-scope Plaid or has statement imports). Used by the
 * backfill-on-link/import path and the monthly cron. The engine itself is
 * idempotent and SKIPs months with no source, so over-enumerating is harmless.
 */

export interface Ym {
  year: number;
  month: number;
}

/** Months from the account's earliest ledger activity through the current month. */
export async function enumerateAccountMonths(orgId: string, accountId: string): Promise<Ym[]> {
  const [r] = await db
    .select({ d: sql<string | null>`min(${generalLedger.date})` })
    .from(generalLedger)
    .where(and(eq(generalLedger.organizationId, orgId), eq(generalLedger.accountId, accountId)));
  if (!r?.d) return [];

  const first = new Date(r.d);
  let y = first.getUTCFullYear();
  let m = first.getUTCMonth() + 1;
  const now = new Date();
  const ny = now.getUTCFullYear();
  const nm = now.getUTCMonth() + 1;

  const out: Ym[] = [];
  while (y < ny || (y === ny && m <= nm)) {
    out.push({ year: y, month: m });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (out.length > 240) break; // safety: 20 years
  }
  return out;
}

/** True if the account already has at least one reconciliation period. */
export async function accountHasReconciliationPeriods(orgId: string, accountId: string): Promise<boolean> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reconciliationPeriods)
    .where(and(eq(reconciliationPeriods.organizationId, orgId), eq(reconciliationPeriods.accountId, accountId)));
  return Number(r?.n ?? 0) > 0;
}

export interface ReconcilableAccount {
  organizationId: string;
  accountId: string;
}

/**
 * Every (org, GL account) that has a reconciliation source: an in-scope Plaid
 * account mapped to a CoA, or a bank-statement import. Used by the monthly cron.
 */
export async function reconcilableAccounts(): Promise<ReconcilableAccount[]> {
  const rows = (await db.execute(sql`
    select distinct organization_id, account_id from (
      select linked_organization_id as organization_id, chart_of_account_id as account_id
        from plaid_accounts
        where in_scope is true and chart_of_account_id is not null and linked_organization_id is not null
      union
      select organization_id, account_id
        from imports
        where import_method = 'bank_statement' and account_id is not null
    ) t
  `)) as unknown as Array<{ organization_id: string; account_id: string }>;
  return rows.map((r) => ({ organizationId: String(r.organization_id), accountId: String(r.account_id) }));
}

/** The calendar month that just ended, relative to `now` (UTC). */
export function priorMonth(now: Date): Ym {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}
