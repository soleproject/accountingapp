'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { qboConnections } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { canMirrorQbo } from '@/lib/billing/entitlements';
import { qboFetch } from '@/lib/qbo/client';
import { upsertItem } from '@/lib/qbo/mirror/upserters';
import { logger } from '@/lib/logger';

const PAGE_SIZE = 1000;

interface QboItemResponse {
  Id: string;
  Name: string;
  Description?: string;
  UnitPrice?: number;
  Type?: 'Inventory' | 'Service' | 'NonInventory';
  Active?: boolean;
  SyncToken?: string;
  MetaData?: { LastUpdatedTime?: string };
  IncomeAccountRef?: { value: string };
  ExpenseAccountRef?: { value: string };
}

interface QueryEnvelope {
  QueryResponse: { Item?: QboItemResponse[]; startPosition?: number; maxResults?: number };
}

export interface SyncItemsResult {
  error?: string;
  fetched?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  failed?: number;
}

/**
 * One-shot pull of every Item from the connected QBO realm into local
 * `items` + `qbo_entity_map`. The migration code (qbo-migration) doesn't
 * include Item yet; this action exists so the user can backfill Items
 * on demand without re-running the whole migration. After this completes,
 * Invoice push has a complete map to resolve line ItemRefs against.
 *
 * Idempotent: re-running just no-ops on items whose MetaData hasn't
 * advanced since the last sync, same as the inbound webhook upserter.
 */
export async function syncItems(): Promise<SyncItemsResult> {
  const orgId = await getCurrentOrgId();
  if (!(await canMirrorQbo(orgId))) {
    return { error: 'QBO mirroring is not enabled for this workspace.' };
  }

  const [connection] = await db
    .select({ realmId: qboConnections.realmId })
    .from(qboConnections)
    .where(eq(qboConnections.orgId, orgId))
    .limit(1);
  if (!connection) return { error: 'QuickBooks is not connected.' };

  // Page through QBO's Query API. STARTPOSITION is 1-based.
  const all: QboItemResponse[] = [];
  let startPosition = 1;
  try {
    while (true) {
      const query = `SELECT * FROM Item STARTPOSITION ${startPosition} MAXRESULTS ${PAGE_SIZE}`;
      const res = await qboFetch<QueryEnvelope>(orgId, '/query', { query: { query } });
      const page = res.QueryResponse?.Item ?? [];
      all.push(...page);
      if (page.length < PAGE_SIZE) break;
      startPosition += PAGE_SIZE;
    }
  } catch (err) {
    return { error: `Failed to fetch items from QuickBooks: ${err instanceof Error ? err.message : String(err)}` };
  }

  const ctx = { organizationId: orgId, realmId: connection.realmId };
  let created = 0, updated = 0, skipped = 0, failed = 0;
  for (const raw of all) {
    try {
      // The upserter treats existing-map+no-newer-timestamp as
      // 'skipped_no_change', so a re-run is cheap.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await upsertItem({ ctx, operation: 'Create', raw: raw as any });
      switch (result.kind) {
        case 'created': created++; break;
        case 'updated': updated++; break;
        case 'skipped_no_change': skipped++; break;
        default: skipped++;
      }
    } catch (err) {
      failed++;
      logger.warn({ qboId: raw.Id, err: err instanceof Error ? err.message : String(err) }, 'syncItems upsert failed');
    }
  }
  revalidatePath('/integrations/qbo');
  return { fetched: all.length, created, updated, skipped, failed };
}
