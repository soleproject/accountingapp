'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  chartOfAccounts,
  contacts,
  qboConflicts,
  qboConnections,
  qboEntityMap,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { qboFetch } from '@/lib/qbo/client';
import { mapQboAccountType } from '@/lib/qbo/promote/account-types';
import {
  replaceBillFromQbo,
  replaceBillPaymentFromQbo,
  replaceInvoiceFromQbo,
  replacePaymentFromQbo,
} from '@/lib/qbo/mirror/creators';

export interface UseQboStateResult { error?: string }

/**
 * Resolve a conflict by accepting the QuickBooks side as truth. Fetches
 * the current entity from QBO, overwrites the local row with QBO's
 * values, stamps the conflict resolved, and resets the entity_map to
 * 'synced'.
 *
 * Ref entities (account/customer/vendor) and transactional entities
 * (invoice/bill/payment/billPayment) take different paths: ref does the
 * write + bookkeeping in one transaction; transactional calls
 * replaceXxxFromQbo (which opens its own tx for JE reversal + line
 * replacement) and then does bookkeeping in a separate small tx.
 */
export async function applyQboState(conflictId: string): Promise<UseQboStateResult | undefined> {
  const orgId = await getCurrentOrgId();
  const session = await requireSession();
  const now = new Date().toISOString();

  const [conflict] = await db
    .select({
      id: qboConflicts.id,
      entityMapId: qboConflicts.entityMapId,
      resolvedAt: qboConflicts.resolvedAt,
      entityType: qboEntityMap.entityType,
      qboId: qboEntityMap.qboId,
      localId: qboEntityMap.localId,
      realmId: qboEntityMap.realmId,
    })
    .from(qboConflicts)
    .innerJoin(qboEntityMap, eq(qboConflicts.entityMapId, qboEntityMap.id))
    .where(and(eq(qboConflicts.id, conflictId), eq(qboConflicts.organizationId, orgId)))
    .limit(1);
  if (!conflict) return { error: 'Conflict not found' };
  if (conflict.resolvedAt) return { error: 'Already resolved' };

  // Make sure we can actually talk to QBO before we touch anything.
  const [connection] = await db
    .select({ id: qboConnections.id })
    .from(qboConnections)
    .where(and(eq(qboConnections.orgId, orgId), eq(qboConnections.realmId, conflict.realmId)))
    .limit(1);
  if (!connection) return { error: 'QuickBooks is no longer connected for this workspace.' };

  // Per-entity fetch path. Path segments differ from wrapper keys (QBO is
  // lowercase in URL, PascalCase in body) — same pattern as the inbound
  // dispatcher.
  const fetchSpec: Record<string, { path: string; wrapperKey: string }> = {
    account:     { path: 'account',     wrapperKey: 'Account' },
    customer:    { path: 'customer',    wrapperKey: 'Customer' },
    vendor:      { path: 'vendor',      wrapperKey: 'Vendor' },
    invoice:     { path: 'invoice',     wrapperKey: 'Invoice' },
    bill:        { path: 'bill',        wrapperKey: 'Bill' },
    payment:     { path: 'payment',     wrapperKey: 'Payment' },
    billPayment: { path: 'billpayment', wrapperKey: 'BillPayment' },
  };
  const spec = fetchSpec[conflict.entityType];
  if (!spec) {
    return { error: `Use QBO is not yet supported for ${conflict.entityType}. Use Dismiss after reconciling manually.` };
  }

  let qboRaw: Record<string, unknown>;
  try {
    const envelope = await qboFetch<Record<string, unknown>>(orgId, `/${spec.path}/${conflict.qboId}`);
    qboRaw = (envelope[spec.wrapperKey] ?? {}) as Record<string, unknown>;
  } catch (err) {
    return { error: `Failed to fetch from QuickBooks: ${err instanceof Error ? err.message : String(err)}` };
  }

  const meta = qboRaw.MetaData as { LastUpdatedTime?: string } | undefined;
  const lastQboUpdatedAt = meta?.LastUpdatedTime ?? now;
  const syncToken = (qboRaw.SyncToken as string | undefined) ?? '0';

  // Transactional path: call the replace function (it manages its own
  // transaction for JE reversal + line replacement), then do the
  // bookkeeping in a small separate tx. Brief non-atomic window between
  // the replace and the entity_map update — acceptable because the
  // bookkeeping UPDATEs are essentially unfailable.
  const ctx = { organizationId: orgId, realmId: conflict.realmId };
  try {
    switch (conflict.entityType) {
      case 'invoice':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await replaceInvoiceFromQbo(ctx, qboRaw as any, conflict.localId);
        break;
      case 'bill':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await replaceBillFromQbo(ctx, qboRaw as any, conflict.localId);
        break;
      case 'payment':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await replacePaymentFromQbo(ctx, qboRaw as any, conflict.localId);
        break;
      case 'billPayment':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await replaceBillPaymentFromQbo(ctx, qboRaw as any, conflict.localId);
        break;
    }
  } catch (err) {
    return { error: `Replacing local from QBO failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  await db.transaction(async (tx) => {
    // Ref entities still write inside this tx — only transactional was
    // handled above. Branching on the same set the switch above covered.
    const isTransactional =
      conflict.entityType === 'invoice' ||
      conflict.entityType === 'bill' ||
      conflict.entityType === 'payment' ||
      conflict.entityType === 'billPayment';

    if (!isTransactional) {
      if (conflict.entityType === 'account') {
        const raw = qboRaw as { Name?: string; AccountType?: string; AccountSubType?: string; Active?: boolean };
        if (!raw.Name || !raw.AccountType) throw new Error('QBO returned malformed Account');
        const taxonomy = mapQboAccountType(raw.AccountType);
        await tx
          .update(chartOfAccounts)
          .set({
            accountName: raw.Name,
            gaapType: taxonomy.gaapType,
            accountType: taxonomy.accountType,
            detailType: raw.AccountSubType ?? null,
            normalBalance: taxonomy.normalBalance,
            isActive: raw.Active ?? true,
          })
          .where(eq(chartOfAccounts.id, conflict.localId));
      } else {
        // customer / vendor — both write to contacts. Re-using the
        // migration's field mapping keeps inbound and Use-QBO behavior
        // in sync.
        const raw = qboRaw as {
          DisplayName?: string;
          CompanyName?: string;
          PrimaryEmailAddr?: { Address?: string };
          PrimaryPhone?: { FreeFormNumber?: string };
          Active?: boolean;
        };
        if (!raw.DisplayName) throw new Error(`QBO returned malformed ${conflict.entityType}`);
        await tx
          .update(contacts)
          .set({
            contactName: raw.DisplayName,
            companyName: raw.CompanyName ?? null,
            email: raw.PrimaryEmailAddr?.Address ?? null,
            phone: raw.PrimaryPhone?.FreeFormNumber ?? null,
            isActive: raw.Active ?? true,
            updatedAt: now,
          })
          .where(eq(contacts.id, conflict.localId));
      }
    }

    // Refresh the map: bring lastLocalUpdatedAt forward to match
    // lastSyncAt so a future inbound webhook for this entity doesn't
    // trigger another conflict on the same stale-local clock.
    await tx
      .update(qboEntityMap)
      .set({
        qboSyncToken: syncToken,
        lastQboUpdatedAt,
        lastLocalUpdatedAt: now,
        lastSyncAt: now,
        syncStatus: 'synced',
        lastError: null,
        updatedAt: now,
      })
      .where(eq(qboEntityMap.id, conflict.entityMapId));

    await tx
      .update(qboConflicts)
      .set({ resolution: 'use_qbo', resolvedAt: now, resolvedByUserId: session.id, updatedAt: now })
      .where(eq(qboConflicts.id, conflictId));

    // Same "last open conflict" check as dismissConflict — we already
    // flipped sync_status above, but a separate open conflict on this
    // map row should keep it locked.
    const stillOpen = await tx
      .select({ id: qboConflicts.id })
      .from(qboConflicts)
      .where(and(eq(qboConflicts.entityMapId, conflict.entityMapId), isNull(qboConflicts.resolvedAt)))
      .limit(1);
    if (stillOpen.length > 0) {
      await tx
        .update(qboEntityMap)
        .set({ syncStatus: 'conflict', updatedAt: now })
        .where(eq(qboEntityMap.id, conflict.entityMapId));
    }
  });

  revalidatePath('/integrations/qbo/conflicts');
  revalidatePath('/integrations/qbo');
  return undefined;
}
