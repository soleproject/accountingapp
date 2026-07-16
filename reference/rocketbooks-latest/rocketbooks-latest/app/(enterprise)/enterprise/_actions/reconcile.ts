'use server';

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { reconciliationPeriods, organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { DEMO_ENTERPRISE_ID } from '@/lib/enterprise/demo';
import { reconcileAccountMonth } from '@/lib/reconciliation/engine';
import { resolveReconciliationTask } from '@/lib/reconciliation/tasks';

export interface AutoMatchResult {
  ok: boolean;
  /** Accounts we actually re-ran the engine on. */
  ran: number;
  /** Of those, how many tied out (RECONCILED). */
  tiedOut: number;
  /** Of those, how many are still off (OPEN/SKIPPED). */
  stillOpen: number;
  /** Runnable off accounts beyond this batch's cap. */
  more: number;
  error?: string;
}

/** The engine reconciles a calendar month; only re-run periods that are exactly one. */
function isCalendarMonth(start: string, end: string): boolean {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  if (sd !== 1 || sy !== ey || sm !== em) return false;
  const lastDay = new Date(Date.UTC(sy, sm, 0)).getUTCDate();
  return ed === lastDay;
}

/** Bounds the synchronous run (the engine is AI-driven, ~10s/account). */
const MAX_PER_RUN = 3;

/**
 * Re-run the AI auto-reconciliation engine for a client's off accounts, from
 * the firm dashboard. Internal accounting only — no money movement, no
 * third-party contact. Idempotent (the engine upserts by period, preserves the
 * pro's manual matches, skips hand-started periods). Best-effort: a single
 * account failing never aborts the batch; never throws.
 */
export async function autoMatchReconciliationAction(orgId: string): Promise<AutoMatchResult> {
  const empty: AutoMatchResult = { ok: false, ran: 0, tiedOut: 0, stillOpen: 0, more: 0 };

  const session = await requireSession();
  const current = await getCurrentEnterprise();
  if (!current || current.id === DEMO_ENTERPRISE_ID) {
    return { ...empty, error: 'Not available for this enterprise.' };
  }

  // The org must be a client of this firm.
  const [client] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.id, orgId),
        sql`${organizations.ownerUserId} in (
          select client_user_id from enterprise_clients where enterprise_id = ${current.id}
        )`,
      ),
    )
    .limit(1);
  if (!client) return { ...empty, error: 'Client not found for this enterprise.' };

  // Off periods: OPEN, real balance mismatch, not hand-started. Newest first.
  const offPeriods = await db
    .select({
      periodId: reconciliationPeriods.id,
      accountId: reconciliationPeriods.accountId,
      startDate: reconciliationPeriods.startDate,
      endDate: reconciliationPeriods.endDate,
    })
    .from(reconciliationPeriods)
    .where(
      and(
        eq(reconciliationPeriods.organizationId, orgId),
        eq(reconciliationPeriods.status, 'OPEN'),
        eq(reconciliationPeriods.isManual, false),
        sql`${reconciliationPeriods.difference} is not null and ${reconciliationPeriods.difference} <> 0`,
      ),
    )
    .orderBy(desc(reconciliationPeriods.endDate));

  // Latest calendar-month off period per account.
  const seen = new Set<string>();
  const runnable: { accountId: string; year: number; month: number }[] = [];
  for (const p of offPeriods) {
    if (seen.has(p.accountId)) continue;
    if (!isCalendarMonth(p.startDate, p.endDate)) continue;
    seen.add(p.accountId);
    const [y, m] = p.startDate.split('-').map(Number);
    runnable.push({ accountId: p.accountId, year: y, month: m });
  }

  const toRun = runnable.slice(0, MAX_PER_RUN);
  const more = runnable.length - toRun.length;

  let ran = 0;
  let tiedOut = 0;
  let stillOpen = 0;
  for (const r of toRun) {
    try {
      const res = await reconcileAccountMonth({
        organizationId: orgId,
        accountId: r.accountId,
        year: r.year,
        month: r.month,
        triggeredBy: 'manual',
        userId: session.id,
      });
      ran += 1;
      if (res.status === 'RECONCILED') {
        tiedOut += 1;
        if (res.periodId) {
          try {
            await resolveReconciliationTask(res.periodId);
          } catch (taskErr) {
            console.error('autoMatch: resolveReconciliationTask failed', res.periodId, taskErr);
          }
        }
      } else {
        stillOpen += 1;
      }
    } catch (e) {
      stillOpen += 1;
      console.error('autoMatch: reconcileAccountMonth failed', orgId, r.accountId, e);
    }
  }

  return { ok: true, ran, tiedOut, stillOpen, more };
}
