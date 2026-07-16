import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { sql, and, eq, gte, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { plaidAccounts, aiUsageEvents } from '@/db/schema/schema';
import { getRate } from '@/lib/usage/rates';
import { isAuthorizedCron } from '@/lib/cron';
import { logger } from '@/lib/logger';

export const maxDuration = 120;

/**
 * Monthly usage snapshot for subscription-style per-unit costs that have no
 * natural per-call event. Today that's Plaid: it bills per active Item (one
 * institution login) per month, so once a month we count active items and write
 * one `plaid:item-month` cost row each.
 *
 * Scheduled at 06:00 UTC on the 1st (see vercel.json). Idempotent within a
 * calendar month — a re-run finds the existing rows and skips, so a manual
 * trigger or retry can't double-bill.
 *
 * Costs are written with an AWAITED bulk insert (not the fire-and-forget
 * recordServiceUsage) because a cron lambda freezes once it returns — detached
 * inserts could be cut off mid-flight.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse('forbidden', { status: 401 });

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  // Idempotency: bail if this month's Plaid snapshot already ran.
  const [already] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiUsageEvents)
    .where(and(eq(aiUsageEvents.feature, 'plaid-item-monthly'), gte(aiUsageEvents.createdAt, monthStart)));
  if (already && already.n > 0) {
    return NextResponse.json({ ok: true, skipped: 'plaid snapshot already recorded this month' });
  }

  // One billable Item = one plaid_item_id. Multiple accounts share an item, so
  // group to the item and keep an owner/org for attribution. Only count items
  // whose connection is healthy ('connected'/'ok'); auth_failed items are broken
  // and pending reconnection.
  const items = await db
    .select({
      itemId: plaidAccounts.plaidItemId,
      userId: sql<string>`min(${plaidAccounts.userId})`,
      orgId: sql<string | null>`min(${plaidAccounts.linkedOrganizationId})`,
    })
    .from(plaidAccounts)
    .where(inArray(plaidAccounts.connectionStatus, ['connected', 'ok']))
    .groupBy(plaidAccounts.plaidItemId);

  const rate = await getRate('plaid:item-month');
  const cost = rate == null ? null : rate.toFixed(6);

  const rows = items.map((it) => ({
    id: randomUUID(),
    orgId: it.orgId,
    userId: it.userId,
    actor: 'system',
    feature: 'plaid-item-monthly',
    provider: 'plaid',
    model: it.itemId,
    category: 'bank',
    unit: 'items',
    quantity: '1',
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    totalTokens: 0,
    costUsd: cost,
    latencyMs: null,
    requestId: null,
    metadata: { plaidItemId: it.itemId, snapshotMonth: monthStart.slice(0, 7) },
  }));

  if (rows.length > 0) await db.insert(aiUsageEvents).values(rows);

  logger.info({ plaidItems: rows.length }, 'usage-snapshot: recorded plaid item-month costs');
  return NextResponse.json({ ok: true, plaidItems: rows.length });
}
