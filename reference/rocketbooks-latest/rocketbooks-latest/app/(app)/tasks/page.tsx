import { eq, and, count, desc, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { onboardingState, organizations, tasks } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getActionCards, type ActionCard } from '@/lib/server/action-cards';
import { AttentionCards } from './_components/AttentionCards';

const PAGE_SIZE = 50;

const ONBOARDING_PHASE_LABELS: Record<string, string> = {
  business_info: 'business info',
  quickbooks: 'QuickBooks',
  plaid: 'bank connection',
  bank_statements: 'bank statements',
  receipts: 'receipts',
  review: 'review',
  complete: 'complete',
};

async function getOnboardingCard(orgId: string): Promise<ActionCard[]> {
  const [orgRow] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const [onboarding] = await db
    .select({ phase: onboardingState.phase, completed: onboardingState.completed })
    .from(onboardingState)
    .where(eq(onboardingState.orgId, orgId))
    .limit(1);

  if (!onboarding || onboarding.completed) return [];
  const phaseLabel = ONBOARDING_PHASE_LABELS[onboarding.phase] ?? onboarding.phase;
  return [
    {
      id: 'onboarding',
      tier: 'blocking',
      priority: 2,
      title: `Finish setting up ${orgRow?.name ?? 'your business'}`,
      body: `On step: ${phaseLabel}`,
      actionLabel: 'Continue',
      action: { kind: 'ask-ai', prompt: 'Help me continue setting up my account.' },
    },
  ];
}

interface PageProps {
  searchParams: Promise<{ page?: string; status?: string }>;
}

export default async function TasksPage({ searchParams }: PageProps) {
  const orgId = await getCurrentOrgId();
  await requireSession();
  const { page: pageStr, status: statusFilter } = await searchParams;
  const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);

  // Push the status filter into SQL so pagination + count + filter all stay
  // consistent. Doing it in JS after a 50-row LIMIT meant the page returned
  // empty when the most recent 50 rows had a different status than requested.
  // Hide the firm's internal recurring tasks (source='recurring', category='firm')
  // from the client's list — those are the accounting pro's work, not the client's.
  // IS DISTINCT FROM keeps null-source/category rows (everything else) visible.
  const notFirmRecurring = sql`(${tasks.source} IS DISTINCT FROM 'recurring' OR ${tasks.category} IS DISTINCT FROM 'firm')`;
  const where =
    statusFilter && (statusFilter === 'OPEN' || statusFilter === 'DONE')
      ? and(eq(tasks.organizationId, orgId), eq(tasks.status, statusFilter), notFirmRecurring)
      : and(eq(tasks.organizationId, orgId), notFirmRecurring);

  const [total] = await db.select({ n: count() }).from(tasks).where(where);
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      priority: tasks.priority,
      category: tasks.category,
      module: tasks.module,
      status: tasks.status,
      dueDate: tasks.dueDate,
      product: tasks.product,
    })
    .from(tasks)
    .where(where)
    .orderBy(desc(tasks.createdAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  // Full attention cards (bills overdue, reconciliation off, review queue,
  // onboarding, etc.) — the same set the dashboard + assistant surface. Runtime-
  // gated: Vercel (prod) handles the multi-aggregation read fine; the lightweight
  // onboarding-only card is kept for the Cloudflare Workers target, which is why
  // this kept getting stripped. VERCEL_ENV is set on Vercel, absent on Workers.
  const cards = process.env.VERCEL_ENV
    ? await getActionCards(orgId).catch(() => [])
    : await getOnboardingCard(orgId).catch(() => []);

  const totalCount = total?.n ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Tasks</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{totalCount.toLocaleString()} tasks across all products</p>
        </div>
        <div className="flex gap-1 rounded-md border border-zinc-200 bg-white p-1 text-xs dark:border-zinc-800 dark:bg-zinc-950">
          {['all', 'OPEN', 'DONE'].map((s) => (
            <a
              key={s}
              href={`?${s === 'all' ? '' : `status=${s}`}`}
              className={`rounded px-2 py-1 ${
                (statusFilter ?? 'all') === s
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
              }`}
            >
              {s.toLowerCase()}
            </a>
          ))}
        </div>
      </header>

      {cards.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">What needs your attention</h2>
          <AttentionCards cards={cards} />
        </section>
      )}

      <details className="group flex flex-col gap-3">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 [&::-webkit-details-marker]:hidden">
          <svg className="h-4 w-4 text-zinc-400 transition-transform group-open:rotate-90" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M7 5l6 5-6 5z" />
          </svg>
          All tasks ({totalCount.toLocaleString()})
        </summary>
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Status</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Title</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Module</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Priority</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Due</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">No tasks.</td>
              </tr>
            )}
            {rows.map((t) => (
              <tr key={t.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs ${t.status === 'DONE' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30'}`}>
                    {t.status}
                  </span>
                </td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                  <div className="font-medium">{t.title}</div>
                  {t.description && <div className="text-xs text-zinc-500">{t.description.slice(0, 100)}</div>}
                </td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{t.module ?? t.product ?? '—'}</td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{t.priority ?? '—'}</td>
                <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">
                  {t.dueDate ? new Date(t.dueDate).toLocaleDateString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <nav className="flex items-center justify-between text-xs text-zinc-500">
          <span>
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <a
                href={`?${new URLSearchParams({ ...(statusFilter ? { status: statusFilter } : {}), page: String(page - 1) }).toString()}`}
                className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                ← Prev
              </a>
            )}
            {page < totalPages && (
              <a
                href={`?${new URLSearchParams({ ...(statusFilter ? { status: statusFilter } : {}), page: String(page + 1) }).toString()}`}
                className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                Next →
              </a>
            )}
          </div>
        </nav>
      )}
      </details>
    </div>
  );
}
