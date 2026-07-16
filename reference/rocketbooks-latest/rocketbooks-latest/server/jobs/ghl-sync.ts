import 'server-only';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { inngest } from '@/lib/inngest';
import { db } from '@/db/client';
import { ghlConnections, ghlRawPayments } from '@/db/schema/schema';
import { loadConnection, getFreshAccessToken } from '@/lib/ghl/connection';
import { listTransactions, type GhlTransaction } from '@/lib/ghl/client';
import { logger } from '@/lib/logger';

// Pull a GHL location's payment transactions into ghl_raw_payments (raw
// landing layer — cf. plaid-sync.ts). Promotion to the ledger is a separate,
// review-only step (lib/accounting/ghl-promote.ts); this job only ingests.
//
// Dedup: UNIQUE(ghl_connection_id, ghl_payment_id) + onConflictDoNothing, so
// re-running (webhook replay, backfill overlap, retry) never duplicates rows.

const PAGE_SIZE = 100;
const MAX_PAGES = 200; // safety cap (~20k transactions/run)
const BACKFILL_DAYS = 365; // first sync reaches back one year

// GHL transaction field names/units aren't fully pinned in the docs, so every
// extraction below is best-effort with fallbacks. The full object is stored
// verbatim in raw_json, and exact mapping (amount unit, date field, contact
// path) is finalized in ghl-promote.ts against real payloads.
function paymentId(t: GhlTransaction): string | null {
  const id = t._id ?? (t as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function toDateStr(t: GhlTransaction): string {
  const raw =
    t.createdAt ??
    (t as Record<string, unknown>).paidAt ??
    (t as Record<string, unknown>).updatedAt;
  if (typeof raw === 'number') return new Date(raw).toISOString().slice(0, 10);
  if (typeof raw === 'string' && raw.length >= 10) {
    // ISO timestamp or already a date — take the date portion.
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return raw.slice(0, 10);
  }
  // No usable date — fall back to today so the NOT NULL column is satisfied;
  // promote re-derives the real date from raw_json.
  return new Date().toISOString().slice(0, 10);
}

function toAmount(t: GhlTransaction): string {
  const n = typeof t.amount === 'number' ? t.amount : Number(t.amount ?? 0);
  return Number.isFinite(n) ? String(n) : '0';
}

function toContactName(t: GhlTransaction): string | null {
  const rec = t as Record<string, unknown>;
  const snapshot = rec.contactSnapshot as Record<string, unknown> | undefined;
  const name =
    t.contactName ??
    (snapshot?.name as string | undefined) ??
    (snapshot
      ? [snapshot.firstName, snapshot.lastName].filter(Boolean).join(' ').trim() || undefined
      : undefined);
  return typeof name === 'string' && name.length > 0 ? name : null;
}

function toDescription(t: GhlTransaction): string | null {
  const rec = t as Record<string, unknown>;
  const desc = rec.entitySourceName ?? rec.description ?? rec.chargeId;
  return typeof desc === 'string' && desc.length > 0 ? desc : null;
}

export const ghlSync = inngest.createFunction(
  {
    id: 'ghl-sync',
    concurrency: { limit: 1, key: 'event.data.connectionId' },
    retries: 3,
    triggers: [{ event: 'ghl/sync.requested' }],
  },
  async ({ event, step }) => {
    const { connectionId, trigger } = event.data as { connectionId: string; trigger: string };
    logger.info({ connectionId, trigger }, 'ghl sync starting');

    try {
      const connection = await step.run('load-connection', async () => {
        const c = await loadConnection(connectionId);
        if (!c) throw new Error(`GHL connection ${connectionId} not found`);
        return c;
      });

      // Refresh-if-needed happens here (and persists rotated tokens). Done
      // outside step.run so the new token isn't memoized across a retry.
      const accessToken = await getFreshAccessToken(connection);

      // Incremental watermark: prior cursor, else a bounded backfill window.
      const startAt =
        connection.syncCursor ??
        new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const runStartedIso = new Date().toISOString();

      let offset = 0;
      let pageNum = 0;
      let totalAdded = 0;

      while (pageNum < MAX_PAGES) {
        pageNum++;
        const txns = await step.run(`fetch-page-${pageNum}`, async () => {
          const res = await listTransactions({
            accessToken,
            locationId: connection.locationId,
            limit: PAGE_SIZE,
            offset,
            startAt,
          });
          return res.data ?? [];
        });

        if (txns.length === 0) break;

        const added = await step.run(`persist-page-${pageNum}`, async () => {
          const now = new Date().toISOString();
          let count = 0;
          for (const t of txns) {
            const id = paymentId(t);
            if (!id) {
              logger.warn({ connectionId }, 'ghl transaction missing id; skipped');
              continue;
            }
            const inserted = await db
              .insert(ghlRawPayments)
              .values({
                id: randomUUID(),
                ghlConnectionId: connection.id,
                ghlPaymentId: id,
                date: toDateStr(t),
                amount: toAmount(t),
                contactName: toContactName(t),
                description: toDescription(t),
                rawJson: t,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoNothing()
              .returning({ id: ghlRawPayments.id });
            if (inserted.length > 0) count++;
          }
          return count;
        });

        totalAdded += added;
        offset += txns.length;
        if (txns.length < PAGE_SIZE) break; // short page = last page
      }

      await step.run('finalize', async () =>
        db
          .update(ghlConnections)
          .set({
            syncCursor: runStartedIso.slice(0, 10),
            lastSyncedAt: runStartedIso,
            connectionStatus: 'connected',
            lastSyncError: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(ghlConnections.id, connectionId)),
      );

      await step.sendEvent('post-sync', {
        name: 'ghl/sync.completed',
        data: { connectionId, added: totalAdded },
      });

      logger.info({ connectionId, added: totalAdded, pages: pageNum }, 'ghl sync done');
      return { added: totalAdded };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ connectionId, trigger, err: msg }, 'ghl sync failed');
      // Persist the error for the connection page, then rethrow so Inngest
      // retries per policy.
      await db
        .update(ghlConnections)
        .set({
          connectionStatus: 'error',
          lastSyncError: msg.slice(0, 1000),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(ghlConnections.id, connectionId))
        .catch(() => {
          /* swallow secondary failure; original error wins */
        });
      throw err;
    }
  },
);
