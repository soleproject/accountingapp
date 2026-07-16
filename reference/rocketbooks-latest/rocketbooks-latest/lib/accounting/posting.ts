import 'server-only';
import { randomUUID } from 'crypto';
import { eq, inArray, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts, journalEntries, journalEntryLines, generalLedger, trustReviewFindings } from '@/db/schema/schema';
import { evaluateBeneficialTrustJournalEntry } from './rules/beneficial-trust';
import { assertPeriodOpen } from './period-close';
import { logger } from '@/lib/logger';

export interface JournalEntryLineInput {
  accountId: string;
  debit?: number | string;
  credit?: number | string;
  memo?: string | null;
  contactId?: string | null;
  /** Per-line beneficiary tag (Phase 4d) — for postings to 815/820/310/635
   *  where the rules engine needs to know WHICH beneficiary the line is for. */
  beneficiaryId?: string | null;
}

export interface CreateJournalEntryInput {
  organizationId: string;
  date: string;
  memo?: string | null;
  lines: JournalEntryLineInput[];
  posted?: boolean;
  sourceType?: string | null;
  sourceId?: string | null;
  /** Mark as an adjusting entry (year-end accruals, depreciation, reclasses). */
  isAdjusting?: boolean;
}

export class JournalEntryError extends Error {}

// Drizzle's tx callback param doesn't have a clean exported type, so we infer.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function validateLines(lines: JournalEntryLineInput[]): { totalDebits: number; totalCredits: number } {
  if (!lines.length) throw new JournalEntryError('Journal entry must reference at least one account');

  let totalDebits = 0;
  let totalCredits = 0;
  let hasDebit = false;
  let hasCredit = false;

  for (const line of lines) {
    const debit = Number(line.debit ?? 0);
    const credit = Number(line.credit ?? 0);

    if (!Number.isFinite(debit) || !Number.isFinite(credit)) {
      throw new JournalEntryError('Debit and credit must be valid numbers');
    }
    if (debit < 0 || credit < 0) throw new JournalEntryError('Debits and credits must be non-negative');
    if (debit > 0 && credit > 0) throw new JournalEntryError('A line cannot have both debit and credit > 0');
    if (debit === 0 && credit === 0) throw new JournalEntryError('Lines with both debit and credit = 0 are not allowed');
    if (!line.accountId) throw new JournalEntryError('Each line must reference an account');

    if (debit > 0) hasDebit = true;
    if (credit > 0) hasCredit = true;
    totalDebits += debit;
    totalCredits += credit;
  }

  if (!hasDebit || !hasCredit) {
    throw new JournalEntryError('Journal entry must have at least one debit and one credit line');
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  if (round2(totalDebits) !== round2(totalCredits)) {
    throw new JournalEntryError(
      `Debits (${totalDebits.toFixed(2)}) must equal credits (${totalCredits.toFixed(2)})`,
    );
  }

  return { totalDebits, totalCredits };
}

async function assertAccountsBelongToOrg(
  organizationId: string,
  accountIds: string[],
  client: Tx | typeof db = db,
) {
  if (!accountIds.length) return;
  const unique = Array.from(new Set(accountIds));
  const found = await client
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, organizationId), inArray(chartOfAccounts.id, unique)));
  const foundIds = new Set(found.map((r) => r.id));
  const missing = unique.filter((id) => !foundIds.has(id));
  if (missing.length) {
    throw new JournalEntryError(`Accounts do not belong to this organization: ${missing.join(', ')}`);
  }
}

export interface JournalEntryResult {
  id: string;
  organizationId: string;
  date: string;
  memo: string | null;
  posted: boolean;
  createdAt: string;
  lines: { id: string; accountId: string; debit: number; credit: number; memo: string | null; contactId: string | null }[];
}

/**
 * Creates a journal entry. If `tx` is supplied the work runs inside the
 * caller's transaction so the JE and the source row (bill/invoice/payment)
 * commit atomically. Without `tx`, opens its own transaction.
 *
 * Only inserts general_ledger rows when `posted=true`. Drafts live as JE +
 * lines without GL impact; promoting a draft to posted later inserts the GL
 * rows.
 */
export async function createJournalEntry(
  input: CreateJournalEntryInput,
  tx?: Tx,
): Promise<JournalEntryResult> {
  validateLines(input.lines);

  if (tx) {
    return runInsertJournalEntry(input, tx);
  }
  return await db.transaction(async (innerTx) => runInsertJournalEntry(input, innerTx));
}

async function runInsertJournalEntry(input: CreateJournalEntryInput, tx: Tx): Promise<JournalEntryResult> {
  // Month-end close: refuse posting dated in a closed period (no-op unless the
  // org has explicitly closed that month).
  await assertPeriodOpen(input.organizationId, input.date, tx);

  await assertAccountsBelongToOrg(
    input.organizationId,
    input.lines.map((l) => l.accountId),
    tx,
  );

  // Beneficial-trust rules engine: validates and/or warns based on the org's
  // enabled feature packs. Early-returns empty if the org doesn't have the
  // pack enabled, so this is safe to call on every JE-creation regardless of
  // org type or source path (auto-post, QBO promote/mirror, receipt match,
  // etc.). Blocked findings throw a JournalEntryError; warnings get logged
  // and appended to the JE memo so they're visible on the GL. See lib/
  // accounting/rules/beneficial-trust/ for the rule set.
  const trustEval = await evaluateBeneficialTrustJournalEntry({
    organizationId: input.organizationId,
    date: input.date,
    memo: input.memo ?? null,
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    lines: input.lines.map((l) => ({
      accountId: l.accountId,
      debit: Number(l.debit ?? 0),
      credit: Number(l.credit ?? 0),
      contactId: l.contactId ?? null,
      memo: l.memo ?? null,
      beneficiaryId: l.beneficiaryId ?? null,
    })),
  });
  if (trustEval.blocked) {
    throw new JournalEntryError(`Beneficial-trust rules blocked posting: ${trustEval.blockMessage}`);
  }
  if (trustEval.findings.length > 0) {
    logger.warn(
      {
        orgId: input.organizationId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        findings: trustEval.findings.map((f) => ({ code: f.code, severity: f.severity })),
      },
      'beneficial-trust rules produced findings',
    );
  }
  const memoBase = input.memo ?? null;
  // Short marker only — full finding details persist in trust_review_findings
  // and surface in the Trust Review queue UI. Keeps the GL memo readable.
  const memoForJournalEntry = trustEval.findings.length > 0
    ? `${memoBase ?? 'Journal entry'} · [trust review needed]`
    : memoBase;

  const jeId = randomUUID();
  const now = new Date().toISOString();
  const posted = input.posted ?? true;

  await tx.insert(journalEntries).values({
    id: jeId,
    organizationId: input.organizationId,
    date: input.date,
    memo: memoForJournalEntry,
    posted,
    createdAt: now,
    postedAt: posted ? now : null,
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    isAdjusting: input.isAdjusting ?? false,
  });

  const lineResults: JournalEntryResult['lines'] = [];

  for (const line of input.lines) {
    const lineId = randomUUID();
    const debit = Number(line.debit ?? 0);
    const credit = Number(line.credit ?? 0);

    await tx.insert(journalEntryLines).values({
      id: lineId,
      journalEntryId: jeId,
      accountId: line.accountId,
      debit: String(debit),
      credit: String(credit),
      memo: line.memo ?? null,
      createdAt: now,
      contactId: line.contactId ?? null,
      beneficiaryId: line.beneficiaryId ?? null,
    });

    if (posted) {
      await tx.insert(generalLedger).values({
        id: randomUUID(),
        organizationId: input.organizationId,
        accountId: line.accountId,
        journalEntryId: jeId,
        journalEntryLineId: lineId,
        contactId: line.contactId ?? null,
        date: `${input.date}T00:00:00`,
        memo: line.memo ?? input.memo ?? null,
        debit,
        credit,
        balance: null,
        createdAt: now,
      });
    }

    lineResults.push({
      id: lineId,
      accountId: line.accountId,
      debit,
      credit,
      memo: line.memo ?? null,
      contactId: line.contactId ?? null,
    });
  }

  // Persist trust review findings — same transaction as the JE so they're
  // atomic. Empty/no-trust paths skip this entirely (trustEval.findings is
  // []). Surfaces in the Trust Review queue UI.
  if (trustEval.findings.length > 0) {
    await tx.insert(trustReviewFindings).values(
      trustEval.findings.map((f) => ({
        id: randomUUID(),
        organizationId: input.organizationId,
        journalEntryId: jeId,
        code: f.code,
        severity: f.severity,
        message: f.message,
        metadata: f.metadata ?? null,
      })),
    );
  }

  return {
    id: jeId,
    organizationId: input.organizationId,
    date: input.date,
    memo: memoForJournalEntry,
    posted,
    createdAt: now,
    lines: lineResults,
  };
}

export interface ReverseJournalEntryInput {
  organizationId: string;
  journalEntryId: string;
  /** Defaults to the original JE's date (keeps the original period intact). */
  reversalDate?: string;
  /** Defaults to "Reversal of <original memo>". */
  reversalMemo?: string | null;
}

export interface ReverseJournalEntryResult {
  id: string;
  reversalOfId: string;
}

/**
 * Create a reversing JE: same lines as the original with debit ↔ credit swapped,
 * `reversal_of_id` pointing at the original. The reverser is also `posted=true`
 * so it writes its own GL rows that net out the original's GL on each account.
 *
 * Idempotency: if the original JE already has a reverser (any JE with
 * reversal_of_id matching) the function returns that existing reverser
 * without creating a second one.
 *
 * Does NOT void or delete the original — both rows remain in the books, the
 * GL nets to zero, and the audit trail shows reverser → original.
 */
export async function reverseJournalEntry(
  input: ReverseJournalEntryInput,
  tx?: Tx,
): Promise<ReverseJournalEntryResult> {
  if (tx) return runReverseJournalEntry(input, tx);
  return await db.transaction(async (innerTx) => runReverseJournalEntry(input, innerTx));
}

async function runReverseJournalEntry(
  input: ReverseJournalEntryInput,
  tx: Tx,
): Promise<ReverseJournalEntryResult> {
  const [original] = await tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.id, input.journalEntryId), eq(journalEntries.organizationId, input.organizationId)))
    .limit(1);
  if (!original) {
    throw new JournalEntryError(`Journal entry ${input.journalEntryId} not found in this organization`);
  }
  if (original.reversalOfId) {
    throw new JournalEntryError(
      `Journal entry ${input.journalEntryId} is itself a reversal — cannot reverse a reversal`,
    );
  }

  // Idempotency: if a reverser already exists, return it.
  const [existingReverser] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.organizationId, input.organizationId),
        eq(journalEntries.reversalOfId, input.journalEntryId),
      ),
    )
    .limit(1);
  if (existingReverser) {
    return { id: existingReverser.id, reversalOfId: input.journalEntryId };
  }

  const lines = await tx
    .select()
    .from(journalEntryLines)
    .where(eq(journalEntryLines.journalEntryId, input.journalEntryId));
  if (!lines.length) {
    throw new JournalEntryError(`Journal entry ${input.journalEntryId} has no lines to reverse`);
  }

  const reverserId = randomUUID();
  const now = new Date().toISOString();
  const reversalDate = input.reversalDate ?? original.date;
  // Month-end close: a reverser posts into reversalDate's month (defaults to the
  // original entry's month), so reversing/editing an entry in a closed period is
  // blocked too.
  await assertPeriodOpen(input.organizationId, reversalDate, tx);
  const memo = input.reversalMemo ?? `Reversal of ${original.memo ?? 'journal entry'}`;

  await tx.insert(journalEntries).values({
    id: reverserId,
    organizationId: input.organizationId,
    date: reversalDate,
    memo,
    posted: true,
    createdAt: now,
    postedAt: now,
    sourceType: original.sourceType,
    sourceId: original.sourceId,
    reversalOfId: input.journalEntryId,
  });

  // Delete any trust-review findings attached to the JE being reversed.
  // Once the JE is reversed it represents no live posting, so its findings
  // are moot — keeping them around (even dismissed) means each
  // reverse+repost cycle for the same transaction permanently grows the
  // findings table by N per cycle and bloats the Dismissed tab. The new
  // JE's findings are emitted fresh by createJournalEntry, so the audit
  // trail of "what currently applies" is preserved on the live posting.
  await tx
    .delete(trustReviewFindings)
    .where(eq(trustReviewFindings.journalEntryId, input.journalEntryId));

  for (const line of lines) {
    const lineId = randomUUID();
    const origDebit = Number(line.debit ?? 0);
    const origCredit = Number(line.credit ?? 0);
    // Swap: original debit becomes reverser's credit and vice-versa.
    const reverseDebit = origCredit;
    const reverseCredit = origDebit;

    await tx.insert(journalEntryLines).values({
      id: lineId,
      journalEntryId: reverserId,
      accountId: line.accountId,
      debit: String(reverseDebit),
      credit: String(reverseCredit),
      memo: line.memo,
      contactId: line.contactId,
      // Carry the beneficiary tag so per-beneficiary views (Trust
      // Beneficiaries / by-account totals) see the credit cancel the
      // original debit. Without this the John-Doe view kept counting the
      // original line as a live demand on the trust.
      beneficiaryId: line.beneficiaryId ?? null,
      createdAt: now,
    });

    await tx.insert(generalLedger).values({
      id: randomUUID(),
      organizationId: input.organizationId,
      accountId: line.accountId,
      journalEntryId: reverserId,
      journalEntryLineId: lineId,
      contactId: line.contactId,
      date: `${reversalDate}T00:00:00`,
      memo,
      debit: reverseDebit,
      credit: reverseCredit,
      balance: null,
      createdAt: now,
    });
  }

  return { id: reverserId, reversalOfId: input.journalEntryId };
}
