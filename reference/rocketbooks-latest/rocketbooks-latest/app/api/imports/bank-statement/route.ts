import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { imports, importedTransactions, chartOfAccounts } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import {
  processBankStatementSync,
  normalizeTransactions,
  VeryfiError,
  type VeryfiBankStatement,
} from '@/lib/veryfi/bank-statement';
import { resolveStatementCoa } from '@/lib/accounting/resolve-statement-coa';
import { promoteImport } from '@/lib/accounting/imported-promote';
import { setAccountOpeningBalance } from '@/lib/accounting/opening-balance';
import { enumerateAccountMonths, accountHasReconciliationPeriods } from '@/lib/reconciliation/backfill';
import { safeSend } from '@/lib/inngest';
import { logger } from '@/lib/logger';
import { assertDemoQuota, DemoQuotaExceededError } from '@/lib/billing/demo-limits';

/**
 * Sentinel category names included alongside the org's CoA names. Veryfi
 * picks the closest match per transaction; these handle the case where the
 * line item doesn't fit any expense/income bucket cleanly. Resolved at
 * promote time — "Internal Transfer" → reviewed=false with no category;
 * "Uncategorized" maps to the seeded uncategorized_expense/income slot.
 */
const VERYFI_CATEGORY_SENTINELS = ['Internal Transfer'] as const;

export const runtime = 'nodejs';
export const maxDuration = 120;

const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const sessionUser = await requireSession();
  const orgId = await getCurrentOrgId();

  const form = await req.formData();
  const file = form.get('file');
  const accountIdInput = String(form.get('accountId') ?? '').trim();

  if (!(file instanceof File)) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: 'Empty file' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'File too large (max 25 MB)' }, { status: 400 });

  // Demo trial cap. Done before the Veryfi roundtrip so a quota-exceeded
  // upload doesn't waste an OCR call (and the user's wait).
  try {
    await assertDemoQuota(orgId, 'bankStatementPdfs');
  } catch (err) {
    if (err instanceof DemoQuotaExceededError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
    }
    throw err;
  }

  // accountId is optional — if not supplied, we resolve/create a COA from the
  // Veryfi metadata after extraction.
  if (accountIdInput) {
    const [acct] = await db
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.id, accountIdInput)))
      .limit(1);
    if (!acct) return NextResponse.json({ error: 'Account not in this organization' }, { status: 400 });
  }

  // We need a COA accountId on the imports row (NOT NULL). If the client
  // didn't pre-pick one, we'll resolve from Veryfi metadata after extraction.
  // Until then, use a placeholder that we update post-Veryfi.
  // To avoid a chicken-and-egg with the FK, only create the imports row
  // AFTER we know which COA to use.
  const now = new Date().toISOString();
  const importId = randomUUID();

  // Build the categories list to pass to Veryfi. Include income/expense/
  // equity/liability accounts (legitimate categorization targets), plus
  // sentinels for transfers. Asset accounts are excluded — bank/savings/AR
  // are the SOURCE side of statement lines, not where they categorize to.
  const categoryRows = await db
    .select({ accountName: chartOfAccounts.accountName })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.organizationId, orgId),
        eq(chartOfAccounts.isActive, true),
        inArray(chartOfAccounts.gaapType, ['income', 'expense', 'equity', 'liability']),
      ),
    );
  const categoryList = [
    ...categoryRows.map((r) => r.accountName),
    ...VERYFI_CATEGORY_SENTINELS,
  ];

  let doc: VeryfiBankStatement;
  let resolvedAccountId = accountIdInput;
  let coaInfo: { matched: boolean; accountName: string } | null = null;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    doc = await processBankStatementSync(buffer, file.name, {
      timeoutMs: 110_000,
      categories: categoryList,
    });

    if (!resolvedAccountId) {
      const resolution = await resolveStatementCoa({ organizationId: orgId, doc });
      resolvedAccountId = resolution.chartOfAccountId;
      coaInfo = { matched: resolution.matched, accountName: resolution.accountName };
    }
  } catch (err) {
    const msg = err instanceof VeryfiError ? err.message : err instanceof Error ? err.message : 'Veryfi failed';
    logger.error({ err: msg }, 'veryfi bank statement processing failed');
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  const normalized = normalizeTransactions(doc);
  const dates = normalized.map((t) => t.date).filter((x): x is string => !!x).sort();
  const periodStart = doc.period_start_date ?? dates[0] ?? null;
  const periodEnd = doc.period_end_date ?? doc.statement_date ?? dates[dates.length - 1] ?? null;

  // Wrap the imports row + every imported_transactions row in a single
  // transaction. Mid-loop failures previously left imports.status='processing'
  // forever and the detail page would say "Still processing on Veryfi…".
  try {
    await db.transaction(async (tx) => {
      await tx.insert(imports).values({
        id: importId,
        organizationId: orgId,
        accountId: resolvedAccountId,
        method: 'veryfi',
        importMethod: 'bank_statement',
        filename: file.name,
        status: 'completed',
        transactionCount: normalized.length,
        startDate: periodStart,
        endDate: periodEnd,
        savedFilePath: doc.id ? `veryfi:${doc.id}` : null,
        veryfiDocumentId: doc.id ? String(doc.id) : null,
        veryfiRawJson: JSON.stringify(doc),
        createdAt: now,
      });

      const insertedAt = new Date().toISOString();
      for (const t of normalized) {
        await tx.insert(importedTransactions).values({
          id: randomUUID(),
          importId,
          organizationId: orgId,
          source: 'veryfi',
          accountId: resolvedAccountId,
          date: t.date,
          description: t.description,
          amount: String(t.amount),
          type: t.type,
          balance: t.balance ?? null,
          referenceNumber: t.reference,
          merchantName: t.vendorName,
          category: t.category,
          rawRow: t as unknown as object,
          status: 'pending',
          createdAt: insertedAt,
          updatedAt: insertedAt,
        });
      }
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), importId },
      'failed to persist veryfi bank-statement import',
    );
    return NextResponse.json(
      { error: 'Could not save the imported transactions. Please try again.' },
      { status: 500 },
    );
  }

  logger.info(
    { importId, veryfiId: doc.id, count: normalized.length, bank: doc.bank_name },
    'veryfi bank statement processed',
  );

  // Auto-promote: skip the manual "Promote" step and run the promotion
  // pipeline immediately. The pipeline (resolveContact → resolveVeryfiCategory
  // → JE auto-post) is idempotent — re-running it later via the manual
  // Promote button on /imports/[id] is a no-op for already-promoted rows
  // (skipped by the alreadyPromoted check in promoteImport). So the manual
  // path stays available as a recovery mechanism.
  let autoPromoted = 0;
  let autoSkipped = 0;
  let newTransactionIds: string[] = [];
  try {
    const result = await promoteImport({ organizationId: orgId, importId });
    autoPromoted = result.promoted;
    autoSkipped = result.skipped;
    newTransactionIds = result.newTransactionIds;
    logger.info(
      { importId, promoted: autoPromoted, skipped: autoSkipped },
      'veryfi bank statement auto-promoted',
    );
  } catch (err) {
    // Don't fail the upload if promote errors — the rows are in
    // imported_transactions and the user can still hit Promote manually.
    logger.error(
      { importId, err: err instanceof Error ? err.message : String(err) },
      'veryfi auto-promote failed; rows remain in imported_transactions',
    );
  }

  // Fire AI auto-categorize so any rows that landed on the Uncategorized
  // fallback (because Veryfi didn't return a category and our resolver fell
  // back) get an AI categorization pass right after promote, same as the
  // manual flow does in promoteImportAction.
  if (newTransactionIds.length > 0) {
    await safeSend({
      name: 'transactions/auto-categorize.requested',
      data: { organizationId: orgId, transactionIds: newTransactionIds },
    });
  }

  // Opening balance: a statement's starting_balance is the account's balance
  // going into the period. If this is the EARLIEST statement we've seen for the
  // account, record it as the opening balance (posts a one-time JE to Opening
  // Balance Equity) so the ledger isn't off by the pre-history balance — the
  // reconciliation below then sees a correct opening. Dated the day before the
  // period start so it counts as opening, not period activity.
  const openingAmt =
    doc.starting_balance ?? doc.accounts?.find((a) => a.starting_balance != null)?.starting_balance ?? null;
  if (openingAmt != null && periodStart) {
    try {
      const [acct] = await db
        .select({
          startingBalanceDate: chartOfAccounts.startingBalanceDate,
          normalBalance: chartOfAccounts.normalBalance,
        })
        .from(chartOfAccounts)
        .where(and(eq(chartOfAccounts.id, resolvedAccountId), eq(chartOfAccounts.organizationId, orgId)))
        .limit(1);
      if (!acct?.startingBalanceDate || periodStart < acct.startingBalanceDate) {
        const dayBefore = new Date(Date.parse(`${periodStart}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
        // setAccountOpeningBalance wants the amount in the account's NATURAL sign
        // (positive = normal side). For a credit card (credit-normal) the
        // statement's starting balance is "owed" → present it owed-positive, the
        // same way the reconciliation source normalizes it.
        const rawOpening = Number(openingAmt);
        const amount = acct?.normalBalance === 'credit' ? Math.abs(rawOpening) : rawOpening;
        await setAccountOpeningBalance({
          organizationId: orgId,
          accountId: resolvedAccountId,
          amount,
          asOfDate: dayBefore,
          source: 'statement',
        });
      }
    } catch (err) {
      logger.error(
        { importId, err: err instanceof Error ? err.message : String(err) },
        'failed to set opening balance from statement',
      );
    }
  }

  // AI reconciliation. Always reconcile the statement's own month (a task is
  // created if it doesn't balance). On the FIRST statement for this account
  // (no periods yet), also backfill every other month from first activity → now
  // so the account is reconciled all the way up — those run silently
  // ('backfill'), surfacing only via the reconciliation-off attention card.
  if (periodEnd) {
    const d = new Date(periodEnd);
    const stmtYear = d.getUTCFullYear();
    const stmtMonth = d.getUTCMonth() + 1;
    try {
      const hasPeriods = await accountHasReconciliationPeriods(orgId, resolvedAccountId);
      const months = hasPeriods
        ? [{ year: stmtYear, month: stmtMonth }]
        : await enumerateAccountMonths(orgId, resolvedAccountId);
      // Ensure the statement's own month is included even if it's outside the
      // ledger-derived range (e.g. an empty ledger edge case).
      if (!months.some((m) => m.year === stmtYear && m.month === stmtMonth)) {
        months.push({ year: stmtYear, month: stmtMonth });
      }
      for (const m of months) {
        const isStmtMonth = m.year === stmtYear && m.month === stmtMonth;
        await safeSend({
          name: 'reconciliation/run.requested',
          data: {
            organizationId: orgId,
            accountId: resolvedAccountId,
            year: m.year,
            month: m.month,
            triggeredBy: isStmtMonth ? 'statement-upload' : 'backfill',
            userId: sessionUser.id,
          },
        });
      }
    } catch (err) {
      logger.error(
        { importId, err: err instanceof Error ? err.message : String(err) },
        'failed to dispatch reconciliation runs',
      );
    }
  }

  return NextResponse.json({
    importId,
    status: 'completed',
    transactionCount: normalized.length,
    bank: doc.bank_name,
    period: periodStart && periodEnd ? `${periodStart} → ${periodEnd}` : null,
    coaResolved: coaInfo
      ? { matched: coaInfo.matched, accountName: coaInfo.accountName, accountId: resolvedAccountId }
      : null,
    promote: { promoted: autoPromoted, skipped: autoSkipped },
  });
}
