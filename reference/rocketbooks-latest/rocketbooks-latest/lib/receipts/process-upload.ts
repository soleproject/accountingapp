import 'server-only';
import { randomUUID } from 'crypto';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { receipts, receiptLines, receiptMatchSuggestions } from '@/db/schema/schema';
import { veryfiProcessDocument, VeryfiError } from '@/lib/veryfi/client';
import { recordServiceUsage } from '@/lib/ai/usage';
import { suggestLineAccounts } from '@/lib/receipts/suggest-line-accounts';
import { findTransactionMatches } from '@/lib/receipts/find-transaction-matches';
import { applyReceiptMatch, ApplyMatchError } from '@/lib/receipts/apply-match';
import { resolveVendorContact } from '@/lib/receipts/resolve-vendor-contact';
import { assertDemoQuota } from '@/lib/billing/demo-limits';
import { logger } from '@/lib/logger';

const AUTO_APPLY_MIN_CONFIDENCE = 0.9;

export interface ProcessedReceipt {
  id: string;
  vendorName: string | null;
  total: number | null;
  date: string | null;
  lineCount: number;
}

/**
 * Shared receipt upload pipeline: run OCR, persist the parent receipt
 * row + its line items, ask AI to suggest a CoA account per line.
 *
 * Called from both the /receipts inline form (server action) and the
 * /api/receipts/upload JSON endpoint (multi-file uploads). Keeping this
 * in one place is critical — the API route silently fell behind the
 * server action once already and lost the line-item insert.
 *
 * Throws VeryfiError on OCR failure; callers translate that to a
 * user-visible 502.
 */
export async function processReceiptUpload(
  orgId: string,
  file: { arrayBuffer: () => Promise<ArrayBuffer>; name: string },
): Promise<ProcessedReceipt> {
  // Demo trial cap: reject BEFORE the Veryfi call so quota-exceeded
  // uploads don't burn an OCR credit. Throws DemoQuotaExceededError;
  // callers translate to a 403.
  await assertDemoQuota(orgId, 'receipts');

  const buffer = Buffer.from(await file.arrayBuffer());
  const veryfiResult = await veryfiProcessDocument(buffer, file.name);

  // One billable OCR document. Logged after a successful parse (a thrown
  // VeryfiError above means Veryfi didn't charge us, so nothing to record).
  recordServiceUsage(
    { userId: null, orgId, actor: 'system', feature: 'receipt-ocr' },
    { provider: 'veryfi', category: 'ocr', unit: 'documents', quantity: 1, rateKey: 'veryfi:document', model: String(veryfiResult.id) },
  );

  // Resolve Veryfi's vendor.name → a contacts row:
  //   1. normalized exact match (case + corp-suffix tolerant)
  //   2. AI fuzzy match against existing contacts ("WinCo Foods" ↔ "WinCo")
  //   3. auto-create a vendor contact when neither matches
  // Falls back to contactId=null only when Veryfi gave us no name at all.
  const vendorName = veryfiResult.vendor?.name?.trim() || null;
  const resolved = await resolveVendorContact({ organizationId: orgId, vendorName });
  const contactId = resolved.contactId;

  const id = randomUUID();
  await db.insert(receipts).values({
    id,
    organizationId: orgId,
    contactId,
    receiptDate: veryfiResult.date ?? new Date().toISOString().slice(0, 10),
    totalAmount: veryfiResult.total ?? 0,
    memo: veryfiResult.notes ?? veryfiResult.category ?? null,
    status: 'draft',
    posted: false,
    veryfiDocumentId: String(veryfiResult.id),
    veryfiRawJson: JSON.stringify(veryfiResult),
    rawText: veryfiResult.ocr_text ?? null,
    vendorMetadata: vendorName ? JSON.stringify({ veryfi_vendor: vendorName }) : null,
    vendorLogoUrl: veryfiResult.vendor?.logo ?? null,
  });

  const veryfiLines = (veryfiResult.line_items ?? []).filter(
    (li): li is { description: string; total: number } =>
      typeof li.description === 'string' && typeof li.total === 'number',
  );
  let lineCount = 0;
  if (veryfiLines.length > 0) {
    const suggestions = await suggestLineAccounts(
      orgId,
      vendorName,
      veryfiLines.map((li) => ({ description: li.description, amount: li.total })),
    );
    const lineRows = veryfiLines.map((li, i) => ({
      id: randomUUID(),
      receiptId: id,
      description: li.description,
      quantity: 1,
      unitPrice: li.total,
      amount: li.total,
      expenseAccountId: null,
      suggestedAccountId: suggestions[i]?.accountId ?? null,
      categoryGuess: veryfiResult.category ?? null,
      itemName: null,
    }));
    await db.insert(receiptLines).values(lineRows);
    lineCount = lineRows.length;
  }

  logger.info(
    { receiptId: id, veryfiId: veryfiResult.id, total: veryfiResult.total, lines: lineCount },
    'receipt uploaded + extracted',
  );

  // Best-effort transaction match search. Phase 1: persist suggestions
  // only — UI surfaces them later. Failures here MUST NOT fail the
  // upload itself; matching is a nice-to-have on top of the receipt
  // being saved. Most common failure mode is no transactions at all
  // in the window (returns 0 — not an error).
  try {
    await findTransactionMatches({
      id,
      organizationId: orgId,
      totalAmount: veryfiResult.total ?? 0,
      receiptDate: veryfiResult.date ?? new Date().toISOString().slice(0, 10),
      contactId,
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), receiptId: id },
      'findTransactionMatches failed (non-fatal)',
    );
  }

  // Phase 3 auto-apply: if the matcher found a top suggestion with
  // confidence ≥ 0.9 AND an exact amount match, apply it automatically.
  // Mismatched amounts (tip-included transactions etc.) stay as
  // suggestions for manual review. Apply failures swallow — the
  // suggestion remains pending so the user can review on /ai-chat.
  try {
    const [top] = await db
      .select({
        id: receiptMatchSuggestions.id,
        confidence: receiptMatchSuggestions.confidence,
        amountDiff: receiptMatchSuggestions.amountDiff,
      })
      .from(receiptMatchSuggestions)
      .where(
        and(
          eq(receiptMatchSuggestions.receiptId, id),
          eq(receiptMatchSuggestions.status, 'pending'),
        ),
      )
      .orderBy(desc(receiptMatchSuggestions.confidence))
      .limit(1);
    if (top && Number(top.confidence) >= AUTO_APPLY_MIN_CONFIDENCE && Number(top.amountDiff) === 0) {
      const result = await applyReceiptMatch({ organizationId: orgId, suggestionId: top.id });
      logger.info({ receiptId: id, applicationId: result.applicationId }, 'receipt auto-applied to transaction');
    }
  } catch (err) {
    // ApplyMatchError = validation/data issue (missing source account, line/txn amount mismatch, etc).
    // Swallow either way: the suggestion is still pending and the user can review manually.
    const expected = err instanceof ApplyMatchError;
    logger.error(
      { err: err instanceof Error ? err.message : String(err), receiptId: id, expected },
      'auto-apply failed (non-fatal — suggestion remains pending)',
    );
  }

  return {
    id,
    vendorName,
    total: veryfiResult.total ?? null,
    date: veryfiResult.date ?? null,
    lineCount,
  };
}

export { VeryfiError };
