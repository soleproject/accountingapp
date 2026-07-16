import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import {
  qboEntityMap,
  qboAccountStaging,
  qboCustomerStaging,
  qboVendorStaging,
  qboInvoiceStaging,
  qboBillStaging,
  qboPaymentStaging,
  qboBillPaymentStaging,
  qboPurchaseStaging,
  qboDepositStaging,
  qboTransferStaging,
  qboJournalEntryStaging,
  chartOfAccounts,
  contacts,
  invoices,
  invoiceLines,
  invoicePayments,
  invoicePaymentApplications,
  bills,
  billLines,
  billPayments,
  billPaymentApplications,
  transactions,
  transactionSplits,
} from '@/db/schema/schema';
import { mapQboAccountType, normalizeDetailType } from './account-types';
import { createJournalEntry } from '@/lib/accounting/posting';
import { logger } from '@/lib/logger';

export interface PromoteResult {
  created: number;
  skipped: number;
  errored: number;
}

interface PromoteCtx {
  organizationId: string;
  realmId: string;
  migrationJobId: string;
}

/**
 * Look up an existing local id for a (org, realm, entityType, qboId).
 * MUST include organizationId — without it, two rocketsuite workspaces
 * connecting the same QBO realm would share each other's mappings, and
 * promote would silently skip records that already exist *for the other
 * org*.
 */
async function lookupLocalId(organizationId: string, realmId: string, entityType: string, qboId: string): Promise<string | null> {
  const [row] = await db
    .select({ localId: qboEntityMap.localId })
    .from(qboEntityMap)
    .where(and(
      eq(qboEntityMap.organizationId, organizationId),
      eq(qboEntityMap.realmId, realmId),
      eq(qboEntityMap.entityType, entityType),
      eq(qboEntityMap.qboId, qboId),
    ))
    .limit(1);
  return row?.localId ?? null;
}

/**
 * Insert a qboEntityMap row marking this (qboId ↔ localId) link as synced.
 * lastQboUpdatedAt comes from the staging row's QBO MetaData.LastUpdatedTime
 * if available, else now() — used later by conflict detection to compare
 * against future inbound webhooks.
 */
async function recordMapping(
  ctx: PromoteCtx,
  entityType: string,
  qboId: string,
  localId: string,
  rawJson: Record<string, unknown>,
): Promise<void> {
  const meta = (rawJson.MetaData as { LastUpdatedTime?: string } | undefined);
  const lastQboUpdatedAt = meta?.LastUpdatedTime ?? new Date().toISOString();
  const now = new Date().toISOString();
  await db.insert(qboEntityMap).values({
    id: randomUUID(),
    organizationId: ctx.organizationId,
    realmId: ctx.realmId,
    entityType,
    qboId,
    localId,
    lastQboUpdatedAt,
    lastSyncAt: now,
    syncStatus: 'synced',
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * One row of QBO Invoice.Line — relevant fields only. QBO returns a
 * heterogeneous Line[] including SubTotal/Discount/etc. that we filter out
 * via DetailType.
 */
interface QboLine {
  Id?: string;
  Description?: string;
  Amount: number;
  DetailType: string;
  SalesItemLineDetail?: {
    ItemRef?: { value: string; name?: string };
    UnitPrice?: number;
    Qty?: number;
    AccountRef?: { value: string; name?: string };
  };
  AccountBasedExpenseLineDetail?: {
    AccountRef?: { value: string; name?: string };
  };
  DepositLineDetail?: {
    AccountRef?: { value: string; name?: string };
  };
  JournalEntryLineDetail?: {
    PostingType?: 'Debit' | 'Credit';
    AccountRef?: { value: string; name?: string };
    Entity?: { Type?: string; EntityRef?: { value: string } };
  };
  LinkedTxn?: Array<{ TxnId: string; TxnType: string }>;
}

/**
 * Find the org's Accounts Receivable account. Tries exact accountType
 * match first, then a name match, then any asset with detail_type
 * AccountsReceivable. Returns null when the org has no AR account — caller
 * decides whether to skip the row or fail loudly.
 */
async function findOrgAccount(
  organizationId: string,
  predicates: { accountType?: string; gaapType?: string; detailType?: string; accountNameLike?: string },
): Promise<string | null> {
  const whereParts = [eq(chartOfAccounts.organizationId, organizationId)];
  if (predicates.accountType) whereParts.push(eq(chartOfAccounts.accountType, predicates.accountType));
  if (predicates.gaapType) whereParts.push(eq(chartOfAccounts.gaapType, predicates.gaapType));
  if (predicates.detailType) whereParts.push(eq(chartOfAccounts.detailType, predicates.detailType));
  const [row] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(...whereParts))
    .limit(1);
  return row?.id ?? null;
}

interface OrgDefaults {
  arAccountId: string | null;
  apAccountId: string | null;
  revenueAccountId: string | null;
  bankAccountId: string | null;
}

async function loadOrgDefaults(organizationId: string): Promise<OrgDefaults> {
  return {
    arAccountId:
      (await findOrgAccount(organizationId, { accountType: 'accounts_receivable' })) ??
      (await findOrgAccount(organizationId, { detailType: 'AccountsReceivable' })),
    apAccountId:
      (await findOrgAccount(organizationId, { accountType: 'accounts_payable' })) ??
      (await findOrgAccount(organizationId, { detailType: 'AccountsPayable' })),
    revenueAccountId: await findOrgAccount(organizationId, { gaapType: 'income' }),
    bankAccountId: await findOrgAccount(organizationId, { accountType: 'bank' }),
  };
}

export async function promoteAccounts(ctx: PromoteCtx): Promise<PromoteResult> {
  const stagingRows = await db
    .select()
    .from(qboAccountStaging)
    .where(eq(qboAccountStaging.migrationJobId, ctx.migrationJobId));

  let created = 0;
  let skipped = 0;
  let errored = 0;

  for (const row of stagingRows) {
    try {
      const existing = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', row.rawQboId);
      if (existing) {
        skipped++;
        continue;
      }

      const [byName] = await db
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(and(
          eq(chartOfAccounts.organizationId, ctx.organizationId),
          eq(chartOfAccounts.accountName, row.name),
        ))
        .limit(1);
      if (byName) {
        await recordMapping(ctx, 'account', row.rawQboId, byName.id, row.rawJson as Record<string, unknown>);
        created++;
        continue;
      }

      const taxonomy = mapQboAccountType(row.type);
      const raw = row.rawJson as { AcctNum?: string; AccountSubType?: string };
      // Store QB's subtype as snake_case so it aligns with seed/PFC slugs.
      // We no longer slot-match against an existing seed row — that path
      // silently collapsed N distinct QB accounts onto one local row when
      // they shared a subtype (e.g. multiple Bank/Checking accounts), and
      // the unique(org, gaap, detail) constraint is gone (migration 0024).
      // Every unclaimed QB account becomes its own row. PFC resolution
      // disambiguates by preferring system_generated=true.
      const detailType = normalizeDetailType(row.subtype ?? raw.AccountSubType ?? null);

      const accountNumber = raw.AcctNum?.toString().trim() || `qbo:${row.rawQboId}`;

      const localId = randomUUID();
      await db.insert(chartOfAccounts).values({
        id: localId,
        organizationId: ctx.organizationId,
        accountNumber,
        accountName: row.name,
        gaapType: taxonomy.gaapType,
        accountType: taxonomy.accountType,
        detailType,
        normalBalance: taxonomy.normalBalance,
        isActive: row.isActive,
        passedNameContactCheck: false,
      });
      await recordMapping(ctx, 'account', row.rawQboId, localId, row.rawJson as Record<string, unknown>);
      created++;
    } catch (err) {
      errored++;
      const top = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
      logger.warn({ qboId: row.rawQboId, name: row.name, err: top, cause }, 'qbo promote account failed');
    }
  }
  return { created, skipped, errored };
}

export async function promoteContacts(ctx: PromoteCtx): Promise<PromoteResult> {
  let created = 0;
  let skipped = 0;
  let errored = 0;

  const customerRows = await db
    .select()
    .from(qboCustomerStaging)
    .where(eq(qboCustomerStaging.migrationJobId, ctx.migrationJobId));

  for (const row of customerRows) {
    try {
      const existing = await lookupLocalId(ctx.organizationId, ctx.realmId, 'customer', row.rawQboId);
      if (existing) {
        skipped++;
        continue;
      }
      const [byName] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(
          eq(contacts.organizationId, ctx.organizationId),
          eq(contacts.contactName, row.displayName),
        ))
        .limit(1);
      if (byName) {
        await recordMapping(ctx, 'customer', row.rawQboId, byName.id, row.rawJson as Record<string, unknown>);
        created++;
        continue;
      }
      const localId = randomUUID();
      await db.insert(contacts).values({
        id: localId,
        organizationId: ctx.organizationId,
        contactName: row.displayName,
        email: row.primaryEmail,
        phone: row.primaryPhone,
        typeTags: ['customer'],
        isActive: true,
      });
      await recordMapping(ctx, 'customer', row.rawQboId, localId, row.rawJson as Record<string, unknown>);
      created++;
    } catch (err) {
      errored++;
      const top = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
      logger.warn({ qboId: row.rawQboId, name: row.displayName, err: top, cause }, 'qbo promote customer failed');
    }
  }

  const vendorRows = await db
    .select()
    .from(qboVendorStaging)
    .where(eq(qboVendorStaging.migrationJobId, ctx.migrationJobId));

  for (const row of vendorRows) {
    try {
      const existing = await lookupLocalId(ctx.organizationId, ctx.realmId, 'vendor', row.rawQboId);
      if (existing) {
        skipped++;
        continue;
      }
      const [byName] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(
          eq(contacts.organizationId, ctx.organizationId),
          eq(contacts.contactName, row.displayName),
        ))
        .limit(1);
      if (byName) {
        await recordMapping(ctx, 'vendor', row.rawQboId, byName.id, row.rawJson as Record<string, unknown>);
        created++;
        continue;
      }
      const localId = randomUUID();
      await db.insert(contacts).values({
        id: localId,
        organizationId: ctx.organizationId,
        contactName: row.displayName,
        email: row.primaryEmail,
        phone: row.primaryPhone,
        typeTags: ['vendor'],
        isActive: true,
      });
      await recordMapping(ctx, 'vendor', row.rawQboId, localId, row.rawJson as Record<string, unknown>);
      created++;
    } catch (err) {
      errored++;
      const top = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
      logger.warn({ qboId: row.rawQboId, name: row.displayName, err: top, cause }, 'qbo promote vendor failed');
    }
  }
  return { created, skipped, errored };
}

function deriveInvoiceStatus(total: string, balance: string): string {
  const t = Number(total);
  const b = Number(balance);
  if (b === 0) return 'paid';
  if (b < t) return 'partial';
  return 'open';
}

/**
 * Promote QBO invoices into local `invoices`, with their line items in
 * `invoice_lines` and a posted journal entry (debit AR / credit revenue).
 *
 * Per-line revenue account inference: QBO Invoice lines reference an Item
 * via SalesItemLineDetail.ItemRef, and that Item carries the income
 * account. We don't yet pull the Item entity, so we credit all revenue to
 * a single default revenue account per org (gaap_type='revenue'). This
 * loses per-line account fidelity but keeps debits=credits and totals
 * correct in aggregate. A future Items-import slice can refine this.
 */
export async function promoteInvoices(ctx: PromoteCtx): Promise<PromoteResult> {
  const defaults = await loadOrgDefaults(ctx.organizationId);
  const stagingRows = await db
    .select()
    .from(qboInvoiceStaging)
    .where(eq(qboInvoiceStaging.migrationJobId, ctx.migrationJobId));

  let created = 0;
  let skipped = 0;
  let errored = 0;

  for (const row of stagingRows) {
    try {
      const existing = await lookupLocalId(ctx.organizationId, ctx.realmId, 'invoice', row.rawQboId);
      if (existing) {
        skipped++;
        continue;
      }
      if (!row.customerQboId) {
        errored++;
        logger.warn({ qboId: row.rawQboId }, 'qbo invoice has no CustomerRef, skipping');
        continue;
      }
      const contactId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'customer', row.customerQboId);
      if (!contactId) {
        errored++;
        logger.warn({ qboId: row.rawQboId, customerQboId: row.customerQboId }, 'qbo invoice references unmapped customer');
        continue;
      }
      if (!defaults.arAccountId) {
        errored++;
        logger.warn({ qboId: row.rawQboId, orgId: ctx.organizationId }, 'qbo invoice promote: no AR account on org');
        continue;
      }
      if (!defaults.revenueAccountId) {
        errored++;
        logger.warn({ qboId: row.rawQboId, orgId: ctx.organizationId }, 'qbo invoice promote: no revenue account on org');
        continue;
      }

      const raw = row.rawJson as { DocNumber?: string; Line?: QboLine[]; TotalAmt?: number };
      // Filter to revenue-bearing lines. QBO mixes line types; SubTotal/
      // Discount lines aren't real line items and we'd double-count them.
      const lineItems = (raw.Line ?? []).filter((l) => l.DetailType === 'SalesItemLineDetail');
      const total = Number(row.totalAmount);

      const localId = randomUUID();
      const invoiceDate = row.txnDate ?? new Date().toISOString().slice(0, 10);
      const now = new Date().toISOString();

      await db.transaction(async (tx) => {
        // Post JE first so we can wire invoice.journalEntryId in one row.
        const jeResult = await createJournalEntry({
          organizationId: ctx.organizationId,
          date: invoiceDate,
          memo: raw.DocNumber ? `Invoice ${raw.DocNumber} (QBO)` : 'Invoice (QBO)',
          posted: true,
          sourceType: 'invoice',
          sourceId: localId,
          lines: [
            { accountId: defaults.arAccountId!, debit: total, credit: 0, contactId, memo: 'A/R' },
            { accountId: defaults.revenueAccountId!, debit: 0, credit: total, contactId, memo: 'Revenue' },
          ],
        }, tx);

        await tx.insert(invoices).values({
          id: localId,
          organizationId: ctx.organizationId,
          contactId,
          invoiceNumber: raw.DocNumber ?? null,
          invoiceDate,
          dueDate: row.dueDate,
          status: deriveInvoiceStatus(row.totalAmount, row.balance),
          posted: true,
          postedAt: now,
          journalEntryId: jeResult.id,
          arAccountId: defaults.arAccountId,
        });

        // Insert line items. Even when QBO has no SalesItemLineDetail rows
        // (shouldn't happen for real invoices but defensive), fall back to
        // a single line so the bill UI shows the total instead of $0.
        if (lineItems.length === 0) {
          await tx.insert(invoiceLines).values({
            id: randomUUID(),
            invoiceId: localId,
            description: raw.DocNumber ? `Imported from QBO Invoice ${raw.DocNumber}` : 'Imported from QBO',
            quantity: '1',
            unitPrice: String(total),
            amount: String(total),
          });
        } else {
          for (const line of lineItems) {
            const qty = line.SalesItemLineDetail?.Qty ?? 1;
            const unitPrice = line.SalesItemLineDetail?.UnitPrice ?? (qty > 0 ? line.Amount / qty : line.Amount);
            await tx.insert(invoiceLines).values({
              id: randomUUID(),
              invoiceId: localId,
              description: line.Description ?? null,
              quantity: String(qty),
              unitPrice: String(unitPrice),
              amount: String(line.Amount),
            });
          }
        }
      });

      await recordMapping(ctx, 'invoice', row.rawQboId, localId, row.rawJson as Record<string, unknown>);
      created++;
    } catch (err) {
      errored++;
      const top = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
      logger.warn({ qboId: row.rawQboId, err: top, cause }, 'qbo promote invoice failed');
    }
  }
  return { created, skipped, errored };
}

/**
 * Promote QBO bills into local `bills` + `bill_lines` + JE. Unlike
 * invoices, QBO bill lines reference their expense account directly via
 * AccountBasedExpenseLineDetail.AccountRef, so we can preserve per-account
 * splits in the JE (debit each unique expense account, credit AP for the
 * total).
 */
export async function promoteBills(ctx: PromoteCtx): Promise<PromoteResult> {
  const defaults = await loadOrgDefaults(ctx.organizationId);
  const stagingRows = await db
    .select()
    .from(qboBillStaging)
    .where(eq(qboBillStaging.migrationJobId, ctx.migrationJobId));

  let created = 0;
  let skipped = 0;
  let errored = 0;

  for (const row of stagingRows) {
    try {
      const existing = await lookupLocalId(ctx.organizationId, ctx.realmId, 'bill', row.rawQboId);
      if (existing) {
        skipped++;
        continue;
      }
      if (!row.vendorQboId) {
        errored++;
        logger.warn({ qboId: row.rawQboId }, 'qbo bill has no VendorRef, skipping');
        continue;
      }
      const contactId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'vendor', row.vendorQboId);
      if (!contactId) {
        errored++;
        logger.warn({ qboId: row.rawQboId, vendorQboId: row.vendorQboId }, 'qbo bill references unmapped vendor');
        continue;
      }
      if (!defaults.apAccountId) {
        errored++;
        logger.warn({ qboId: row.rawQboId, orgId: ctx.organizationId }, 'qbo bill promote: no AP account on org');
        continue;
      }

      const raw = row.rawJson as { DocNumber?: string; Line?: QboLine[] };
      const expenseLines = (raw.Line ?? []).filter((l) => l.DetailType === 'AccountBasedExpenseLineDetail');
      const total = Number(row.totalAmount);

      // Aggregate JE debits by expense account. Resolve each QBO
      // AccountRef.value to its local id via qbo_entity_map. Any line
      // whose account isn't mapped yet falls back to a synthetic
      // "Uncategorized Expense" account (any expense-gaap account) so the
      // bill can still post; an unmapped account means the user's QBO
      // chart has accounts the promote step couldn't import.
      const fallbackExpenseAccount = await findOrgAccount(ctx.organizationId, { gaapType: 'expense' });
      const byAccount = new Map<string, number>();
      for (const line of expenseLines) {
        const qboAccountId = line.AccountBasedExpenseLineDetail?.AccountRef?.value;
        let localAccountId: string | null = null;
        if (qboAccountId) {
          localAccountId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', qboAccountId);
        }
        const accountId = localAccountId ?? fallbackExpenseAccount;
        if (!accountId) continue; // truly nothing to debit; skip silently
        byAccount.set(accountId, (byAccount.get(accountId) ?? 0) + line.Amount);
      }

      // No mappable expense lines → debit fallback for the full total so
      // the JE still balances. Better an imperfect post than no post.
      if (byAccount.size === 0 && fallbackExpenseAccount) {
        byAccount.set(fallbackExpenseAccount, total);
      }
      if (byAccount.size === 0) {
        errored++;
        logger.warn({ qboId: row.rawQboId }, 'qbo bill promote: no expense account available, skipping');
        continue;
      }

      const localId = randomUUID();
      const billDate = row.txnDate ?? new Date().toISOString().slice(0, 10);
      const balance = Number(row.balance);

      await db.transaction(async (tx) => {
        const jeLines = [
          ...Array.from(byAccount.entries()).map(([accountId, amount]) => ({
            accountId,
            debit: amount,
            credit: 0,
            contactId,
            memo: 'Expense',
          })),
          { accountId: defaults.apAccountId!, debit: 0, credit: total, contactId, memo: 'A/P' },
        ];
        await createJournalEntry({
          organizationId: ctx.organizationId,
          date: billDate,
          memo: raw.DocNumber ? `Bill ${raw.DocNumber} (QBO)` : 'Bill (QBO)',
          posted: true,
          sourceType: 'bill',
          sourceId: localId,
          lines: jeLines,
        }, tx);

        await tx.insert(bills).values({
          id: localId,
          organizationId: ctx.organizationId,
          contactId,
          billNumber: raw.DocNumber ?? null,
          billDate,
          dueDate: row.dueDate,
          // The bills page reads status='posted' as "active, unpaid" (vs
          // 'draft' for unsaved or 'paid' for settled). Use the same
          // convention since these bills have a posted JE.
          status: balance === 0 ? 'paid' : 'posted',
        });

        if (expenseLines.length === 0) {
          await tx.insert(billLines).values({
            id: randomUUID(),
            billId: localId,
            description: raw.DocNumber ? `Imported from QBO Bill ${raw.DocNumber}` : 'Imported from QBO',
            quantity: '1',
            unitPrice: String(total),
            amount: String(total),
          });
        } else {
          for (const line of expenseLines) {
            await tx.insert(billLines).values({
              id: randomUUID(),
              billId: localId,
              description: line.Description ?? null,
              quantity: '1',
              unitPrice: String(line.Amount),
              amount: String(line.Amount),
            });
          }
        }
      });

      await recordMapping(ctx, 'bill', row.rawQboId, localId, row.rawJson as Record<string, unknown>);
      created++;
    } catch (err) {
      errored++;
      const top = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
      logger.warn({ qboId: row.rawQboId, err: top, cause }, 'qbo promote bill failed');
    }
  }
  return { created, skipped, errored };
}

/**
 * Promote QBO customer payments → invoice_payments + applications + JE.
 * Each QBO Payment.Line.LinkedTxn[TxnType='Invoice'] becomes one
 * invoice_payment_applications row mapping the payment to the local
 * invoice (resolved via qbo_entity_map). JE: debit bank/UF, credit AR.
 */
export async function promotePayments(ctx: PromoteCtx): Promise<PromoteResult> {
  const defaults = await loadOrgDefaults(ctx.organizationId);
  const stagingRows = await db
    .select()
    .from(qboPaymentStaging)
    .where(eq(qboPaymentStaging.migrationJobId, ctx.migrationJobId));

  let created = 0;
  let skipped = 0;
  let errored = 0;

  for (const row of stagingRows) {
    try {
      const existing = await lookupLocalId(ctx.organizationId, ctx.realmId, 'payment', row.rawQboId);
      if (existing) {
        skipped++;
        continue;
      }
      if (!row.customerQboId) {
        errored++;
        logger.warn({ qboId: row.rawQboId }, 'qbo payment has no CustomerRef, skipping');
        continue;
      }
      const contactId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'customer', row.customerQboId);
      if (!contactId) {
        errored++;
        logger.warn({ qboId: row.rawQboId, customerQboId: row.customerQboId }, 'qbo payment references unmapped customer');
        continue;
      }
      if (!defaults.arAccountId) {
        errored++;
        logger.warn({ qboId: row.rawQboId }, 'qbo payment promote: no AR account on org');
        continue;
      }

      // $0 QBO payments (credit memos, zero-balance reconciliations) are
      // real records — they preserve invoice-application linkage even
      // without money movement. Record the invoice_payment row and
      // applications, but skip the JE post since debit=credit=0 fails
      // the JE validator.
      const total = Number(row.totalAmount);
      const skipJe = total === 0;

      const raw = row.rawJson as {
        Line?: QboLine[];
        DepositToAccountRef?: { value: string };
      };

      // Where the money landed: QBO DepositToAccountRef → local bank.
      // Fallback to org's first bank account, then the AR account (a
      // wash but at least the JE balances) if neither exists.
      const depositAccountQboId = raw.DepositToAccountRef?.value;
      let depositAccountId: string | null = null;
      if (depositAccountQboId) {
        depositAccountId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', depositAccountQboId);
      }
      depositAccountId ??= defaults.bankAccountId;

      if (!depositAccountId) {
        errored++;
        logger.warn({ qboId: row.rawQboId }, 'qbo payment promote: no deposit/bank account found, skipping');
        continue;
      }

      const paymentDate = row.txnDate ?? new Date().toISOString().slice(0, 10);
      const localId = randomUUID();

      // Resolve linked invoices BEFORE the transaction so a missing
      // mapping doesn't roll back the JE/payment we already validated.
      // Unresolved linked invoices are dropped from the application set
      // but the payment row still gets created.
      const linkedApps: Array<{ invoiceId: string; amount: number }> = [];
      for (const line of raw.Line ?? []) {
        const linked = line.LinkedTxn?.find((t) => t.TxnType === 'Invoice');
        if (!linked) continue;
        const localInvoiceId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'invoice', linked.TxnId);
        if (!localInvoiceId) continue;
        linkedApps.push({ invoiceId: localInvoiceId, amount: line.Amount });
      }

      await db.transaction(async (tx) => {
        if (!skipJe) {
          await createJournalEntry({
            organizationId: ctx.organizationId,
            date: paymentDate,
            memo: 'Customer payment (QBO)',
            posted: true,
            sourceType: 'invoice_payment',
            sourceId: localId,
            lines: [
              { accountId: depositAccountId!, debit: total, credit: 0, contactId, memo: 'Cash in' },
              { accountId: defaults.arAccountId!, debit: 0, credit: total, contactId, memo: 'A/R' },
            ],
          }, tx);
        }

        await tx.insert(invoicePayments).values({
          id: localId,
          organizationId: ctx.organizationId,
          contactId,
          paymentDate,
          amount: String(total),
        });

        for (const app of linkedApps) {
          await tx.insert(invoicePaymentApplications).values({
            id: randomUUID(),
            invoicePaymentId: localId,
            invoiceId: app.invoiceId,
            amountApplied: String(app.amount),
          });
        }
      });

      await recordMapping(ctx, 'payment', row.rawQboId, localId, row.rawJson as Record<string, unknown>);
      created++;
    } catch (err) {
      errored++;
      const top = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
      logger.warn({ qboId: row.rawQboId, err: top, cause }, 'qbo promote payment failed');
    }
  }
  return { created, skipped, errored };
}

/**
 * Promote QBO BillPayment → bill_payments + applications + JE. Mirror of
 * promotePayments on the AP side: debit AP (reducing the liability),
 * credit the bank account that funded the payment.
 */
export async function promoteBillPayments(ctx: PromoteCtx): Promise<PromoteResult> {
  const defaults = await loadOrgDefaults(ctx.organizationId);
  const stagingRows = await db
    .select()
    .from(qboBillPaymentStaging)
    .where(eq(qboBillPaymentStaging.migrationJobId, ctx.migrationJobId));

  let created = 0;
  let skipped = 0;
  let errored = 0;

  for (const row of stagingRows) {
    try {
      const existing = await lookupLocalId(ctx.organizationId, ctx.realmId, 'billPayment', row.rawQboId);
      if (existing) {
        skipped++;
        continue;
      }
      if (!row.vendorQboId) {
        errored++;
        logger.warn({ qboId: row.rawQboId }, 'qbo billPayment has no VendorRef, skipping');
        continue;
      }
      const contactId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'vendor', row.vendorQboId);
      if (!contactId) {
        errored++;
        logger.warn({ qboId: row.rawQboId, vendorQboId: row.vendorQboId }, 'qbo billPayment references unmapped vendor');
        continue;
      }
      if (!defaults.apAccountId) {
        errored++;
        logger.warn({ qboId: row.rawQboId }, 'qbo billPayment promote: no AP account on org');
        continue;
      }

      const raw = row.rawJson as {
        Line?: QboLine[];
        PayType?: string;
        CheckPayment?: { BankAccountRef?: { value: string } };
        CreditCardPayment?: { CCAccountRef?: { value: string } };
      };

      // Source-of-cash account: depends on PayType. Check uses
      // CheckPayment.BankAccountRef, credit card uses
      // CreditCardPayment.CCAccountRef. Fall back to org default bank.
      const sourceQboId =
        raw.CheckPayment?.BankAccountRef?.value ??
        raw.CreditCardPayment?.CCAccountRef?.value;
      let sourceAccountId: string | null = null;
      if (sourceQboId) {
        sourceAccountId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', sourceQboId);
      }
      sourceAccountId ??= defaults.bankAccountId;

      if (!sourceAccountId) {
        errored++;
        logger.warn({ qboId: row.rawQboId }, 'qbo billPayment promote: no source account, skipping');
        continue;
      }

      const total = Number(row.totalAmount);
      const skipJe = total === 0;
      const paymentDate = row.txnDate ?? new Date().toISOString().slice(0, 10);
      const localId = randomUUID();

      const linkedApps: Array<{ billId: string; amount: number }> = [];
      for (const line of raw.Line ?? []) {
        const linked = line.LinkedTxn?.find((t) => t.TxnType === 'Bill');
        if (!linked) continue;
        const localBillId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'bill', linked.TxnId);
        if (!localBillId) continue;
        linkedApps.push({ billId: localBillId, amount: line.Amount });
      }

      await db.transaction(async (tx) => {
        if (!skipJe) {
          await createJournalEntry({
            organizationId: ctx.organizationId,
            date: paymentDate,
            memo: 'Vendor payment (QBO)',
            posted: true,
            sourceType: 'bill_payment',
            sourceId: localId,
            lines: [
              { accountId: defaults.apAccountId!, debit: total, credit: 0, contactId, memo: 'A/P' },
              { accountId: sourceAccountId!, debit: 0, credit: total, contactId, memo: 'Cash out' },
            ],
          }, tx);
        }

        await tx.insert(billPayments).values({
          id: localId,
          organizationId: ctx.organizationId,
          contactId,
          paymentDate,
          amount: String(total),
        });

        for (const app of linkedApps) {
          await tx.insert(billPaymentApplications).values({
            id: randomUUID(),
            billPaymentId: localId,
            billId: app.billId,
            amountApplied: String(app.amount),
          });
        }
      });

      await recordMapping(ctx, 'billPayment', row.rawQboId, localId, row.rawJson as Record<string, unknown>);
      created++;
    } catch (err) {
      errored++;
      const top = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
      logger.warn({ qboId: row.rawQboId, err: top, cause }, 'qbo promote billPayment failed');
    }
  }
  return { created, skipped, errored };
}

/**
 * Promote QBO Purchase → rocketsuite `transactions` + posted JE. Purchases
 * are expenses paid directly (cash, check, credit card) without going
 * through a Bill — the QBO equivalent of swiping a card at a vendor.
 *
 * JE: debit each line's expense account, credit the source-of-funds
 * account (the bank/CC the money left). The transactions row links to
 * the source account so it shows up correctly in bank-feed-style views.
 * Multi-line purchases collapse to one transactions row (first line's
 * category as the primary, full total as the amount); the JE preserves
 * the per-account splits.
 */
export async function promotePurchases(ctx: PromoteCtx): Promise<PromoteResult> {
  const stagingRows = await db
    .select()
    .from(qboPurchaseStaging)
    .where(eq(qboPurchaseStaging.migrationJobId, ctx.migrationJobId));

  let created = 0;
  let skipped = 0;
  let errored = 0;

  for (const row of stagingRows) {
    try {
      const existing = await lookupLocalId(ctx.organizationId, ctx.realmId, 'purchase', row.rawQboId);
      if (existing) {
        skipped++;
        continue;
      }

      const sourceQboId = row.accountQboId;
      if (!sourceQboId) {
        errored++;
        logger.warn({ qboId: row.rawQboId }, 'qbo purchase has no source AccountRef, skipping');
        continue;
      }
      const sourceAccountId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', sourceQboId);
      if (!sourceAccountId) {
        errored++;
        logger.warn({ qboId: row.rawQboId, sourceQboId }, 'qbo purchase source account not mapped');
        continue;
      }

      const contactId = row.vendorQboId
        ? await lookupLocalId(ctx.organizationId, ctx.realmId, 'vendor', row.vendorQboId)
        : null;

      const raw = row.rawJson as { Line?: QboLine[]; PaymentType?: string; PrivateNote?: string };
      const expenseLines = (raw.Line ?? []).filter((l) => l.DetailType === 'AccountBasedExpenseLineDetail');
      const total = Number(row.totalAmount);
      const txnDate = row.txnDate ?? new Date().toISOString().slice(0, 10);

      // Aggregate JE debits by expense account (same pattern as bills).
      const fallbackExpenseAccount = await findOrgAccount(ctx.organizationId, { gaapType: 'expense' });
      const byAccount = new Map<string, number>();
      for (const line of expenseLines) {
        const qboAccountId = line.AccountBasedExpenseLineDetail?.AccountRef?.value;
        let localAccountId: string | null = null;
        if (qboAccountId) {
          localAccountId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', qboAccountId);
        }
        const accountId = localAccountId ?? fallbackExpenseAccount;
        if (!accountId) continue;
        byAccount.set(accountId, (byAccount.get(accountId) ?? 0) + line.Amount);
      }
      if (byAccount.size === 0 && fallbackExpenseAccount && total > 0) {
        byAccount.set(fallbackExpenseAccount, total);
      }
      if (byAccount.size === 0 || total <= 0) {
        // Either no expense lines + no fallback, or $0 purchase. Skip
        // since the JE wouldn't balance.
        errored++;
        logger.warn({ qboId: row.rawQboId, total }, 'qbo purchase: no postable JE, skipping');
        continue;
      }

      const primaryCategoryId = Array.from(byAccount.keys())[0];
      const localId = randomUUID();

      await db.transaction(async (tx) => {
        const jeLines = [
          ...Array.from(byAccount.entries()).map(([accountId, amount]) => ({
            accountId,
            debit: amount,
            credit: 0,
            contactId,
            memo: 'Expense',
          })),
          { accountId: sourceAccountId!, debit: 0, credit: total, contactId, memo: 'Cash out' },
        ];
        const je = await createJournalEntry({
          organizationId: ctx.organizationId,
          date: txnDate,
          memo: `Purchase (QBO)`,
          posted: true,
          sourceType: 'qbo_purchase',
          sourceId: localId,
          lines: jeLines,
        }, tx);

        await tx.insert(transactions).values({
          id: localId,
          organizationId: ctx.organizationId,
          date: txnDate,
          description: raw.PrivateNote ?? expenseLines[0]?.Description ?? 'QBO purchase',
          reference: `qbo:purchase:${row.rawQboId}`,
          amount: total,
          type: 'withdrawal',
          accountId: sourceAccountId,
          categoryAccountId: primaryCategoryId,
          contactId,
          journalEntryId: je.id,
          reviewed: true,
        });

        // Mirror multi-line purchases into transaction_splits so the
        // detail page renders the real shape (instead of collapsing to
        // the arbitrary "primary" account). Position matches byAccount
        // iteration order, which matches the JE line order built above.
        if (byAccount.size > 1) {
          const entries = Array.from(byAccount.entries());
          await tx.insert(transactionSplits).values(
            entries.map(([accountId, amount], idx) => ({
              id: randomUUID(),
              transactionId: localId,
              organizationId: ctx.organizationId,
              categoryAccountId: accountId,
              amount: amount.toFixed(2),
              memo: 'Expense',
              contactId,
              position: idx,
            })),
          );
        }
      });

      await recordMapping(ctx, 'purchase', row.rawQboId, localId, row.rawJson as Record<string, unknown>);
      created++;
    } catch (err) {
      errored++;
      const top = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
      logger.warn({ qboId: row.rawQboId, err: top, cause }, 'qbo promote purchase failed');
    }
  }
  return { created, skipped, errored };
}

/**
 * Promote QBO Deposit → `transactions` + JE. Deposits are cash incoming
 * not tied to an Invoice (owner contribution, interest, refunds, etc.).
 * JE: debit the deposit-to bank account, credit each line's income/asset
 * account.
 */
export async function promoteDeposits(ctx: PromoteCtx): Promise<PromoteResult> {
  const stagingRows = await db
    .select()
    .from(qboDepositStaging)
    .where(eq(qboDepositStaging.migrationJobId, ctx.migrationJobId));

  let created = 0;
  let skipped = 0;
  let errored = 0;

  for (const row of stagingRows) {
    try {
      const existing = await lookupLocalId(ctx.organizationId, ctx.realmId, 'deposit', row.rawQboId);
      if (existing) {
        skipped++;
        continue;
      }
      if (!row.depositToAccountQboId) {
        errored++;
        logger.warn({ qboId: row.rawQboId }, 'qbo deposit has no DepositToAccountRef, skipping');
        continue;
      }
      const bankAccountId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', row.depositToAccountQboId);
      if (!bankAccountId) {
        errored++;
        logger.warn({ qboId: row.rawQboId, depositToAccountQboId: row.depositToAccountQboId }, 'qbo deposit destination not mapped');
        continue;
      }

      const raw = row.rawJson as { Line?: QboLine[]; PrivateNote?: string };
      const depositLines = (raw.Line ?? []).filter((l) => l.DetailType === 'DepositLineDetail');
      const total = Number(row.totalAmount);
      const txnDate = row.txnDate ?? new Date().toISOString().slice(0, 10);

      // Aggregate JE credits by source account (income or other-asset
      // typically). Fallback to a default revenue account when QBO line
      // can't be mapped — better an imperfect post than a missing one.
      const fallbackIncomeAccount = await findOrgAccount(ctx.organizationId, { gaapType: 'income' });
      const byAccount = new Map<string, number>();
      for (const line of depositLines) {
        const qboAccountId = line.DepositLineDetail?.AccountRef?.value;
        let localAccountId: string | null = null;
        if (qboAccountId) {
          localAccountId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', qboAccountId);
        }
        const accountId = localAccountId ?? fallbackIncomeAccount;
        if (!accountId) continue;
        byAccount.set(accountId, (byAccount.get(accountId) ?? 0) + line.Amount);
      }
      if (byAccount.size === 0 && fallbackIncomeAccount && total > 0) {
        byAccount.set(fallbackIncomeAccount, total);
      }
      if (byAccount.size === 0 || total <= 0) {
        errored++;
        logger.warn({ qboId: row.rawQboId, total }, 'qbo deposit: no postable JE, skipping');
        continue;
      }

      const primaryCategoryId = Array.from(byAccount.keys())[0];
      const localId = randomUUID();

      await db.transaction(async (tx) => {
        const jeLines = [
          { accountId: bankAccountId!, debit: total, credit: 0, memo: 'Cash in' },
          ...Array.from(byAccount.entries()).map(([accountId, amount]) => ({
            accountId,
            debit: 0,
            credit: amount,
            memo: 'Deposit source',
          })),
        ];
        const je = await createJournalEntry({
          organizationId: ctx.organizationId,
          date: txnDate,
          memo: 'Deposit (QBO)',
          posted: true,
          sourceType: 'qbo_deposit',
          sourceId: localId,
          lines: jeLines,
        }, tx);

        await tx.insert(transactions).values({
          id: localId,
          organizationId: ctx.organizationId,
          date: txnDate,
          description: raw.PrivateNote ?? depositLines[0]?.Description ?? 'QBO deposit',
          reference: `qbo:deposit:${row.rawQboId}`,
          amount: total,
          type: 'deposit',
          accountId: bankAccountId,
          categoryAccountId: primaryCategoryId,
          journalEntryId: je.id,
          reviewed: true,
        });

        // Mirror multi-line deposits — see promotePurchases for rationale.
        // Deposits have no vendor contact, so contactId stays null.
        if (byAccount.size > 1) {
          const entries = Array.from(byAccount.entries());
          await tx.insert(transactionSplits).values(
            entries.map(([accountId, amount], idx) => ({
              id: randomUUID(),
              transactionId: localId,
              organizationId: ctx.organizationId,
              categoryAccountId: accountId,
              amount: amount.toFixed(2),
              memo: 'Deposit source',
              contactId: null,
              position: idx,
            })),
          );
        }
      });

      await recordMapping(ctx, 'deposit', row.rawQboId, localId, row.rawJson as Record<string, unknown>);
      created++;
    } catch (err) {
      errored++;
      const top = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
      logger.warn({ qboId: row.rawQboId, err: top, cause }, 'qbo promote deposit failed');
    }
  }
  return { created, skipped, errored };
}

/**
 * Promote QBO Transfer → `transactions` (on the FROM side) + JE.
 * Transfers move money between two of the company's own accounts.
 * JE: debit destination, credit source. The transactions row reflects
 * the source perspective (money leaving — matches how it'd appear in
 * the source-account bank feed).
 */
export async function promoteTransfers(ctx: PromoteCtx): Promise<PromoteResult> {
  const stagingRows = await db
    .select()
    .from(qboTransferStaging)
    .where(eq(qboTransferStaging.migrationJobId, ctx.migrationJobId));

  let created = 0;
  let skipped = 0;
  let errored = 0;

  for (const row of stagingRows) {
    try {
      const existing = await lookupLocalId(ctx.organizationId, ctx.realmId, 'transfer', row.rawQboId);
      if (existing) {
        skipped++;
        continue;
      }
      if (!row.fromAccountQboId || !row.toAccountQboId) {
        errored++;
        logger.warn({ qboId: row.rawQboId }, 'qbo transfer missing from or to account, skipping');
        continue;
      }
      const fromAccountId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', row.fromAccountQboId);
      const toAccountId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', row.toAccountQboId);
      if (!fromAccountId || !toAccountId) {
        errored++;
        logger.warn({ qboId: row.rawQboId, fromAccountId, toAccountId }, 'qbo transfer endpoints not mapped');
        continue;
      }

      const total = Number(row.amount);
      if (total <= 0) {
        errored++;
        logger.warn({ qboId: row.rawQboId, total }, 'qbo transfer has non-positive amount, skipping');
        continue;
      }
      const txnDate = row.txnDate ?? new Date().toISOString().slice(0, 10);
      const localId = randomUUID();

      await db.transaction(async (tx) => {
        const je = await createJournalEntry({
          organizationId: ctx.organizationId,
          date: txnDate,
          memo: 'Transfer (QBO)',
          posted: true,
          sourceType: 'qbo_transfer',
          sourceId: localId,
          lines: [
            { accountId: toAccountId!, debit: total, credit: 0, memo: 'Transfer in' },
            { accountId: fromAccountId!, debit: 0, credit: total, memo: 'Transfer out' },
          ],
        }, tx);

        await tx.insert(transactions).values({
          id: localId,
          organizationId: ctx.organizationId,
          date: txnDate,
          description: 'QBO transfer',
          reference: `qbo:transfer:${row.rawQboId}`,
          amount: total,
          // Anchored to the source bank account (accountId = fromAccountId),
          // so from that account's POV money flowed out → 'withdrawal'.
          type: 'withdrawal',
          accountId: fromAccountId,
          categoryAccountId: toAccountId,
          journalEntryId: je.id,
          reviewed: true,
        });
      });

      await recordMapping(ctx, 'transfer', row.rawQboId, localId, row.rawJson as Record<string, unknown>);
      created++;
    } catch (err) {
      errored++;
      const top = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
      logger.warn({ qboId: row.rawQboId, err: top, cause }, 'qbo promote transfer failed');
    }
  }
  return { created, skipped, errored };
}

/**
 * Promote QBO JournalEntry → local `journal_entries` directly (no
 * `transactions` row — JEs are multi-account adjustments, not single
 * bank-line transactions). Each QBO Line.JournalEntryLineDetail.PostingType
 * (Debit|Credit) becomes the corresponding side of a journal_entry_lines
 * row. createJournalEntry validates the JE balances.
 */
export async function promoteJournalEntries(ctx: PromoteCtx): Promise<PromoteResult> {
  const stagingRows = await db
    .select()
    .from(qboJournalEntryStaging)
    .where(eq(qboJournalEntryStaging.migrationJobId, ctx.migrationJobId));

  let created = 0;
  let skipped = 0;
  let errored = 0;

  for (const row of stagingRows) {
    try {
      const existing = await lookupLocalId(ctx.organizationId, ctx.realmId, 'journalEntry', row.rawQboId);
      if (existing) {
        skipped++;
        continue;
      }

      const raw = row.rawJson as { Line?: QboLine[]; PrivateNote?: string; DocNumber?: string };
      const jeLines = (raw.Line ?? []).filter((l) => l.DetailType === 'JournalEntryLineDetail');
      if (jeLines.length === 0) {
        errored++;
        logger.warn({ qboId: row.rawQboId }, 'qbo journal entry has no JournalEntryLineDetail lines, skipping');
        continue;
      }

      // Resolve every account ref up front. If any line's account isn't
      // mapped, the whole JE can't post correctly — skip the entire
      // entry (rather than rebalance with a fallback that'd misstate
      // the books).
      const resolvedLines: Array<{ accountId: string; debit: number; credit: number; memo: string | null }> = [];
      let unmappedAccount = false;
      for (const line of jeLines) {
        const qboAccountId = line.JournalEntryLineDetail?.AccountRef?.value;
        if (!qboAccountId) { unmappedAccount = true; break; }
        const localAccountId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', qboAccountId);
        if (!localAccountId) { unmappedAccount = true; break; }
        const isDebit = line.JournalEntryLineDetail?.PostingType === 'Debit';
        resolvedLines.push({
          accountId: localAccountId,
          debit: isDebit ? line.Amount : 0,
          credit: isDebit ? 0 : line.Amount,
          memo: line.Description ?? null,
        });
      }
      if (unmappedAccount) {
        errored++;
        logger.warn({ qboId: row.rawQboId }, 'qbo journal entry references unmapped account, skipping');
        continue;
      }

      const txnDate = row.txnDate ?? new Date().toISOString().slice(0, 10);
      const localId = randomUUID();

      await db.transaction(async (tx) => {
        await createJournalEntry({
          organizationId: ctx.organizationId,
          date: txnDate,
          memo: raw.PrivateNote ?? (raw.DocNumber ? `JE ${raw.DocNumber} (QBO)` : 'JE (QBO)'),
          posted: true,
          sourceType: 'qbo_journal_entry',
          sourceId: localId,
          lines: resolvedLines,
        }, tx);
      });

      // The local id used for sourceId is also the qbo_entity_map.localId.
      // We didn't use createJournalEntry's returned id because we want
      // (org, realm, type='journalEntry', localId=sourceId) to point at
      // something stable the QBO side can re-resolve via sourceId queries.
      await recordMapping(ctx, 'journalEntry', row.rawQboId, localId, row.rawJson as Record<string, unknown>);
      created++;
    } catch (err) {
      errored++;
      const top = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
      logger.warn({ qboId: row.rawQboId, err: top, cause }, 'qbo promote journalEntry failed');
    }
  }
  return { created, skipped, errored };
}

export async function promotedCountsByType(organizationId: string, realmId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ entityType: qboEntityMap.entityType, n: sql<number>`COUNT(*)::int` })
    .from(qboEntityMap)
    .where(and(
      eq(qboEntityMap.organizationId, organizationId),
      eq(qboEntityMap.realmId, realmId),
    ))
    .groupBy(qboEntityMap.entityType);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.entityType] = r.n;
  return out;
}
