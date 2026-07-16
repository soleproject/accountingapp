import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { plaidAccounts, plaidRawTransactions, transactions } from '@/db/schema/schema';
import { buildTwinIndex, twinKey, quarantineDuplicate } from '@/lib/audit/dedupe';
import { resolveContact } from './resolve-contact-ai';
import { resolvePfcCoa } from './resolve-pfc-coa';
import { exceedsMealAutoApproveCap } from './meal-auto-approve-guard';
import { createJournalEntryFromTransaction, repostTransactionJE } from './auto-post';
import { JournalEntryError } from './posting';
import { logger } from '@/lib/logger';
import { getOrgCoverageWindow, dateIsCovered } from '@/lib/billing/entitlements';

export interface PlaidPromoteResult {
  promoted: number;
  skipped: number;
  /**
   * Rows held back because the org doesn't own the year. These stay in
   * plaid_raw_transactions and will promote on a future run after the
   * matching year-unlock entitlement is granted (the entitlement webhook
   * triggers a re-promote, so this is normally automatic).
   */
  pendingUnlock: number;
  /** Count of pending-unlock rows broken down by year for UI display. */
  pendingByYear: Record<number, number>;
  reason?: string;
  newTransactionIds: string[];
  /** Plaid rows skipped because an existing QBO transaction already covers them
   *  (QBO = source of truth for the migrated window). The raw rows are KEPT in
   *  plaid_raw_transactions, so a wrong skip is recoverable; each skip is logged. */
  dedupedAgainstQbo?: number;
}

interface PlaidRawJson {
  name?: string;
  merchant_name?: string;
  iso_currency_code?: string | null;
  authorized_date?: string | null;
  personal_finance_category?: { primary?: string | null; detailed?: string | null; confidence_level?: string | null } | null;
  /** Plaid marks a charge `pending` before it posts; the POSTED copy (pending=false)
   *  carries the pending copy's id in `pending_transaction_id`. */
  pending?: boolean;
  pending_transaction_id?: string | null;
}

/**
 * Plaid signs amounts: positive means money OUT (withdrawal/expense),
 * negative means money IN (deposit/credit). Our `transactions.type` is
 * 'deposit' | 'withdrawal' with a positive `amount`.
 */
function plaidToOurType(rawAmount: number): { type: 'deposit' | 'withdrawal'; amount: number } {
  if (rawAmount >= 0) return { type: 'withdrawal', amount: rawAmount };
  return { type: 'deposit', amount: -rawAmount };
}

export async function promotePlaidAccount(args: {
  organizationId: string;
  plaidAccountId: string;
}): Promise<PlaidPromoteResult> {
  const [account] = await db
    .select()
    .from(plaidAccounts)
    .where(eq(plaidAccounts.id, args.plaidAccountId))
    .limit(1);
  if (!account) return { promoted: 0, skipped: 0, pendingUnlock: 0, pendingByYear: {}, reason: 'plaid account not found', newTransactionIds: [] };
  if (account.linkedOrganizationId !== args.organizationId) {
    return { promoted: 0, skipped: 0, pendingUnlock: 0, pendingByYear: {}, reason: 'plaid account not linked to this organization', newTransactionIds: [] };
  }
  if (!account.chartOfAccountId) {
    return { promoted: 0, skipped: 0, pendingUnlock: 0, pendingByYear: {}, reason: 'plaid account not yet mapped to a COA bank account', newTransactionIds: [] };
  }

  const raw = await db
    .select({
      id: plaidRawTransactions.id,
      plaidTransactionId: plaidRawTransactions.plaidTransactionId,
      date: plaidRawTransactions.date,
      amount: plaidRawTransactions.amount,
      description: plaidRawTransactions.description,
      rawJson: plaidRawTransactions.rawJson,
    })
    .from(plaidRawTransactions)
    .where(eq(plaidRawTransactions.plaidAccountId, account.id));

  if (raw.length === 0) return { promoted: 0, skipped: 0, pendingUnlock: 0, pendingByYear: {}, reason: 'no raw transactions yet', newTransactionIds: [] };

  // Plaid pending→posted dedup: a POSTED raw row (pending=false) references the
  // pending copy's id in `pending_transaction_id`. Collect those ids so we can
  // (a) skip promoting the pending copy and (b) when the posted row lands, ADOPT
  // an already-promoted pending in place (new ref + fuller description) instead of
  // creating a second transaction for the same charge.
  const supersededPendingIds = new Set<string>();
  for (const r of raw) {
    const j = (r.rawJson ?? {}) as PlaidRawJson;
    if (j.pending === false && j.pending_transaction_id) supersededPendingIds.add(j.pending_transaction_id);
  }

  // ON CONFLICT DO NOTHING on the partial unique index
  // transactions(organization_id, reference) WHERE reference IS NOT NULL
  // (migration 0006) is still the source-of-truth for concurrency safety:
  // two simultaneous promote runs for the same ref can both pass the
  // pre-query below and still collide harmlessly at insert time.
  //
  // The pre-query is a *cost* guard, not a correctness guard. Without it,
  // every retrigger of plaid-promote-on-sync re-runs resolveContact (an AI
  // call) and resolvePfcCoa for rows that will then no-op at insert. That
  // burned ~70k AI calls / ~$70 in one month on a single org. Match the
  // Veryfi importer pattern (imported-promote.ts) and skip already-promoted
  // refs before the AI call.
  const candidateRefs = raw.map((r) => `plaid:${r.plaidTransactionId}`);
  const existing = candidateRefs.length
    ? await db
        .select({ reference: transactions.reference })
        .from(transactions)
        .where(
          and(
            eq(transactions.organizationId, args.organizationId),
            inArray(transactions.reference, candidateRefs),
          ),
        )
    : [];
  const alreadyPromoted = new Set(
    existing.map((e) => e.reference).filter((x): x is string => !!x),
  );

  // Pull the org's coverage window once — every row in the loop checks
  // against the same snapshot, which costs 2 small queries instead of 2×N.
  const coverage = await getOrgCoverageWindow(args.organizationId);

  // QBO-as-truth dedup: if this org migrated QBO, don't re-create a Plaid txn
  // that duplicates an existing QBO one (same type + amount, date within ±1 day).
  // QBO carries the migrated categorization, so it wins for the overlap window.
  // Pre-fetch the org's QBO txns once and greedily claim them (1:1) so one QBO
  // row can't suppress two distinct Plaid rows. A skipped Plaid row STAYS in
  // plaid_raw_transactions (recoverable) and every skip is logged.
  const QBO_DEDUP_WINDOW_MS = 86_400_000; // ±1 day
  const qboRows = await db
    .select({ date: transactions.date, amount: transactions.amount, type: transactions.type })
    .from(transactions)
    .where(and(eq(transactions.organizationId, args.organizationId), sql`${transactions.reference} like 'qbo:%'`));
  const qboTwins = new Map<string, { t: number; used: boolean }[]>();
  for (const q of qboRows) {
    const key = `${q.type}:${Math.abs(Number(q.amount)).toFixed(2)}`;
    (qboTwins.get(key) ?? qboTwins.set(key, []).get(key)!).push({ t: new Date(q.date).getTime(), used: false });
  }

  let promoted = 0;
  let dedupedAgainstQbo = 0;
  let skipped = 0;
  let pendingUnlock = 0;
  const pendingByYear: Record<number, number> = {};
  const newTransactionIds: string[] = [];
  const now = new Date().toISOString();

  for (const r of raw) {
    // Quarantine rows whose date isn't covered. The raw row stays in
    // plaid_raw_transactions; if/when the customer buys the matching year
    // unlock, the entitlement webhook calls this function again and the
    // row will pass this check on the second pass.
    const rowDate = new Date(r.date);
    if (!dateIsCovered(rowDate, coverage)) {
      pendingUnlock++;
      const y = rowDate.getUTCFullYear();
      pendingByYear[y] = (pendingByYear[y] ?? 0) + 1;
      continue;
    }
    const ref = `plaid:${r.plaidTransactionId}`;
    if (alreadyPromoted.has(ref)) {
      skipped++;
      continue;
    }
    const meta = (r.rawJson ?? {}) as PlaidRawJson;
    const isPending = meta.pending === true;
    const pendingTxnId = meta.pending_transaction_id ?? null;
    // The posted copy of this charge is in this same batch → skip the pending copy;
    // the posted row becomes the single transaction.
    if (isPending && supersededPendingIds.has(r.plaidTransactionId)) {
      skipped++;
      continue;
    }
    const rawAmount = Number(r.amount);
    if (!Number.isFinite(rawAmount) || rawAmount === 0) {
      skipped++;
      continue;
    }
    const { type, amount } = plaidToOurType(rawAmount);

    // Plaid pending→posted: if this POSTED row supersedes an ALREADY-PROMOTED
    // pending twin, adopt that transaction in place (new ref + fuller bank
    // description + posted date) instead of creating a duplicate. Keeps its JE,
    // category, contact, review state, and any attached receipt/substantiation.
    if (!isPending && pendingTxnId) {
      const twinRef = `plaid:${pendingTxnId}`;
      const [twin] = await db
        .select({
          id: transactions.id,
          amount: transactions.amount,
          type: transactions.type,
          accountId: transactions.accountId,
          categoryAccountId: transactions.categoryAccountId,
          contactId: transactions.contactId,
          journalEntryId: transactions.journalEntryId,
        })
        .from(transactions)
        .where(and(eq(transactions.organizationId, args.organizationId), eq(transactions.reference, twinRef)))
        .limit(1);
      if (twin) {
        const amountChanged = Math.abs(Number(twin.amount) - amount) > 0.005 || twin.type !== type;
        await db
          .update(transactions)
          .set({
            reference: ref,
            date: r.date,
            ...(r.description ? { bankDescription: r.description } : {}),
            ...(amountChanged ? { amount, type } : {}),
          })
          .where(eq(transactions.id, twin.id));
        // Amount/type changed (e.g. a tip posted) AND it was already on the GL →
        // reverse + repost the JE so the books match the posted amount.
        if (amountChanged && twin.journalEntryId && twin.categoryAccountId && twin.accountId) {
          try {
            await repostTransactionJE({
              txn: {
                id: twin.id,
                organizationId: args.organizationId,
                date: r.date,
                type,
                amount,
                accountId: twin.accountId,
                categoryAccountId: twin.categoryAccountId,
                contactId: twin.contactId,
                bankDescription: r.description ?? null,
                userDescription: null,
              },
              existingJournalEntryId: twin.journalEntryId,
            });
          } catch (err) {
            logger.warn(
              { txnId: twin.id, orgId: args.organizationId, err: err instanceof Error ? err.message : String(err) },
              'plaid-promote: pending→posted JE repost failed',
            );
          }
        }
        logger.info(
          { orgId: args.organizationId, from: twinRef, to: ref },
          'plaid-promote: adopted pending→posted in place (no duplicate)',
        );
        continue;
      }
      // Twin not promoted (pending never landed, or already cleaned) → create the
      // posted row normally below.
    }
    // QBO-as-truth: skip (don't promote) if this Plaid txn duplicates an existing
    // QBO one. Cheap check BEFORE the AI resolveContact call. Greedy nearest-date
    // within ±1 day; claimed QBO rows can't be reused for another Plaid row.
    if (qboTwins.size > 0) {
      const cands = qboTwins.get(`${type}:${Math.abs(amount).toFixed(2)}`);
      if (cands) {
        const rt = new Date(r.date).getTime();
        let best = -1;
        let bestDist = Infinity;
        for (let i = 0; i < cands.length; i++) {
          if (cands[i].used) continue;
          const d = Math.abs(cands[i].t - rt);
          if (d <= QBO_DEDUP_WINDOW_MS && d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
        if (best >= 0) {
          cands[best].used = true;
          dedupedAgainstQbo++;
          logger.info(
            { orgId: args.organizationId, ref: `plaid:${r.plaidTransactionId}`, type, amount, date: r.date },
            'plaid-promote: skipped QBO duplicate (QBO=truth)',
          );
          continue;
        }
      }
    }
    // Pipeline step 2.a / 2.a.i: contact = merchant_name when present;
    // otherwise AI-semantic extract+match against existing contacts using the
    // bank description (Plaid's `name` field). Internal transfers, fees, and
    // interest deliberately resolve to a null contact_id.
    const resolved = await resolveContact({
      organizationId: args.organizationId,
      merchantName: meta.merchant_name ?? null,
      description: meta.name ?? r.description ?? null,
      pfcPrimary: meta.personal_finance_category?.primary ?? null,
      type,
    });
    // Pipeline step 2.b: pre-categorize from Plaid PFCv2 detailed code via the
    // canonical PFC → CoA mapping. Confidently-classified rows (business
    // income/expense, personal, liability paydown/increase) auto-mark
    // reviewed=true; transfers and uncategorized stay reviewed=false so the
    // client sees them in the review queue. If contact resolution failed
    // outright, force reviewed=false too — a row with no contact AND no PFC
    // signal isn't trustworthy enough to skip the review pass.
    const pfc = await resolvePfcCoa({
      organizationId: args.organizationId,
      pfcDetailed: meta.personal_finance_category?.detailed ?? null,
      bankAccountId: account.chartOfAccountId,
    });
    // Treat the PFC result as the final categorization when source is
    // either 'primary' (org's CoA has the slot the PFC mapping points to)
    // or 'override' (an explicit pfc_org_overrides row, written by the
    // QBO finalize AI mapper). Anything else (uncategorized fallback or
    // unmapped) leaves categoryAccountId NULL so the auto-categorize
    // Inngest job can pick a real account later — pre-staging an
    // uncategorized fallback used to burn an extra 2 JEs per txn (post →
    // reverse → re-post) when AI replaced it.
    // Guard: a PFC slot/override that resolves to THIS bank account (common for
    // transfer codes whose contra-account slot matches the account itself) would
    // produce a self-cancelling JE. Treat it as unresolved → leave the category
    // null so auto-categorize picks a real counter account.
    const selfReferential = pfc?.categoryAccountId === account.chartOfAccountId;
    const useResolved =
      (pfc?.source === 'primary' || pfc?.source === 'override') && pfc.categoryAccountId !== null && !selfReferential;
    const stagedCategoryAccountId = useResolved ? pfc!.categoryAccountId : null;
    // Amount gate: a meal categorization above the cap is the classic Plaid
    // FOOD_AND_DRINK mis-tag on a large supplier/inventory payment. Still post
    // the JE (useResolved is unchanged, so it hits the GL), but DON'T
    // auto-confirm — force it into the review queue. Pure arithmetic, no
    // extra query or AI call.
    const reviewed =
      useResolved &&
      pfc!.reviewedByDefault &&
      !exceedsMealAutoApproveCap(pfc!.mapping.detailType, amount);
    // The on-screen description: prefer the resolved/canonical merchant name
    // when we have one; otherwise the bank description. Never fall back to a
    // null — `description` is non-null in practice on every reviewed row.
    const displayDescription =
      resolved.contactName ?? meta.merchant_name ?? meta.name ?? r.description ?? null;
    const newId = randomUUID();

    const inserted = await db
      .insert(transactions)
      .values({
        id: newId,
        organizationId: args.organizationId,
        date: r.date,
        description: displayDescription,
        bankDescription: r.description ?? displayDescription,
        reference: ref,
        amount,
        type,
        accountId: account.chartOfAccountId,
        contactId: resolved.contactId,
        categoryAccountId: stagedCategoryAccountId,
        reviewed,
        createdAt: now,
      })
      .onConflictDoNothing({
        target: [transactions.organizationId, transactions.reference],
        where: sql`${transactions.reference} IS NOT NULL`,
      })
      .returning({ id: transactions.id });

    if (inserted.length > 0) {
      promoted++;
      newTransactionIds.push(newId);

      // Pipeline step 3: auto-post JE + GL only when the PFC resolution hit
      // the org's primary CoA slot. Fallback / unmapped rows wait for the
      // auto-categorize Inngest job (or a manual categorize) to pick the
      // real account before any JE is created — no JE means no GL impact,
      // no reversal needed when the category is finalized. The
      // stuck-pending fallback job posts to 5999 if categorization doesn't
      // finalize within 15 min, so a row never stays JE-less forever.
      if (useResolved) {
        try {
          const jeId = await createJournalEntryFromTransaction({
            id: newId,
            organizationId: args.organizationId,
            date: r.date,
            type,
            amount,
            accountId: account.chartOfAccountId,
            categoryAccountId: stagedCategoryAccountId!,
            contactId: resolved.contactId,
            bankDescription: r.description ?? null,
            userDescription: null,
          });
          await db
            .update(transactions)
            .set({ journalEntryId: jeId })
            .where(eq(transactions.id, newId));
        } catch (err) {
          // Don't let JE failures abort the promote — the txn is in the books,
          // it just won't be on the GL until someone fixes/recategorizes it.
          // JournalEntryError covers expected validation failures (account not
          // in org, etc.); other errors get logged with full context.
          if (err instanceof JournalEntryError) {
            logger.warn(
              { txnId: newId, orgId: args.organizationId, err: err.message },
              'plaid-promote: JE auto-post validation failed; transaction promoted without GL',
            );
          } else {
            logger.error(
              { txnId: newId, orgId: args.organizationId, err: err instanceof Error ? err.message : String(err) },
              'plaid-promote: JE auto-post errored; transaction promoted without GL',
            );
          }
        }
      }
    } else {
      skipped++;
    }
  }

  // Cross-source dedup (feed = truth over statement / CSV): a bank statement or
  // CSV may have already promoted these charges before Plaid synced. Plaid
  // outranks both, so the freshly-promoted Plaid rows WIN — demote any existing
  // active `veryfi:`/`csv:` twin on the same account + same day + exact amount
  // into the Removed-duplicates bucket (reverses its JE, nets GL to zero).
  // Greedy 1:1. (Different-account overlap is left to the cross-account sweep.)
  let demotedStatementDupes = 0;
  if (newTransactionIds.length > 0) {
    try {
      const newRows = await db
        .select({
          id: transactions.id,
          accountId: transactions.accountId,
          type: transactions.type,
          amount: transactions.amount,
          date: transactions.date,
        })
        .from(transactions)
        .where(inArray(transactions.id, newTransactionIds));
      const dates = newRows.map((r) => r.date).filter((d): d is string => !!d);
      if (dates.length) {
        const minDate = dates.reduce((a, b) => (a < b ? a : b));
        const maxDate = dates.reduce((a, b) => (a > b ? a : b));
        const loserRows = await db
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
              eq(transactions.accountId, account.chartOfAccountId),
              eq(transactions.dedupeState, 'active'),
              gte(transactions.date, minDate),
              lte(transactions.date, maxDate),
              sql`(${transactions.reference} like 'veryfi:%' or ${transactions.reference} like 'csv:%')`,
            ),
          );
        const loserIndex = buildTwinIndex(loserRows);
        for (const nr of newRows) {
          const twin = loserIndex.claim(
            twinKey(nr.accountId, nr.type, nr.amount == null ? null : Number(nr.amount), nr.date),
          );
          if (twin) {
            const done = await quarantineDuplicate({
              organizationId: args.organizationId,
              loserId: twin.id,
              survivorId: nr.id,
            });
            if (done) demotedStatementDupes++;
          }
        }
      }
    } catch (err) {
      logger.error(
        { orgId: args.organizationId, err: err instanceof Error ? err.message : String(err) },
        'plaid-promote: statement-dup demotion failed (non-fatal)',
      );
    }
  }
  if (demotedStatementDupes > 0) {
    logger.info(
      { orgId: args.organizationId, demotedStatementDupes },
      'plaid-promote: demoted statement/CSV duplicates in favor of Plaid (feed=truth)',
    );
  }

  // After every promoted txn is inserted, check for exact-match draft
  // receipts (amount + date). Best-effort — Plaid sync is a high-
  // volume flow and matcher failure must not break the import.
  if (newTransactionIds.length > 0) {
    try {
      const { findReceiptMatchesForTransaction } = await import('@/lib/receipts/find-receipt-matches-for-transaction');
      for (const txnId of newTransactionIds) {
        try {
          await findReceiptMatchesForTransaction({
            organizationId: args.organizationId,
            transactionId: txnId,
          });
        } catch (err) {
          logger.error(
            { txnId, err: err instanceof Error ? err.message : String(err) },
            'plaid-promote: receipt-match check failed (non-fatal)',
          );
        }
      }
    } catch {
      // import error itself — ignore
    }
  }

  // Duplicate detection for the freshly promoted rows. Best-effort and
  // flag-only: writes book_review_findings, never blocks the import. The
  // (org, reference) unique index already stops same-Plaid-id re-imports;
  // this catches cross-source dupes (a manual entry doubling a Plaid txn,
  // an overlapping CSV import, the same charge from two linked accounts).
  if (newTransactionIds.length > 0) {
    try {
      const [{ detectDuplicates }, { writeFindings }] = await Promise.all([
        import('@/lib/audit/duplicates'),
        import('@/lib/audit/findings'),
      ]);
      const rows = await db
        .select({
          id: transactions.id,
          date: transactions.date,
          amount: transactions.amount,
          type: transactions.type,
          contactId: transactions.contactId,
          description: transactions.description,
        })
        .from(transactions)
        .where(inArray(transactions.id, newTransactionIds));
      const findings = [];
      for (const row of rows) {
        findings.push(...(await detectDuplicates(args.organizationId, row)));
      }
      if (findings.length > 0) await writeFindings(args.organizationId, findings);
    } catch (err) {
      logger.error(
        { orgId: args.organizationId, err: err instanceof Error ? err.message : String(err) },
        'plaid-promote: duplicate detection failed (non-fatal)',
      );
    }
  }

  if (dedupedAgainstQbo > 0) {
    logger.info(
      { orgId: args.organizationId, dedupedAgainstQbo },
      'plaid-promote: suppressed Plaid duplicates of existing QBO transactions',
    );
  }
  return { promoted, skipped, pendingUnlock, pendingByYear, newTransactionIds, dedupedAgainstQbo };
}
