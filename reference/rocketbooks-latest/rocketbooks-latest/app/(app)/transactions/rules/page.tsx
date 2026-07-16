import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requirePermission, hasAnyPermission } from '@/lib/auth/permissions';
import { getCurrentOrgId } from '@/lib/auth/org';
import { and, eq, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';
import { listRules, suggestRules } from '@/lib/accounting/rule-promotion';
import { createRuleAction, deleteRuleAction } from './_actions/rules';

/**
 * Categorization rules management — the accountant-facing half of the
 * rule-promotion loop. Lists existing deterministic rules and one-click
 * suggestions promoted from consistent history. Rules are applied by the
 * categorizer (skips the AI call), so each one makes the review queue quieter.
 */
export default async function CategorizationRulesPage() {
  await requirePermission('accounting.transactions.view');
  const canManage = await hasAnyPermission([
    'accounting.transactions.accountant_review',
    'enterprise.dashboard.view',
    'enterprise.clients.view',
  ]);
  if (!canManage) redirect('/transactions');

  const orgId = await getCurrentOrgId();
  const [rules, suggestions, accounts] = await Promise.all([
    listRules(orgId),
    suggestRules(orgId),
    db
      .select({
        id: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
      })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)))
      .orderBy(asc(chartOfAccounts.accountNumber)),
  ]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Categorization rules</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Deterministic rules the AI applies before anything else — a match skips the AI entirely and posts
            with full confidence. Promote a rule and that merchant stops needing review.
          </p>
        </div>
        <Link href="/transactions" className="shrink-0 text-sm text-blue-600 hover:underline dark:text-blue-400">
          ← Transactions
        </Link>
      </header>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Suggested from your history ({suggestions.length})
        </h2>
        {suggestions.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No suggestions yet — once a merchant is categorized the same way a few times, it&apos;ll appear here.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {suggestions.map((s) => (
              <li key={`${s.pattern}|${s.categoryAccountId}`} className="flex items-center justify-between gap-3 bg-white px-4 py-2.5 dark:bg-zinc-950">
                <div className="min-w-0 text-sm">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">“{s.pattern}”</span>
                  <span className="text-zinc-500"> → {s.categoryName}</span>
                  <span className="ml-2 text-xs text-zinc-400">seen {s.count}×</span>
                </div>
                <form action={createRuleAction} className="flex shrink-0 items-center gap-2">
                  <input type="hidden" name="pattern" value={s.pattern} />
                  <select
                    name="categoryAccountId"
                    defaultValue={s.categoryAccountId}
                    aria-label="Chart of accounts category"
                    className="max-w-[180px] shrink-0 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950"
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.accountNumber} · {a.accountName}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="shrink-0 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                  >
                    Create rule
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Active rules ({rules.length})
        </h2>
        {rules.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No rules yet.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 bg-white px-4 py-2.5 dark:bg-zinc-950">
                <div className="min-w-0 text-sm">
                  <span className="font-mono text-xs text-zinc-700 dark:text-zinc-300">contains “{r.pattern}”</span>
                  <span className="text-zinc-500"> → {r.categoryName ?? '(deleted account)'}</span>
                </div>
                <form action={deleteRuleAction}>
                  <input type="hidden" name="ruleId" value={r.id} />
                  <button
                    type="submit"
                    className="shrink-0 rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900"
                  >
                    Delete
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
