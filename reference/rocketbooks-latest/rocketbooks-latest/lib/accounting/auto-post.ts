import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions } from '@/db/schema/schema';
import { createJournalEntry, reverseJournalEntry, JournalEntryError } from './posting';

export interface TransactionForPosting {
  id: string;
  organizationId: string;
  date: string;
  type: string;
  amount: number;
  accountId: string;
  categoryAccountId: string | null;
  contactId: string | null;
  bankDescription: string | null;
  userDescription: string | null;
  /** Per-line beneficiary tag (Phase 4d). Set when the user has explicitly
   *  linked the categorization to a specific beneficiary — required by the
   *  categorize action when the chosen category is a per-beneficiary
   *  account (815/820/310/635). Lands on the category-side line of the JE
   *  (not the bank-side line). */
  beneficiaryId?: string | null;
}

// Drizzle's tx callback param doesn't have a clean exported type, so we infer.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function createJournalEntryFromTransaction(
  txn: TransactionForPosting,
  tx?: Tx,
): Promise<string> {
  const ttype = txn.type?.toLowerCase();
  if (ttype !== 'deposit' && ttype !== 'withdrawal') {
    throw new JournalEntryError(`Transaction type must be 'deposit' or 'withdrawal', got: ${txn.type}`);
  }
  if (txn.amount <= 0) throw new JournalEntryError('Transaction amount must be positive');
  if (!txn.accountId) throw new JournalEntryError('Transaction must have an account_id');
  if (!txn.categoryAccountId) {
    throw new JournalEntryError('Transaction must have a category_account_id (categorize first)');
  }
  // A category resolving to the transaction's OWN bank account produces a
  // self-cancelling entry (debit + credit on the same account → $0 net), so the
  // bank's money never reaches the ledger and the account silently fails to
  // reconcile. Treat it as not-yet-categorized so the caller leaves it in the
  // review queue / re-categorizes to a real counter account.
  if (txn.categoryAccountId === txn.accountId) {
    throw new JournalEntryError('Category account cannot equal the transaction\'s bank account (self-cancelling)');
  }

  const debitAccount = ttype === 'deposit' ? txn.accountId : txn.categoryAccountId;
  const creditAccount = ttype === 'deposit' ? txn.categoryAccountId : txn.accountId;
  const memo = txn.userDescription || txn.bankDescription || 'Transaction';

  // The category line is the side NOT touching the bank. For a withdrawal
  // the category is on the debit side; for a deposit it's on the credit
  // side. beneficiaryId rides on the category line only — the bank-side
  // line stays untagged.
  const categoryIsDebit = ttype === 'withdrawal';
  const beneficiaryId = txn.beneficiaryId ?? null;

  // Beneficial-trust rules engine runs inside createJournalEntry → no
  // per-site hook needed here. See lib/accounting/posting.ts.
  const result = await createJournalEntry({
    organizationId: txn.organizationId,
    date: txn.date,
    memo,
    posted: true,
    sourceType: 'transaction',
    sourceId: txn.id,
    lines: [
      {
        accountId: debitAccount,
        debit: txn.amount,
        contactId: txn.contactId,
        memo,
        beneficiaryId: categoryIsDebit ? beneficiaryId : null,
      },
      {
        accountId: creditAccount,
        credit: txn.amount,
        contactId: txn.contactId,
        memo,
        beneficiaryId: categoryIsDebit ? null : beneficiaryId,
      },
    ],
  }, tx);
  return result.id;
}

export interface RepostTransactionResult {
  /** id of the reverser JE that nets out the previous post. */
  reverserId: string;
  /** id of the new JE reflecting the current categorization. Null when the
   *  transaction was uncategorized (categoryAccountId set to null). */
  replacementId: string | null;
  /** id of the JE that was reversed (the prior post). */
  reversedJournalEntryId: string;
}

/**
 * When a posted transaction's category (or bank account, contact, amount,
 * date) changes, we can't mutate the existing JE — that would rewrite history
 * in the GL. Instead: create a reversing JE that nets out the old post, then
 * create a new JE for the current state, and re-point
 * transactions.journal_entry_id at the new one.
 *
 * Both writes happen inside a single DB transaction so a partial failure
 * doesn't leave the books in an inconsistent state. Both JEs (reverser +
 * replacement) are dated the original transaction date so period totals stay
 * correct on a per-period basis.
 *
 * If the new state has categoryAccountId=null (uncategorize), the original
 * JE is reversed but no replacement is posted — the transaction returns to
 * the unposted state.
 */
export async function repostTransactionJE(args: {
  txn: TransactionForPosting;
  existingJournalEntryId: string;
}): Promise<RepostTransactionResult> {
  return await db.transaction(async (tx) => {
    const reverser = await reverseJournalEntry(
      {
        organizationId: args.txn.organizationId,
        journalEntryId: args.existingJournalEntryId,
      },
      tx,
    );

    let replacementId: string | null = null;
    if (args.txn.categoryAccountId) {
      replacementId = await createJournalEntryFromTransaction(args.txn, tx);
    }

    await tx
      .update(transactions)
      .set({ journalEntryId: replacementId })
      .where(eq(transactions.id, args.txn.id));

    return {
      reverserId: reverser.id,
      replacementId,
      reversedJournalEntryId: args.existingJournalEntryId,
    };
  });
}
