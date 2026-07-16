'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { plaidAccounts, chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { promotePlaidAccount } from '@/lib/accounting/plaid-promote';
import { safeSend } from '@/lib/inngest';
import { logger } from '@/lib/logger';

async function emitPromoteCompleted(args: { organizationId: string; plaidAccountId: string; transactionIds: string[] }) {
  if (args.transactionIds.length === 0) return;
  await safeSend({
    name: 'plaid/promote.completed',
    data: args,
  });
}

const MapSchema = z.object({
  plaidAccountId: z.string().min(1),
  chartOfAccountId: z.string().min(1),
});

export interface MapState { error?: string; ok?: boolean; promoted?: number; }

export async function mapPlaidAccountToCoa(_prev: MapState | undefined, formData: FormData): Promise<MapState | undefined> {
  const orgId = await getCurrentOrgId();
  const parsed = MapSchema.safeParse({
    plaidAccountId: formData.get('plaidAccountId'),
    chartOfAccountId: formData.get('chartOfAccountId'),
  });
  if (!parsed.success) return { error: 'Invalid input' };

  const [pa] = await db
    .select({ id: plaidAccounts.id, inScope: plaidAccounts.inScope })
    .from(plaidAccounts)
    .where(and(eq(plaidAccounts.id, parsed.data.plaidAccountId), eq(plaidAccounts.linkedOrganizationId, orgId)))
    .limit(1);
  if (!pa) return { error: 'Plaid account not in this organization' };

  const [coa] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.id, parsed.data.chartOfAccountId), eq(chartOfAccounts.organizationId, orgId)))
    .limit(1);
  if (!coa) return { error: 'COA account not in this organization' };

  await db.update(plaidAccounts).set({ chartOfAccountId: coa.id }).where(eq(plaidAccounts.id, pa.id));

  // Only re-promote if the account is already in scope. Mapping alone does
  // not bring transactions into the books — the user has to explicitly
  // "Add to books" (promoteAccountAction). This prevents personal accounts
  // from being silently promoted on a re-map.
  let promoted = 0;
  if (pa.inScope) {
    const result = await promotePlaidAccount({ organizationId: orgId, plaidAccountId: pa.id });
    promoted = result.promoted;
    await emitPromoteCompleted({
      organizationId: orgId,
      plaidAccountId: pa.id,
      transactionIds: result.newTransactionIds,
    });
    logger.info({ plaidAccountId: pa.id, promoted: result.promoted, skipped: result.skipped }, 'mapped + re-promoted in-scope account');
  } else {
    logger.info({ plaidAccountId: pa.id }, 'mapped (account out of scope, no promotion)');
  }
  revalidatePath('/integrations/plaid');
  revalidatePath('/transactions');
  return { ok: true, promoted };
}

export interface PromoteState { error?: string; promoted?: number; skipped?: number; }

/**
 * The "Add to books" action. Flips in_scope to true, stamps promoted_at,
 * then runs a one-shot backfill of any raw transactions that have
 * accumulated since link. Future syncs auto-promote (Inngest chain).
 */
export async function promoteAccountAction(_prev: PromoteState | undefined, formData: FormData): Promise<PromoteState | undefined> {
  const orgId = await getCurrentOrgId();
  const plaidAccountId = String(formData.get('plaidAccountId') ?? '');
  if (!plaidAccountId) return { error: 'Missing plaidAccountId' };

  const [acct] = await db
    .select({
      id: plaidAccounts.id,
      orgId: plaidAccounts.linkedOrganizationId,
      chartOfAccountId: plaidAccounts.chartOfAccountId,
      inScope: plaidAccounts.inScope,
    })
    .from(plaidAccounts)
    .where(eq(plaidAccounts.id, plaidAccountId))
    .limit(1);
  if (!acct || acct.orgId !== orgId) return { error: 'Plaid account not in this organization' };
  if (!acct.chartOfAccountId) return { error: 'Map this account to a chart-of-accounts entry first' };

  if (!acct.inScope) {
    await db
      .update(plaidAccounts)
      .set({ inScope: true, promotedAt: new Date().toISOString() })
      .where(eq(plaidAccounts.id, plaidAccountId));
  }

  const result = await promotePlaidAccount({ organizationId: orgId, plaidAccountId });
  // 'no raw transactions yet' is the expected post-flip state when sync hasn't
  // pulled rows yet (or the account is empty). Flag is already set above, so
  // future syncs auto-promote — surface as success, not error.
  if (result.reason && result.reason !== 'no raw transactions yet') {
    return { error: result.reason };
  }

  await emitPromoteCompleted({
    organizationId: orgId,
    plaidAccountId,
    transactionIds: result.newTransactionIds,
  });

  revalidatePath('/integrations/plaid');
  revalidatePath('/transactions');
  return { promoted: result.promoted, skipped: result.skipped };
}
