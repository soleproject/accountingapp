import 'server-only';
import { randomUUID } from 'crypto';
import { eq, and, inArray, gte, lte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { imports, importedTransactions, transactions } from '@/db/schema/schema';
import { buildTwinIndex, twinKey } from '@/lib/audit/dedupe';
import { resolveContact } from './resolve-contact-ai';
import { resolveVeryfiCategory } from './resolve-veryfi-category';
import { createJournalEntryFromTransaction } from './auto-post';
import { JournalEntryError } from './posting';
import { logger } from '@/lib/logger';
import { getOrgCoverageWindow, dateIsCovered } from '@/lib/billing/entitlements';

export interface ImportedPromoteResult {
  promoted: number;
  skipped: number;
  /**
   * Rows held back because the org doesn't own the year. The imported
   * row stays in imported_transactions with promotion_status untouched;
   * a future run after the matching year unlock is granted will promote
   * it (the entitlement webhook triggers a re-promote of every import
   * for the org).
   */
  pendingUnlock: number;
  pendingByYear: Record<number, number>;
  reason?: string;
  newTransactionIds: string[];
  /**
   * Statement rows quarantined as duplicates of an existing higher-precedence
   * (Plaid / QBO) transaction on the same account+day+amount. They're inserted
   * as dedupe_state='duplicate' with NO journal entry, so they never double-post;
   * they appear only in the "Removed duplicates" bucket.
   */
  dedupedAgainstFeed?: number;
}

/**
 * Map an imported_transactions row to our (type, positive amount) convention.
 *
 * Veryfi line items typically have:
 *   - amount: number (positive or negative)
 *   - type: 'debit' | 'credit' | 'deposit' | 'withdrawal' | other free-form
 *
 * Convention here:
 *   - 'debit' / 'withdrawal' → money OUT → withdrawal
 *   - 'credit' / 'deposit'   → money IN → deposit
 *   - Otherwise: positive amount → deposit, negative → withdrawal
 */
function classify(amountRaw: number, typeRaw: string | null): { type: 'deposit' | 'withdrawal'; amount: number } | null {
  if (!Number.isFinite(amountRaw) || amountRaw === 0) return null;
  const t = (typeRaw ?? '').toLowerCase();
  if (t === 'debit' || t === 'withdrawal') return { type: 'withdrawal', amount: Math.abs(amountRaw) };
  if (t === 'credit' || t === 'deposit') return { type: 'deposit', amount: Math.abs(amountRaw) };
  if (amountRaw > 0) return { type: 'deposit', amount: amountRaw };
  return { type: 'withdrawal', amount: -amountRaw };
}

export async function promoteImport(args: {
  organizationId: string;
  importId: string;
}): Promise<ImportedPromoteResult> {
  const [importRow] = await db
    .select({
      id: imports.id,
      organizationId: imports.organizationId,
      accountId: imports.accountId,
      status: imports.status,
    })
    .from(imports)
    .where(and(eq(imports.id, args.importId), eq(imports.organizationId, args.organizationId)))
    .limit(1);

  if (!importRow) return { promoted: 0, skipped: 0, pendingUnlock: 0, pendingByYear: {}, reason: 'import not found', newTransactionIds: [] };
  if (!importRow.accountId) {
    return { promoted: 0, skipped: 0, pendingUnlock: 0, pendingByYear: {}, reason: 'import has no account mapping', newTransactionIds: [] };
  }

  const rows = await db
    .select({
      id: importedTransactions.id,
      date: importedTransactions.date,
      description: importedTransactions.description,
      amount: importedTransactions.amount,
      type: importedTransactions.type,
      referenceNumber: importedTransactions.referenceNumber,
      merchantName: importedTransactions.merchantName,
      category: importedTransactions.category,
      promotionStatus: importedTransactions.promotionStatus,
      promotedTransactionId: importedTransactions.promotedTransactionId,
    })
    .from(importedTransactions)
    .where(eq(importedTransactions.importId, args.importId));

  if (rows.length === 0) {
    return { promoted: 0, skipped: 0, pendingUnlock: 0, pendingByYear: {}, reason: 'no extracted transactions to promote', newTransactionIds: [] };
  }

  // Idempotency: any row whose reference is already in transactions.reference is skipped.
  const refs = rows.map((r) => `veryfi:${args.importId}:${r.id}`);
  const existing = await db
    .select({ reference: transactions.reference })
    .from(transactions)
    .where(and(eq(transactions.organizationId, args.organizationId), inArray(transactions.reference, refs)));
  const alreadyPromoted = new Set(existing.map((e) => e.reference).filter((x): x is string => !!x));

  // One coverage snapshot per call — every row checks against it, costing
  // 2 small queries instead of 2×N.
  const coverage = await getOrgCoverageWindow(args.organizationId);

  // Cross-source dedup: a bank statement uploaded for a window Plaid already
  // synced would double-post every overlapping charge. Plaid (and QBO) outrank
  // a statement upload, so pre-load the active higher-precedence rows on THIS
  // account within the statement's date range and greedily claim exact same-day
  // twins. A claimed statement row is inserted as a quarantined duplicate (no JE)
  // instead of a live posting. (Different-account overlap — same charge under a
  // differently-labelled account — is handled by the cross-account sweep, not here.)
  const rowDates = rows.map((r) => r.date).filter((d): d is string => !!d);
  const minDate = rowDates.length ? rowDates.reduce((a, b) => (a < b ? a : b)) : null;
  const maxDate = rowDates.length ? rowDates.reduce((a, b) => (a > b ? a : b)) : null;
  let twinIndex = buildTwinIndex([]);
  if (minDate && maxDate) {
    const twinRows = await db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        type: transactions.type,
        amount: transactions.amount,
        date: transactions.date,
        reference: transactions.reference,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.organizationId, args.organizationId),
          eq(transactions.accountId, importRow.accountId),
          eq(transactions.dedupeState, 'active'),
          gte(transactions.date, minDate),
          lte(transactions.date, maxDate),
          sql`(${transactions.reference} like 'plaid:%' or ${transactions.reference} like 'qbo:%')`,
        ),
      );
    twinIndex = buildTwinIndex(twinRows);
  }

  let promoted = 0;
  let skipped = 0;
  let pendingUnlock = 0;
  let dedupedAgainstFeed = 0;
  const pendingByYear: Record<number, number> = {};
  const newTransactionIds: string[] = [];
  const now = new Date().toISOString();

  for (const r of rows) {
    const ref = `veryfi:${args.importId}:${r.id}`;
    if (alreadyPromoted.has(ref) || r.promotedTransactionId) {
      skipped++;
      continue;
    }
    if (!r.date) {
      skipped++;
      continue;
    }
    // Quarantine rows whose date isn't covered. promotion_status stays at
    // its current value so a later run (post-unlock) picks it up.
    const rowDate = new Date(r.date);
    if (!dateIsCovered(rowDate, coverage)) {
      pendingUnlock++;
      const y = rowDate.getUTCFullYear();
      pendingByYear[y] = (pendingByYear[y] ?? 0) + 1;
      continue;
    }
    const cls = classify(Number(r.amount ?? 0), r.type ?? null);
    if (!cls) {
      skipped++;
      continue;
    }

    // Cross-source dedup: this statement line exactly matches (same account, same
    // day, same amount + direction) an existing Plaid/QBO row → the feed is the
    // source of truth, so quarantine this statement copy. Insert it as a
    // dedupe_state='duplicate' row with NO journal entry (never double-posts),
    // linked to the surviving feed row, and skip the AI contact/category work.
    const dupTwin = twinIndex.claim(twinKey(importRow.accountId, cls.type, cls.amount, r.date));
    if (dupTwin) {
      const dupId = randomUUID();
      await db.insert(transactions).values({
        id: dupId,
        organizationId: args.organizationId,
        date: r.date,
        description: r.merchantName ?? r.description ?? null,
        bankDescription: r.description ?? null,
        reference: ref,
        amount: cls.amount,
        type: cls.type,
        accountId: importRow.accountId,
        importId: args.importId,
        reviewed: true,
        dedupeState: 'duplicate',
        duplicateOfId: dupTwin.id,
        userDescription: '[duplicate]',
        createdAt: now,
      });
      await db
        .update(importedTransactions)
        .set({ promotionStatus: 'promoted', promotedTransactionId: dupId, updatedAt: now })
        .where(eq(importedTransactions.id, r.id));
      dedupedAgainstFeed++;
      continue;
    }

    // Step 2.a / 2.a.i — same contact-resolution flow as Plaid promotion.
    //   - Reliable source first: Veryfi's vendor.name (stored as
    //     imported_transactions.merchant_name during the bank-statement import).
    //   - If null, fall through to AI semantic extraction from the bank
    //     description, with semantic matching against existing contacts.
    //   - Internal transfers / fees / interest resolve to null contact_id.
    // No PFC equivalent for Veryfi — pass null and let the AI rely on
    // description heuristics alone.
    const resolved = await resolveContact({
      organizationId: args.organizationId,
      merchantName: r.merchantName ?? null,
      description: r.description ?? null,
      pfcPrimary: null,
      type: cls.type,
    });
    // Step 2.b — Veryfi pre-categorized this row using the CoA names we
    // passed in the request, so the lookup is just an exact-name match
    // against the org's chart. Sentinel "Internal Transfer" + null/unknown
    // categories fall back to uncategorized + reviewed=false.
    const cat = await resolveVeryfiCategory({
      organizationId: args.organizationId,
      category: r.category ?? null,
      type: cls.type,
    });
    const displayDescription =
      resolved.contactName ?? r.merchantName ?? r.description ?? null;
    const newId = randomUUID();
    // Only treat the Veryfi result as the final categorization when
    // source='primary' — i.e. Veryfi's returned label exact-matched one of
    // the org's CoA names. Anything else (sentinel transfer, fallback to
    // Uncategorized, unknown) leaves categoryAccountId NULL and waits for
    // the auto-categorize Inngest job to pick the real account. Pre-staging
    // the Uncategorized fallback used to burn an extra 2 JEs per txn (post
    // → reverse → re-post) when AI replaced it; deferring eliminates that
    // churn. Same pattern as plaid-promote.
    const usePrimary = cat.source === 'primary' && cat.categoryAccountId !== null;
    const stagedCategoryAccountId = usePrimary ? cat.categoryAccountId : null;
    const reviewed = usePrimary && cat.reviewedByDefault;

    await db.insert(transactions).values({
      id: newId,
      organizationId: args.organizationId,
      date: r.date,
      description: displayDescription,
      bankDescription: r.description ?? displayDescription,
      reference: ref,
      amount: cls.amount,
      type: cls.type,
      accountId: importRow.accountId,
      contactId: resolved.contactId,
      categoryAccountId: stagedCategoryAccountId,
      importId: args.importId,
      reviewed,
      createdAt: now,
    });

    await db
      .update(importedTransactions)
      .set({ promotionStatus: 'promoted', promotedTransactionId: newId, updatedAt: now })
      .where(eq(importedTransactions.id, r.id));

    promoted++;
    newTransactionIds.push(newId);

    // Auto-post JE/GL only when Veryfi's category was a primary CoA match.
    // Fallback / sentinel / unknown rows wait for the auto-categorize
    // Inngest job (or a manual categorize) to pick the real account before
    // any JE is created — no JE means no GL impact, no reversal needed
    // when the category is finalized. The stuck-pending-fallback job posts
    // to Uncategorized Expense/Income if categorization doesn't finalize
    // within 15 min, so a row never stays JE-less forever.
    if (usePrimary) {
      try {
        const jeId = await createJournalEntryFromTransaction({
          id: newId,
          organizationId: args.organizationId,
          date: r.date,
          type: cls.type,
          amount: cls.amount,
          accountId: importRow.accountId,
          categoryAccountId: stagedCategoryAccountId!,
          contactId: resolved.contactId,
          bankDescription: r.description ?? null,
          userDescription: null,
        });
        await db.update(transactions).set({ journalEntryId: jeId }).where(eq(transactions.id, newId));
      } catch (err) {
        if (err instanceof JournalEntryError) {
          logger.warn(
            { txnId: newId, orgId: args.organizationId, err: err.message },
            'imported-promote: JE auto-post validation failed; transaction promoted without GL',
          );
        } else {
          logger.error(
            { txnId: newId, orgId: args.organizationId, err: err instanceof Error ? err.message : String(err) },
            'imported-promote: JE auto-post errored; transaction promoted without GL',
          );
        }
      }
    }
  }

  if (dedupedAgainstFeed > 0) {
    logger.info(
      { orgId: args.organizationId, importId: args.importId, dedupedAgainstFeed },
      'imported-promote: quarantined statement duplicates of existing feed rows (feed=truth)',
    );
  }
  return { promoted, skipped, pendingUnlock, pendingByYear, newTransactionIds, dedupedAgainstFeed };
}
