/**
 * One-time catch-up for accounts that synced/imported BEFORE the
 * auto-reconciliation feature shipped. For each reconcilable account
 * (in-scope Plaid or with bank-statement imports) it:
 *   1. Sets the opening balance (Plaid: current − ledger; statement: earliest
 *      statement's starting_balance), if not already set.
 *   2. Backfills a reconciliation for every month from first activity → now
 *      by calling the engine directly (idempotent; no task spam — historical
 *      OPEN months surface via the "reconciliation off" attention card).
 *
 * Usage (PowerShell):
 *   $env:POSTGRES_URL = "<prod non-pooling url>"
 *   npx tsx scripts/backfill-reconciliations.ts --org <uuid> --dry-run
 *   npx tsx scripts/backfill-reconciliations.ts --org <uuid>
 *   npx tsx scripts/backfill-reconciliations.ts --all          # every org
 *
 * Re-runnable: opening balances are idempotent; the engine upserts periods.
 * Plaid accounts with a NULL stored balance are best-effort live-fetched from
 * Plaid (needs PLAID_* + token-encryption env); if unavailable, opening is
 * skipped and the next sync fixes it.
 */
import { readFileSync } from 'fs';

function readEnvLocal(k: string): string | null {
  try {
    for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      const m = l.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env.local — rely on process.env */
  }
  return null;
}

interface Args {
  orgId: string | null;
  all: boolean;
  dryRun: boolean;
}
function parseArgs(): Args {
  const a = process.argv.slice(2);
  const orgIdx = a.indexOf('--org');
  return {
    orgId: orgIdx >= 0 ? a[orgIdx + 1] ?? null : null,
    all: a.includes('--all'),
    dryRun: a.includes('--dry-run'),
  };
}

async function main() {
  // Prefer an explicit POSTGRES_URL; otherwise fall back to the non-pooling url
  // from .env.local (direct connection is safest for a long-running script).
  if (!process.env.POSTGRES_URL) {
    const url = readEnvLocal('POSTGRES_URL_NON_POOLING') ?? readEnvLocal('POSTGRES_URL');
    if (!url) throw new Error('Set POSTGRES_URL or have POSTGRES_URL_NON_POOLING in .env.local');
    process.env.POSTGRES_URL = url;
  }
  // Mirror Plaid/encryption env from .env.local if not already set (for the
  // best-effort live balance fetch).
  for (const k of ['PLAID_ENV', 'PLAID_CLIENT_ID', 'PLAID_SECRET', 'TOKEN_ENCRYPTION_KEY', 'ENCRYPTION_KEY']) {
    if (!process.env[k]) {
      const v = readEnvLocal(k);
      if (v) process.env[k] = v;
    }
  }

  const args = parseArgs();
  if (!args.orgId && !args.all) {
    console.error('Refusing to run: pass --org <uuid> or --all (use --dry-run first).');
    process.exit(1);
  }

  const { db } = await import('@/db/client');
  const { chartOfAccounts, plaidAccounts, plaidRawTransactions, imports, organizations } = await import('@/db/schema/schema');
  const { and, eq, sql, asc } = await import('drizzle-orm');
  const { reconcileAccountMonth } = await import('@/lib/reconciliation/engine');
  const { setAccountOpeningBalance, setOpeningBalanceFromCurrent } = await import('@/lib/accounting/opening-balance');
  const { enumerateAccountMonths, reconcilableAccounts } = await import('@/lib/reconciliation/backfill');

  // --- gather target accounts -------------------------------------------------
  let accounts = await reconcilableAccounts();
  if (args.orgId) accounts = accounts.filter((a) => a.organizationId === args.orgId);
  console.log(`${args.dryRun ? '[DRY RUN] ' : ''}backfilling ${accounts.length} reconcilable account(s)${args.orgId ? ` in org ${args.orgId}` : ' across all orgs'}\n`);

  const totals = { openingsSet: 0, openingsSkipped: 0, periods: { reconciled: 0, open: 0, skipped: 0 } };

  for (const acct of accounts) {
    const [coa] = await db
      .select({
        name: chartOfAccounts.accountName,
        normalBalance: chartOfAccounts.normalBalance,
        startingBalanceDate: chartOfAccounts.startingBalanceDate,
      })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.id, acct.accountId), eq(chartOfAccounts.organizationId, acct.organizationId)))
      .limit(1);
    if (!coa) continue;
    const label = `${coa.name} (${acct.accountId.slice(0, 8)}…)`;

    // --- in-scope Plaid accounts mapped to this CoA --------------------------
    const plaids = await db
      .select({ id: plaidAccounts.id, balance: plaidAccounts.balance, token: plaidAccounts.plaidAccessToken, plaidAccountId: plaidAccounts.plaidAccountId })
      .from(plaidAccounts)
      .where(
        and(
          eq(plaidAccounts.linkedOrganizationId, acct.organizationId),
          eq(plaidAccounts.chartOfAccountId, acct.accountId),
          eq(plaidAccounts.inScope, true),
        ),
      );

    // --- opening balance -----------------------------------------------------
    let openingPlan = 'none';
    if (coa.startingBalanceDate) {
      openingPlan = `already set (${coa.startingBalanceDate})`;
    } else if (plaids.length > 0) {
      // Plaid path: current balance − ledger. Live-fetch the balance if missing.
      let currentBalance: number | null = null;
      for (const p of plaids) if (p.balance != null) currentBalance = (currentBalance ?? 0) + Number(p.balance);
      if (currentBalance == null && !args.dryRun) {
        currentBalance = await fetchLivePlaidBalance(plaids).catch(() => null);
      }
      const [firstTxn] = await db
        .select({ d: sql<string | null>`min(${plaidRawTransactions.date})` })
        .from(plaidRawTransactions)
        .where(sql`${plaidRawTransactions.plaidAccountId} in (${sql.join(plaids.map((p) => sql`${p.id}`), sql`, `)})`);
      if (currentBalance == null || !firstTxn?.d) {
        openingPlan = currentBalance == null ? 'plaid: no balance (skip — next sync fixes)' : 'plaid: no txns';
      } else {
        const asOf = dayBefore(firstTxn.d);
        openingPlan = `plaid: current ${currentBalance} as of ${asOf}`;
        if (!args.dryRun) {
          const r = await setOpeningBalanceFromCurrent({ organizationId: acct.organizationId, accountId: acct.accountId, currentBalance, asOfDate: asOf });
          openingPlan += r.skipped ? ' (skipped)' : ` → JE ${r.journalEntryId?.slice(0, 8) ?? '—'}`;
        }
      }
    } else {
      // Statement path: earliest bank-statement import's starting_balance.
      const [stmt] = await db
        .select({ startDate: imports.startDate, raw: imports.veryfiRawJson })
        .from(imports)
        .where(and(eq(imports.organizationId, acct.organizationId), eq(imports.accountId, acct.accountId), eq(imports.importMethod, 'bank_statement')))
        .orderBy(asc(imports.startDate))
        .limit(1);
      const doc = stmt?.raw ? (safeJson(stmt.raw) as Record<string, unknown>) : null;
      const startBal = doc ? (doc.starting_balance ?? doc.opening_balance) : null;
      const periodStart = (doc?.period_start_date as string) ?? stmt?.startDate ?? null;
      if (startBal == null || periodStart == null) {
        openingPlan = 'statement: no starting_balance';
      } else {
        const raw = Number(startBal);
        const amount = coa.normalBalance === 'credit' ? Math.abs(raw) : raw;
        const asOf = dayBefore(String(periodStart).slice(0, 10));
        openingPlan = `statement: ${amount} as of ${asOf}`;
        if (!args.dryRun) {
          const r = await setAccountOpeningBalance({ organizationId: acct.organizationId, accountId: acct.accountId, amount, asOfDate: asOf, source: 'statement' });
          openingPlan += r.skipped ? ' (skipped)' : ` → JE ${r.journalEntryId?.slice(0, 8) ?? '—'}`;
        }
      }
    }
    if (!args.dryRun) {
      if (openingPlan.includes('skip') || openingPlan.startsWith('already') || openingPlan.includes('no ')) totals.openingsSkipped++;
      else totals.openingsSet++;
    }

    // --- backfill monthly reconciliations -----------------------------------
    const months = await enumerateAccountMonths(acct.organizationId, acct.accountId);
    let reconciled = 0, open = 0, skipped = 0;
    if (!args.dryRun) {
      for (const m of months) {
        try {
          // Retry transient Supabase connection drops (the AI-match latency
          // between queries can let the session connection idle out).
          const res = await withRetry(() =>
            reconcileAccountMonth({ organizationId: acct.organizationId, accountId: acct.accountId, year: m.year, month: m.month, triggeredBy: 'backfill' }),
          );
          if (res.status === 'RECONCILED') reconciled++;
          else if (res.status === 'OPEN') open++;
          else skipped++;
        } catch (e) {
          skipped++;
          console.error(`  ! ${label} ${m.year}-${m.month}:`, e instanceof Error ? e.message : e);
        }
      }
      totals.periods.reconciled += reconciled;
      totals.periods.open += open;
      totals.periods.skipped += skipped;
    }

    console.log(
      `• ${label} [${coa.normalBalance}] — opening: ${openingPlan}; months: ${months.length}` +
        (args.dryRun ? '' : ` → reconciled ${reconciled}, open ${open}, skipped ${skipped}`),
    );
  }

  // helpers ------------------------------------------------------------------
  async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 700));
      }
    }
    throw lastErr;
  }
  function dayBefore(iso: string): string {
    return new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  }
  function safeJson(s: string): unknown {
    try { return JSON.parse(s); } catch { return null; }
  }
  async function fetchLivePlaidBalance(ps: Array<{ id: string; token: string; plaidAccountId: string | null }>): Promise<number | null> {
    const { plaid } = await import('@/lib/plaid/client');
    const { decryptToken } = await import('@/lib/plaid/encryption');
    let total: number | null = null;
    for (const p of ps) {
      try {
        const bal = await plaid.accountsGet({ access_token: decryptToken(p.token) });
        const match = bal.data.accounts.find((a) => a.account_id === p.plaidAccountId);
        if (match) {
          const v = Number(match.balances.current ?? match.balances.available ?? 0);
          total = (total ?? 0) + v;
          await db.update(plaidAccounts).set({ balance: String(v) }).where(eq(plaidAccounts.id, p.id));
        }
      } catch { /* best effort */ }
    }
    return total;
  }

  console.log('\n' + (args.dryRun ? '[DRY RUN] no writes made.' : 'Done.'));
  if (!args.dryRun) {
    console.log(`openings set: ${totals.openingsSet}, skipped: ${totals.openingsSkipped}`);
    console.log(`periods — reconciled: ${totals.periods.reconciled}, open: ${totals.periods.open}, skipped (no source): ${totals.periods.skipped}`);
  }
  void organizations;
  process.exit(0);
}

main().catch((e) => { console.error('BACKFILL FAILED:', e); process.exit(1); });
