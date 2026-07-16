import 'server-only';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import {
  bills,
  billPayments,
  chartOfAccounts,
  contacts,
  invoices,
  invoicePayments,
  items,
  journalEntries,
  qboEntityMap,
} from '@/db/schema/schema';
import { reverseJournalEntry } from '@/lib/accounting/posting';
import { mapQboAccountType } from '@/lib/qbo/promote/account-types';
import {
  createEntityMap,
  detectConflict,
  loadEntityMap,
  recordInboundSync,
  writeConflict,
} from './conflict';
import {
  createBillFromQbo,
  createBillPaymentFromQbo,
  createInvoiceFromQbo,
  createPaymentFromQbo,
  replaceBillFromQbo,
  replaceBillPaymentFromQbo,
  replaceInvoiceFromQbo,
  replacePaymentFromQbo,
} from './creators';
import { logger } from '@/lib/logger';

export interface UpsertCtx {
  organizationId: string;
  realmId: string;
}

export type UpsertResult =
  | { kind: 'created'; localId: string; entityMapId: string }
  | { kind: 'updated'; localId: string; entityMapId: string }
  | { kind: 'skipped_no_change' }
  | { kind: 'skipped_unsupported_op'; operation: string }
  | { kind: 'conflict'; entityMapId: string }
  | { kind: 'deleted'; localId: string };

interface QboMetaData {
  CreateTime?: string;
  LastUpdatedTime?: string;
}

interface QboBaseEntity {
  Id: string;
  SyncToken?: string;
  MetaData?: QboMetaData;
  Active?: boolean;
  status?: 'Deleted';
}

interface QboAccount extends QboBaseEntity {
  Name: string;
  AccountType: string;
  AccountSubType?: string;
  AcctNum?: string;
  FullyQualifiedName?: string;
}

interface QboParty extends QboBaseEntity {
  DisplayName: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
}

export type WebhookOperation = 'Create' | 'Update' | 'Delete' | 'Merge' | 'Void' | 'Emailed';

interface UpsertArgs<T extends QboBaseEntity> {
  ctx: UpsertCtx;
  operation: WebhookOperation;
  raw: T;
}

function lastUpdated(raw: QboBaseEntity): string {
  return raw.MetaData?.LastUpdatedTime ?? new Date().toISOString();
}

/**
 * QBO "Delete" semantics differ by entity. For Account, Customer, Vendor a
 * delete is really a soft-delete (Active=false) — the entity remains
 * queryable. Our local convention is is_active=false on the same row.
 * Don't drop the qbo_entity_map row: future reactivation would orphan it.
 */
async function applyDelete(entityType: string, localId: string, table: 'chartOfAccounts' | 'contacts'): Promise<void> {
  const now = new Date().toISOString();
  if (table === 'chartOfAccounts') {
    await db.update(chartOfAccounts).set({ isActive: false }).where(eq(chartOfAccounts.id, localId));
  } else {
    await db.update(contacts).set({ isActive: false, updatedAt: now }).where(eq(contacts.id, localId));
  }
  await db
    .update(qboEntityMap)
    .set({ syncStatus: 'deleted', updatedAt: now })
    .where(and(eq(qboEntityMap.entityType, entityType), eq(qboEntityMap.localId, localId)));
}

export async function upsertAccount({ ctx, operation, raw }: UpsertArgs<QboAccount>): Promise<UpsertResult> {
  const existingMap = await loadEntityMap(ctx.organizationId, ctx.realmId, 'account', raw.Id);

  // QBO Account events fire 'Update' even on a name change; we ignore
  // 'Emailed' (only on Invoice/Bill/Estimate). Anything else we treat
  // as Create-or-Update — Intuit's CDC sometimes elides explicit Create.
  if (operation !== 'Create' && operation !== 'Update' && operation !== 'Delete' && operation !== 'Merge') {
    return { kind: 'skipped_unsupported_op', operation };
  }

  if (operation === 'Delete') {
    if (!existingMap) return { kind: 'skipped_no_change' };
    await applyDelete('account', existingMap.localId, 'chartOfAccounts');
    return { kind: 'deleted', localId: existingMap.localId };
  }

  if (operation === 'Merge') {
    // QBO merges two accounts: 'id' survives, deletedId is retired. We
    // can't model that cleanly without the deleted-id field, which the
    // webhook entity carries on the wire but isn't in our QboAccount
    // shape. Skip with a log — slice-3 work.
    logger.warn({ qboId: raw.Id }, 'qbo account merge not yet handled');
    return { kind: 'skipped_unsupported_op', operation };
  }

  const inboundUpdatedAt = lastUpdated(raw);
  const syncToken = raw.SyncToken ?? null;

  if (existingMap) {
    if (detectConflict(existingMap, inboundUpdatedAt)) {
      await writeConflict({
        organizationId: ctx.organizationId,
        entityMapId: existingMap.id,
        qboSnapshot: raw as unknown as Record<string, unknown>,
        localSnapshot: { localId: existingMap.localId, lastLocalUpdatedAt: existingMap.lastLocalUpdatedAt },
      });
      return { kind: 'conflict', entityMapId: existingMap.id };
    }
    if (existingMap.lastQboUpdatedAt &&
        new Date(inboundUpdatedAt).getTime() <= new Date(existingMap.lastQboUpdatedAt).getTime()) {
      return { kind: 'skipped_no_change' };
    }

    // Apply update. Only refresh the fields QBO drives; leave AI/review
    // flags alone. account_number is intentionally NOT updated — local
    // numbering is rocketsuite's responsibility once an account exists.
    const taxonomy = mapQboAccountType(raw.AccountType);
    const detailType = raw.AccountSubType ?? null;
    await db
      .update(chartOfAccounts)
      .set({
        accountName: raw.Name,
        gaapType: taxonomy.gaapType,
        accountType: taxonomy.accountType,
        detailType,
        normalBalance: taxonomy.normalBalance,
        isActive: raw.Active ?? true,
      })
      .where(eq(chartOfAccounts.id, existingMap.localId));
    await recordInboundSync({ entityMapId: existingMap.id, lastQboUpdatedAt: inboundUpdatedAt, qboSyncToken: syncToken });
    return { kind: 'updated', localId: existingMap.localId, entityMapId: existingMap.id };
  }

  // Create path. Mirror promoter.ts behavior: prefer matching an existing
  // local account by name, then by (gaapType, detailType) slot, else
  // insert a fresh row. The (org, gaap_type, detail_type) UNIQUE index
  // means we MUST go through one of these branches — a blind insert would
  // 23505 on any chart that already has the matching slot.
  const taxonomy = mapQboAccountType(raw.AccountType);
  const detailType = raw.AccountSubType ?? null;

  const [byName] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(
      eq(chartOfAccounts.organizationId, ctx.organizationId),
      eq(chartOfAccounts.accountName, raw.Name),
    ))
    .limit(1);
  if (byName) {
    const mapId = await createEntityMap({
      organizationId: ctx.organizationId,
      realmId: ctx.realmId,
      entityType: 'account',
      qboId: raw.Id,
      localId: byName.id,
      lastQboUpdatedAt: inboundUpdatedAt,
      qboSyncToken: syncToken,
    });
    return { kind: 'created', localId: byName.id, entityMapId: mapId };
  }

  if (detailType) {
    const [bySlot] = await db
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(and(
        eq(chartOfAccounts.organizationId, ctx.organizationId),
        eq(chartOfAccounts.gaapType, taxonomy.gaapType),
        eq(chartOfAccounts.detailType, detailType),
      ))
      .limit(1);
    if (bySlot) {
      const mapId = await createEntityMap({
        organizationId: ctx.organizationId,
        realmId: ctx.realmId,
        entityType: 'account',
        qboId: raw.Id,
        localId: bySlot.id,
        lastQboUpdatedAt: inboundUpdatedAt,
        qboSyncToken: syncToken,
      });
      return { kind: 'created', localId: bySlot.id, entityMapId: mapId };
    }
  }

  const accountNumber = raw.AcctNum?.toString().trim() || `qbo:${raw.Id}`;
  const localId = randomUUID();
  await db.insert(chartOfAccounts).values({
    id: localId,
    organizationId: ctx.organizationId,
    accountNumber,
    accountName: raw.Name,
    gaapType: taxonomy.gaapType,
    accountType: taxonomy.accountType,
    detailType,
    normalBalance: taxonomy.normalBalance,
    isActive: raw.Active ?? true,
    passedNameContactCheck: false,
  });
  const mapId = await createEntityMap({
    organizationId: ctx.organizationId,
    realmId: ctx.realmId,
    entityType: 'account',
    qboId: raw.Id,
    localId,
    lastQboUpdatedAt: inboundUpdatedAt,
    qboSyncToken: syncToken,
  });
  return { kind: 'created', localId, entityMapId: mapId };
}

/**
 * Shared Customer/Vendor upsert. QBO models them as separate top-level
 * entities but they collapse into a single local contacts row with
 * type_tags telling which side(s). When the user has the same name as
 * customer AND vendor in QBO, both webhooks map to the same local contact
 * and union the tags.
 */
async function upsertParty(
  { ctx, operation, raw }: UpsertArgs<QboParty>,
  partyEntityType: 'customer' | 'vendor',
): Promise<UpsertResult> {
  const existingMap = await loadEntityMap(ctx.organizationId, ctx.realmId, partyEntityType, raw.Id);

  if (operation !== 'Create' && operation !== 'Update' && operation !== 'Delete' && operation !== 'Merge') {
    return { kind: 'skipped_unsupported_op', operation };
  }

  if (operation === 'Delete') {
    if (!existingMap) return { kind: 'skipped_no_change' };
    await applyDelete(partyEntityType, existingMap.localId, 'contacts');
    return { kind: 'deleted', localId: existingMap.localId };
  }

  if (operation === 'Merge') {
    logger.warn({ qboId: raw.Id, partyEntityType }, 'qbo party merge not yet handled');
    return { kind: 'skipped_unsupported_op', operation };
  }

  const inboundUpdatedAt = lastUpdated(raw);
  const syncToken = raw.SyncToken ?? null;
  const isActive = raw.Active ?? true;

  if (existingMap) {
    if (detectConflict(existingMap, inboundUpdatedAt)) {
      await writeConflict({
        organizationId: ctx.organizationId,
        entityMapId: existingMap.id,
        qboSnapshot: raw as unknown as Record<string, unknown>,
        localSnapshot: { localId: existingMap.localId, lastLocalUpdatedAt: existingMap.lastLocalUpdatedAt },
      });
      return { kind: 'conflict', entityMapId: existingMap.id };
    }
    if (existingMap.lastQboUpdatedAt &&
        new Date(inboundUpdatedAt).getTime() <= new Date(existingMap.lastQboUpdatedAt).getTime()) {
      return { kind: 'skipped_no_change' };
    }
    const now = new Date().toISOString();
    await db
      .update(contacts)
      .set({
        contactName: raw.DisplayName,
        companyName: raw.CompanyName ?? null,
        email: raw.PrimaryEmailAddr?.Address ?? null,
        phone: raw.PrimaryPhone?.FreeFormNumber ?? null,
        isActive,
        updatedAt: now,
      })
      .where(eq(contacts.id, existingMap.localId));
    await recordInboundSync({ entityMapId: existingMap.id, lastQboUpdatedAt: inboundUpdatedAt, qboSyncToken: syncToken });
    return { kind: 'updated', localId: existingMap.localId, entityMapId: existingMap.id };
  }

  // Create path. Match an existing contact by name first — the
  // (org, is_active, contact_name) UNIQUE means inserting a duplicate
  // would 23505. Going through byName lets a customer-then-vendor
  // (or vice-versa) flow share one local row with a union of type_tags.
  const [byName] = await db
    .select({ id: contacts.id, typeTags: contacts.typeTags })
    .from(contacts)
    .where(and(
      eq(contacts.organizationId, ctx.organizationId),
      eq(contacts.contactName, raw.DisplayName),
    ))
    .limit(1);

  const tag = partyEntityType === 'customer' ? 'customer' : 'vendor';

  if (byName) {
    const tags = Array.isArray(byName.typeTags) ? (byName.typeTags as string[]) : [];
    if (!tags.includes(tag)) {
      await db.update(contacts)
        .set({ typeTags: [...tags, tag], updatedAt: new Date().toISOString() })
        .where(eq(contacts.id, byName.id));
    }
    const mapId = await createEntityMap({
      organizationId: ctx.organizationId,
      realmId: ctx.realmId,
      entityType: partyEntityType,
      qboId: raw.Id,
      localId: byName.id,
      lastQboUpdatedAt: inboundUpdatedAt,
      qboSyncToken: syncToken,
    });
    return { kind: 'created', localId: byName.id, entityMapId: mapId };
  }

  const localId = randomUUID();
  await db.insert(contacts).values({
    id: localId,
    organizationId: ctx.organizationId,
    contactName: raw.DisplayName,
    companyName: raw.CompanyName ?? null,
    email: raw.PrimaryEmailAddr?.Address ?? null,
    phone: raw.PrimaryPhone?.FreeFormNumber ?? null,
    typeTags: [tag],
    isActive,
  });
  const mapId = await createEntityMap({
    organizationId: ctx.organizationId,
    realmId: ctx.realmId,
    entityType: partyEntityType,
    qboId: raw.Id,
    localId,
    lastQboUpdatedAt: inboundUpdatedAt,
    qboSyncToken: syncToken,
  });
  return { kind: 'created', localId, entityMapId: mapId };
}

export function upsertCustomer(args: UpsertArgs<QboParty>): Promise<UpsertResult> {
  return upsertParty(args, 'customer');
}

export function upsertVendor(args: UpsertArgs<QboParty>): Promise<UpsertResult> {
  return upsertParty(args, 'vendor');
}

// --------------------------------------------------------------------------
// Slice 3a — transactional Update + Delete/Void only. Creates that arrive
// before slice 3b ships return `deferred_create`; the dispatcher marks them
// `pending_transactional_create` so the event row can be re-fired later
// without losing data.
//
// IMPORTANT: header-only updates. We deliberately do NOT touch:
//   - invoice_lines / bill_lines (line-item replacement is structural)
//   - journal_entries (would require reversing + reposting)
//   - invoice_payment_applications / bill_payment_applications
// Most real-world QBO edits only touch header fields (date / memo / status
// derived from balance), and getting those wrong is high blast-radius.
// Slice 3b will handle full record replacement under transactions.
// --------------------------------------------------------------------------

interface QboTxnRef { value: string; name?: string }

interface QboInvoice extends QboBaseEntity {
  DocNumber?: string;
  CustomerRef?: QboTxnRef;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt?: number;
  Balance?: number;
  PrivateNote?: string;
  CustomerMemo?: { value?: string };
}

interface QboBill extends QboBaseEntity {
  DocNumber?: string;
  VendorRef?: QboTxnRef;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt?: number;
  Balance?: number;
  PrivateNote?: string;
}

interface QboPayment extends QboBaseEntity {
  CustomerRef?: QboTxnRef;
  TxnDate?: string;
  TotalAmt?: number;
  PrivateNote?: string;
}

interface QboBillPayment extends QboBaseEntity {
  VendorRef?: QboTxnRef;
  TxnDate?: string;
  TotalAmt?: number;
  PrivateNote?: string;
}

/**
 * Shared pre-flight for transactional upserters. Resolves the map row and
 * routes:
 *   - terminal: unsupported op, deleted, conflict, no-op update
 *   - update: existing map row, inbound is newer → caller applies header edit
 *   - create: no map row OR explicit Create op → caller invokes its creator
 *
 * Returning a 'create' kind from a Create OR an Update-on-unmapped-record
 * is intentional: from our point of view there is no local row yet, so the
 * right outcome is to insert one.
 */
async function transactionalPreflight<T extends QboBaseEntity>(
  args: UpsertArgs<T>,
  entityType: 'invoice' | 'bill' | 'payment' | 'billPayment',
  applyDeleteToLocal: (localId: string) => Promise<void>,
): Promise<
  | { kind: 'terminal'; result: UpsertResult }
  | { kind: 'update'; map: typeof qboEntityMap.$inferSelect; inboundUpdatedAt: string; syncToken: string | null }
  | { kind: 'create'; inboundUpdatedAt: string; syncToken: string | null }
> {
  const { ctx, operation, raw } = args;
  const map = await loadEntityMap(ctx.organizationId, ctx.realmId, entityType, raw.Id);

  if (operation !== 'Create' && operation !== 'Update' && operation !== 'Delete' && operation !== 'Void' && operation !== 'Merge') {
    return { kind: 'terminal', result: { kind: 'skipped_unsupported_op', operation } };
  }

  if (operation === 'Delete' || operation === 'Void') {
    if (!map) {
      return { kind: 'terminal', result: { kind: 'skipped_no_change' } };
    }
    await applyDeleteToLocal(map.localId);
    const now = new Date().toISOString();
    await db
      .update(qboEntityMap)
      .set({ syncStatus: 'deleted', updatedAt: now })
      .where(eq(qboEntityMap.id, map.id));
    return { kind: 'terminal', result: { kind: 'deleted', localId: map.localId } };
  }

  if (operation === 'Merge') {
    logger.warn({ qboId: raw.Id, entityType }, 'qbo transactional merge not yet handled');
    return { kind: 'terminal', result: { kind: 'skipped_unsupported_op', operation } };
  }

  const inboundUpdatedAt = lastUpdated(raw);
  const syncToken = raw.SyncToken ?? null;

  // Create OR Update against an unmapped record: there's no local row yet,
  // call the creator. If the same QBO record already exists locally with a
  // map row, an explicit Create event is treated as Update-no-op below.
  if (!map) {
    return { kind: 'create', inboundUpdatedAt, syncToken };
  }

  if (detectConflict(map, inboundUpdatedAt)) {
    await writeConflict({
      organizationId: ctx.organizationId,
      entityMapId: map.id,
      qboSnapshot: raw as unknown as Record<string, unknown>,
      localSnapshot: { localId: map.localId, lastLocalUpdatedAt: map.lastLocalUpdatedAt },
    });
    return { kind: 'terminal', result: { kind: 'conflict', entityMapId: map.id } };
  }

  if (map.lastQboUpdatedAt &&
      new Date(inboundUpdatedAt).getTime() <= new Date(map.lastQboUpdatedAt).getTime()) {
    return { kind: 'terminal', result: { kind: 'skipped_no_change' } };
  }

  return { kind: 'update', map, inboundUpdatedAt, syncToken };
}

/**
 * Reverse the currently-live JE for a transactional source. A JE is "live"
 * when it isn't itself a reverser AND no other JE reverses it. After a slice
 * 3c Update there can be multiple posted + reversed JEs in the source's
 * history; we only reverse the one still on the books.
 *
 * reverseJournalEntry is idempotent, so even if a webhook double-fires the
 * second reversal is a no-op.
 */
async function reverseLiveSourceJe(
  organizationId: string,
  sourceType: 'invoice' | 'bill' | 'invoice_payment' | 'bill_payment',
  sourceId: string,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<void> {
  const all = await tx
    .select({ id: journalEntries.id, reversalOfId: journalEntries.reversalOfId })
    .from(journalEntries)
    .where(and(
      eq(journalEntries.organizationId, organizationId),
      eq(journalEntries.sourceType, sourceType),
      eq(journalEntries.sourceId, sourceId),
    ));
  const reversedIds = new Set(all.filter((r) => r.reversalOfId).map((r) => r.reversalOfId!));
  const live = all.filter((r) => !r.reversalOfId && !reversedIds.has(r.id));
  for (const je of live) {
    await reverseJournalEntry({ organizationId, journalEntryId: je.id }, tx);
  }
}

export async function upsertInvoice(args: UpsertArgs<QboInvoice>): Promise<UpsertResult> {
  const { ctx } = args;
  const pre = await transactionalPreflight(args, 'invoice', async (localId) => {
    // Void in one transaction: reverse the live JE (books move) and flip
    // status. Partial failure rolls back so we can't end up with a voided
    // row + unreversed JE.
    await db.transaction(async (tx) => {
      await reverseLiveSourceJe(ctx.organizationId, 'invoice', localId, tx);
      await tx.update(invoices).set({ status: 'voided', updatedAt: new Date().toISOString() })
        .where(eq(invoices.id, localId));
    });
  });
  if (pre.kind === 'terminal') return pre.result;

  const { raw } = args;

  if (pre.kind === 'create') {
    const localId = await createInvoiceFromQbo(ctx, raw as Parameters<typeof createInvoiceFromQbo>[1]);
    const entityMapId = await createEntityMap({
      organizationId: ctx.organizationId,
      realmId: ctx.realmId,
      entityType: 'invoice',
      qboId: raw.Id,
      localId,
      lastQboUpdatedAt: pre.inboundUpdatedAt,
      qboSyncToken: pre.syncToken,
    });
    return { kind: 'created', localId, entityMapId };
  }

  const { map, inboundUpdatedAt, syncToken } = pre;
  await replaceInvoiceFromQbo(ctx, raw as Parameters<typeof replaceInvoiceFromQbo>[1], map.localId);
  await recordInboundSync({ entityMapId: map.id, lastQboUpdatedAt: inboundUpdatedAt, qboSyncToken: syncToken });
  return { kind: 'updated', localId: map.localId, entityMapId: map.id };
}

export async function upsertBill(args: UpsertArgs<QboBill>): Promise<UpsertResult> {
  const { ctx } = args;
  const pre = await transactionalPreflight(args, 'bill', async (localId) => {
    await db.transaction(async (tx) => {
      await reverseLiveSourceJe(ctx.organizationId, 'bill', localId, tx);
      await tx.update(bills).set({ status: 'voided', updatedAt: new Date().toISOString() })
        .where(eq(bills.id, localId));
    });
  });
  if (pre.kind === 'terminal') return pre.result;

  const { raw } = args;

  if (pre.kind === 'create') {
    const localId = await createBillFromQbo(ctx, raw as Parameters<typeof createBillFromQbo>[1]);
    const entityMapId = await createEntityMap({
      organizationId: ctx.organizationId,
      realmId: ctx.realmId,
      entityType: 'bill',
      qboId: raw.Id,
      localId,
      lastQboUpdatedAt: pre.inboundUpdatedAt,
      qboSyncToken: pre.syncToken,
    });
    return { kind: 'created', localId, entityMapId };
  }

  const { map, inboundUpdatedAt, syncToken } = pre;
  await replaceBillFromQbo(ctx, raw as Parameters<typeof replaceBillFromQbo>[1], map.localId);
  await recordInboundSync({ entityMapId: map.id, lastQboUpdatedAt: inboundUpdatedAt, qboSyncToken: syncToken });
  return { kind: 'updated', localId: map.localId, entityMapId: map.id };
}

export async function upsertPayment(args: UpsertArgs<QboPayment>): Promise<UpsertResult> {
  const { ctx } = args;
  const pre = await transactionalPreflight(args, 'payment', async (localId) => {
    // Void: reverse the live JE (cash returns to bank on the GL, AR
    // restored) and zero the row's amount. Applications stay intact so the
    // audit trail of which invoices this payment was applied to survives —
    // the JE reversal is what undoes the financial impact.
    await db.transaction(async (tx) => {
      await reverseLiveSourceJe(ctx.organizationId, 'invoice_payment', localId, tx);
      await tx.update(invoicePayments).set({ amount: '0', updatedAt: new Date().toISOString() })
        .where(eq(invoicePayments.id, localId));
    });
  });
  if (pre.kind === 'terminal') return pre.result;

  const { raw } = args;

  if (pre.kind === 'create') {
    const localId = await createPaymentFromQbo(ctx, raw as Parameters<typeof createPaymentFromQbo>[1]);
    const entityMapId = await createEntityMap({
      organizationId: ctx.organizationId,
      realmId: ctx.realmId,
      entityType: 'payment',
      qboId: raw.Id,
      localId,
      lastQboUpdatedAt: pre.inboundUpdatedAt,
      qboSyncToken: pre.syncToken,
    });
    return { kind: 'created', localId, entityMapId };
  }

  const { map, inboundUpdatedAt, syncToken } = pre;
  await replacePaymentFromQbo(ctx, raw as Parameters<typeof replacePaymentFromQbo>[1], map.localId);
  await recordInboundSync({ entityMapId: map.id, lastQboUpdatedAt: inboundUpdatedAt, qboSyncToken: syncToken });
  return { kind: 'updated', localId: map.localId, entityMapId: map.id };
}

export async function upsertBillPayment(args: UpsertArgs<QboBillPayment>): Promise<UpsertResult> {
  const { ctx } = args;
  const pre = await transactionalPreflight(args, 'billPayment', async (localId) => {
    await db.transaction(async (tx) => {
      await reverseLiveSourceJe(ctx.organizationId, 'bill_payment', localId, tx);
      await tx.update(billPayments).set({ amount: '0', updatedAt: new Date().toISOString() })
        .where(eq(billPayments.id, localId));
    });
  });
  if (pre.kind === 'terminal') return pre.result;

  const { raw } = args;

  if (pre.kind === 'create') {
    const localId = await createBillPaymentFromQbo(ctx, raw as Parameters<typeof createBillPaymentFromQbo>[1]);
    const entityMapId = await createEntityMap({
      organizationId: ctx.organizationId,
      realmId: ctx.realmId,
      entityType: 'billPayment',
      qboId: raw.Id,
      localId,
      lastQboUpdatedAt: pre.inboundUpdatedAt,
      qboSyncToken: pre.syncToken,
    });
    return { kind: 'created', localId, entityMapId };
  }

  const { map, inboundUpdatedAt, syncToken } = pre;
  await replaceBillPaymentFromQbo(ctx, raw as Parameters<typeof replaceBillPaymentFromQbo>[1], map.localId);
  await recordInboundSync({ entityMapId: map.id, lastQboUpdatedAt: inboundUpdatedAt, qboSyncToken: syncToken });
  return { kind: 'updated', localId: map.localId, entityMapId: map.id };
}

// --------------------------------------------------------------------------
// Item upsert. Same shape as upsertAccount (ref entity), without the
// taxonomy mapping — Items don't have a gaap-style classification.
// Income/expense account refs resolve through qbo_entity_map; if the
// referenced account isn't mapped yet we leave the column null rather
// than failing — Items need to be visible even when their accounting
// linkage is incomplete.
// --------------------------------------------------------------------------

interface QboItem extends QboBaseEntity {
  Name: string;
  Description?: string;
  UnitPrice?: number;
  Type?: 'Inventory' | 'Service' | 'NonInventory';
  IncomeAccountRef?: { value: string };
  ExpenseAccountRef?: { value: string };
}

async function resolveAccountLocalId(
  ctx: UpsertCtx,
  qboAccountId: string | undefined,
): Promise<string | null> {
  if (!qboAccountId) return null;
  const [row] = await db
    .select({ localId: qboEntityMap.localId })
    .from(qboEntityMap)
    .where(and(
      eq(qboEntityMap.organizationId, ctx.organizationId),
      eq(qboEntityMap.realmId, ctx.realmId),
      eq(qboEntityMap.entityType, 'account'),
      eq(qboEntityMap.qboId, qboAccountId),
    ))
    .limit(1);
  return row?.localId ?? null;
}

export async function upsertItem({ ctx, operation, raw }: UpsertArgs<QboItem>): Promise<UpsertResult> {
  const existingMap = await loadEntityMap(ctx.organizationId, ctx.realmId, 'item', raw.Id);

  if (operation !== 'Create' && operation !== 'Update' && operation !== 'Delete' && operation !== 'Merge') {
    return { kind: 'skipped_unsupported_op', operation };
  }

  if (operation === 'Delete') {
    if (!existingMap) return { kind: 'skipped_no_change' };
    await db.update(items).set({ isActive: false, updatedAt: new Date().toISOString() })
      .where(eq(items.id, existingMap.localId));
    await db
      .update(qboEntityMap)
      .set({ syncStatus: 'deleted', updatedAt: new Date().toISOString() })
      .where(eq(qboEntityMap.id, existingMap.id));
    return { kind: 'deleted', localId: existingMap.localId };
  }

  if (operation === 'Merge') {
    logger.warn({ qboId: raw.Id }, 'qbo item merge not yet handled');
    return { kind: 'skipped_unsupported_op', operation };
  }

  const inboundUpdatedAt = lastUpdated(raw);
  const syncToken = raw.SyncToken ?? null;
  const incomeAccountId = await resolveAccountLocalId(ctx, raw.IncomeAccountRef?.value);
  const expenseAccountId = await resolveAccountLocalId(ctx, raw.ExpenseAccountRef?.value);

  if (existingMap) {
    if (detectConflict(existingMap, inboundUpdatedAt)) {
      await writeConflict({
        organizationId: ctx.organizationId,
        entityMapId: existingMap.id,
        qboSnapshot: raw as unknown as Record<string, unknown>,
        localSnapshot: { localId: existingMap.localId, lastLocalUpdatedAt: existingMap.lastLocalUpdatedAt },
      });
      return { kind: 'conflict', entityMapId: existingMap.id };
    }
    if (existingMap.lastQboUpdatedAt &&
        new Date(inboundUpdatedAt).getTime() <= new Date(existingMap.lastQboUpdatedAt).getTime()) {
      return { kind: 'skipped_no_change' };
    }
    await db.update(items).set({
      name: raw.Name,
      description: raw.Description ?? null,
      unitPrice: raw.UnitPrice !== undefined ? String(raw.UnitPrice) : null,
      incomeAccountId,
      expenseAccountId,
      isActive: raw.Active ?? true,
      updatedAt: new Date().toISOString(),
    }).where(eq(items.id, existingMap.localId));
    await recordInboundSync({ entityMapId: existingMap.id, lastQboUpdatedAt: inboundUpdatedAt, qboSyncToken: syncToken });
    return { kind: 'updated', localId: existingMap.localId, entityMapId: existingMap.id };
  }

  // Create. Items has no unique-on-name constraint in this schema, so a
  // straight insert is safe. We don't try to match by name first — Items
  // don't have the same "user edited the same row from two sides" risk
  // that contacts/accounts do.
  const localId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(items).values({
    id: localId,
    organizationId: ctx.organizationId,
    name: raw.Name,
    description: raw.Description ?? null,
    unitPrice: raw.UnitPrice !== undefined ? String(raw.UnitPrice) : null,
    incomeAccountId,
    expenseAccountId,
    isActive: raw.Active ?? true,
    createdAt: now,
    updatedAt: now,
  });
  const mapId = await createEntityMap({
    organizationId: ctx.organizationId,
    realmId: ctx.realmId,
    entityType: 'item',
    qboId: raw.Id,
    localId,
    lastQboUpdatedAt: inboundUpdatedAt,
    qboSyncToken: syncToken,
  });
  return { kind: 'created', localId, entityMapId: mapId };
}
