import { eq, asc, and, sql, like } from 'drizzle-orm';
import { db } from '@/db/client';
import { plaidAccounts, chartOfAccounts, plaidRawTransactions, transactions, onboardingState } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { logger } from '@/lib/logger';
import { ConnectBankButton } from './_components/ConnectBankButton';
import { AccountActions } from './_components/AccountRow';
import { ResetPlaidPanel } from './_components/ResetPlaidPanel';
import { ReviewBanner } from './_components/ReviewBanner';

export default async function PlaidIntegrationPage() {
  const orgId = await getCurrentOrgId();

  // Demo workspace: render a fully-populated "as-if-connected" view so the
  // cool tour's bank-connections beat shows what real connected accounts
  // look like, without ever talking to Plaid. No plaid_accounts /
  // plaid_raw_transactions rows are written; all action buttons are inert.
  if (isDemoOrg(orgId)) {
    return <DemoPlaidPageView />;
  }

  const accounts = await db
    .select({
      id: plaidAccounts.id,
      institutionName: plaidAccounts.institutionName,
      accountName: plaidAccounts.accountName,
      last4: plaidAccounts.last4,
      accountType: plaidAccounts.accountType,
      subtype: plaidAccounts.subtype,
      connectionStatus: plaidAccounts.connectionStatus,
      syncStatus: plaidAccounts.syncStatus,
      lastSyncedAt: plaidAccounts.lastSyncedAt,
      balance: plaidAccounts.balance,
      chartOfAccountId: plaidAccounts.chartOfAccountId,
      inScope: plaidAccounts.inScope,
      createdAt: plaidAccounts.createdAt,
    })
    .from(plaidAccounts)
    .where(eq(plaidAccounts.linkedOrganizationId, orgId))
    .orderBy(asc(plaidAccounts.institutionName), asc(plaidAccounts.accountName));

  const candidates = await db
    .select({ id: chartOfAccounts.id, accountNumber: chartOfAccounts.accountNumber, accountName: chartOfAccounts.accountName })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)))
    .orderBy(asc(chartOfAccounts.accountNumber));

  const [obState] = await db
    .select({ context: onboardingState.context })
    .from(onboardingState)
    .where(eq(onboardingState.orgId, orgId))
    .limit(1);
  const dismissedAt = (obState?.context as { plaidReviewDismissedAt?: string } | null)?.plaidReviewDismissedAt ?? null;

  // Banner shows for accounts that are mapped (so auto-promote *would* fire)
  // but have not been affirmatively scoped in. Suppressed once user dismisses
  // — until a NEW link adds another such account.
  const reviewable = accounts.filter((a) => a.chartOfAccountId && !a.inScope);
  const showBanner =
    reviewable.length > 0 &&
    (!dismissedAt || reviewable.some((a) => a.createdAt && new Date(a.createdAt) > new Date(dismissedAt)));

  const counts = await Promise.all(
    accounts.map(async (a) => {
      try {
        const [rawCount] = await db
          .select({ n: sql<number>`COUNT(*)::int` })
          .from(plaidRawTransactions)
          .where(eq(plaidRawTransactions.plaidAccountId, a.id));

        if (!a.chartOfAccountId) {
          return { id: a.id, raw: rawCount?.n ?? 0, promoted: 0 };
        }

        const [promotedCount] = await db
          .select({ n: sql<number>`COUNT(*)::int` })
          .from(transactions)
          .where(
            and(
              eq(transactions.organizationId, orgId),
              like(transactions.reference, 'plaid:%'),
              eq(transactions.accountId, a.chartOfAccountId),
            ),
          );
        return { id: a.id, raw: rawCount?.n ?? 0, promoted: promotedCount?.n ?? 0 };
      } catch (err) {
        logger.error({ accountId: a.id, err: err instanceof Error ? err.message : err }, 'plaid counts query failed');
        return { id: a.id, raw: 0, promoted: 0 };
      }
    }),
  );
  const countMap = new Map(counts.map((c) => [c.id, c]));

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Plaid · Connected banks</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {accounts.length} linked account(s) · transactions enter the books only for accounts marked &ldquo;in scope&rdquo;
            <span className="ml-2 text-xs text-zinc-400">
              (personal accounts at the same bank stay excluded)
            </span>
          </p>
        </div>
        {isDemoOrg(orgId) ? (
          <div
            className="cursor-not-allowed rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
            title="Bank connections aren't available in the demo workspace"
          >
            🔒 Connect bank — create a workspace first
          </div>
        ) : (
          <ConnectBankButton />
        )}
      </header>

      {showBanner && <ReviewBanner reviewableCount={reviewable.length} />}

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Institution</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Account</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Scope</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Sync</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Last sync</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Raw / Promoted</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Mapping & promotion</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                  No bank accounts connected yet.
                </td>
              </tr>
            )}
            {accounts.map((a) => {
              const c = countMap.get(a.id);
              const pending = (c?.raw ?? 0) - (c?.promoted ?? 0);
              return (
                <tr key={a.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                    <a href={`/integrations/plaid/${a.id}`} className="hover:underline">{a.institutionName}</a>
                  </td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                    <a href={`/integrations/plaid/${a.id}`} className="hover:underline">
                      {a.accountName}
                    </a>{' '}
                    {a.last4 && <span className="text-zinc-400">···{a.last4}</span>}
                    <div className="text-xs text-zinc-500">
                      {a.accountType}{a.subtype && ` / ${a.subtype}`}
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    {a.inScope ? (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                        In books
                      </span>
                    ) : (
                      <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium uppercase text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                        Excluded
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{a.syncStatus}</td>
                  <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">
                    {a.lastSyncedAt ? new Date(a.lastSyncedAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {(c?.raw ?? 0).toLocaleString()} / {(c?.promoted ?? 0).toLocaleString()}
                    {pending > 0 && a.inScope && <div className="text-xs text-amber-600">{pending} pending</div>}
                  </td>
                  <td className="px-4 py-2">
                    <AccountActions
                      plaidAccountId={a.id}
                      currentMappingId={a.chartOfAccountId}
                      inScope={a.inScope}
                      candidates={candidates}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ResetPlaidPanel />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Demo-only render. Hardcoded "3 connected Bank of America accounts" view
// shown only in the demo workspace. No plaid_accounts / plaid_raw_transactions
// rows, no Plaid round-trip. Buttons render but do nothing (type="button",
// aria-disabled). Used by the cool tour's bank-connections beat.
// ---------------------------------------------------------------------------
function DemoPlaidPageView() {
  const now = new Date();
  // Timestamps anchored to "now" so they always look fresh.
  const fmt = (offsetMinutes: number) =>
    new Date(now.getTime() - offsetMinutes * 60_000).toLocaleString();

  type DemoAccount = {
    id: string;
    institution: string;
    accountName: string;
    last4: string;
    accountType: string;
    subtype: string;
    inScope: boolean;
    syncStatus: string;
    lastSyncOffsetMin: number;
    raw: number;
    promoted: number;
    mappingLabel: string;
  };
  const accounts: DemoAccount[] = [
    {
      id: 'demo-plaid-1',
      institution: 'Bank of America',
      accountName: 'Adv Plus Banking',
      last4: '9917',
      accountType: 'depository',
      subtype: 'checking',
      inScope: true,
      syncStatus: 'idle',
      lastSyncOffsetMin: 24,
      raw: 196,
      promoted: 196,
      mappingLabel: '1013 · Bank of America Adv Plus Banking ···9917',
    },
    {
      id: 'demo-plaid-2',
      institution: 'Bank of America',
      accountName: 'Adv Relationship Banking',
      last4: '6084',
      accountType: 'depository',
      subtype: 'checking',
      inScope: true,
      syncStatus: 'idle',
      lastSyncOffsetMin: 23,
      raw: 1955,
      promoted: 1955,
      mappingLabel: '1012 · Bank of America Adv Relationship Banking ···6084',
    },
    {
      id: 'demo-plaid-3',
      institution: 'Bank of America',
      accountName: 'Advantage Savings',
      last4: '5842',
      accountType: 'depository',
      subtype: 'savings',
      inScope: false,
      syncStatus: 'idle',
      lastSyncOffsetMin: 24,
      raw: 0,
      promoted: 0,
      mappingLabel: '1011 · Bank of America Advantage Savings ···5842',
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Plaid · Connected banks</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {accounts.length} linked account(s) · transactions enter the books only for accounts marked &ldquo;in scope&rdquo;
            <span className="ml-2 text-xs text-zinc-400">
              (personal accounts at the same bank stay excluded)
            </span>
          </p>
        </div>
        <button
          type="button"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          aria-disabled="true"
          title="Demo workspace — Connect bank is read-only here"
        >
          + Connect bank
        </button>
      </header>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Institution</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Account</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Scope</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Sync</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Last sync</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Raw / Promoted</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Mapping & promotion</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{a.institution}</td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                  {a.accountName} <span className="text-zinc-400">···{a.last4}</span>
                  <div className="text-xs text-zinc-500">
                    {a.accountType} / {a.subtype}
                  </div>
                </td>
                <td className="px-4 py-2">
                  {a.inScope ? (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                      In books
                    </span>
                  ) : (
                    <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium uppercase text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                      Excluded
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{a.syncStatus}</td>
                <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">
                  {fmt(a.lastSyncOffsetMin)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {a.raw.toLocaleString()} / {a.promoted.toLocaleString()}
                </td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <select
                      className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                      defaultValue="current"
                      aria-disabled="true"
                      title="Demo workspace — mapping is read-only"
                    >
                      <option value="current">{a.mappingLabel}</option>
                    </select>
                    <button
                      type="button"
                      className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                      disabled
                    >
                      Update
                    </button>
                    {a.inScope ? (
                      <button
                        type="button"
                        className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                        aria-disabled="true"
                        title="Demo workspace — Re-sync is read-only"
                      >
                        Re-sync
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700"
                        aria-disabled="true"
                        title="Demo workspace — Add to books is read-only"
                      >
                        Add to books
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm dark:border-red-900/50 dark:bg-red-950/20">
        <summary className="cursor-pointer text-red-800 dark:text-red-300">
          ⚠ Danger zone — reset Plaid data for this org
        </summary>
        <p className="mt-2 text-xs text-red-700 dark:text-red-400">
          Demo workspace — reset is disabled here.
        </p>
      </details>
    </div>
  );
}
