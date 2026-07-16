import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { tasks } from '@/db/schema/schema';

function rowsOf(res: unknown): Record<string, unknown>[] {
  if (Array.isArray(res)) return res as Record<string, unknown>[];
  return ((res as { rows?: Record<string, unknown>[] })?.rows ?? []);
}

/** True when the underlying work for a recurring task is verifiably done.
 *  `period` is the task entity_id period ('YYYY-MM' / 'YYYY-Qn' / 'YYYY'). */
type DonePredicate = (orgId: string, period: string) => Promise<boolean>;

// Only keys with a reliable, cheap DB done-signal. Anything not listed here is
// left for a person to mark done — we never guess a task complete. Add a key as
// its done-state becomes queryable.
const DONE_PREDICATES: Record<string, DonePredicate> = {
  // Month-end close: the month's accounting period has been reviewed or closed.
  month_end_close: async (orgId, period) => {
    const [y, m] = period.split('-').map((n) => Number(n));
    if (!y || !m) return false;
    const res = await db.execute(
      sql`select 1 from accounting_periods
          where organization_id = ${orgId} and year = ${y} and month = ${m}
            and status in ('reviewed', 'closed') limit 1`,
    );
    return rowsOf(res).length > 0;
  },
  // Clear book-review findings: no open audit findings left.
  book_review_findings: async (orgId) => {
    const res = await db.execute(
      sql`select count(*)::int as n from book_review_findings
          where organization_id = ${orgId} and status = 'open'`,
    );
    return Number(rowsOf(res)[0]?.n ?? 0) === 0;
  },
};

/** Task keys this sweep can auto-complete (for callers that want to scope work). */
export const AUTO_COMPLETABLE_KEYS = new Set(Object.keys(DONE_PREDICATES));

/**
 * Close OPEN recurring tasks whose underlying work is verifiably done. Scoped to
 * one org (call after the relevant action, e.g. period close) or all orgs (cron).
 * Returns how many tasks were completed.
 */
export async function autoCompleteRecurringTasks(orgId?: string): Promise<number> {
  const base = and(eq(tasks.source, 'recurring'), eq(tasks.status, 'OPEN'));
  const open = await db
    .select({ id: tasks.id, organizationId: tasks.organizationId, entityId: tasks.entityId })
    .from(tasks)
    .where(orgId ? and(base, eq(tasks.organizationId, orgId)) : base);

  let closed = 0;
  for (const t of open) {
    if (!t.organizationId) continue;
    const [key, period] = (t.entityId ?? '').split(':');
    const pred = DONE_PREDICATES[key];
    if (!pred) continue;
    let done = false;
    try {
      done = await pred(t.organizationId, period ?? '');
    } catch {
      done = false;
    }
    if (done) {
      await db
        .update(tasks)
        .set({ status: 'DONE', updatedAt: new Date().toISOString() })
        .where(eq(tasks.id, t.id));
      closed += 1;
    }
  }
  return closed;
}
