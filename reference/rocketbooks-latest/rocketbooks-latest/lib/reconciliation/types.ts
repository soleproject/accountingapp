// Shared types for the reconciliation engine.
//
// CANONICAL SIGN convention used throughout: a positive `signedAmount` means
// money INTO the bank account (deposit / credit), negative means money OUT
// (withdrawal / debit). All three inputs are normalized to this:
//   - ledger transactions: type 'deposit' → +amount, 'withdrawal' → -amount
//   - bank statement lines: type 'credit' → +amount, 'debit' → -amount
//   - Plaid raw: Plaid signs positive=OUT, so canonical = -plaid.amount
//     (see lib/accounting/plaid-promote.ts:38-44)

export type SourceKind = 'statement' | 'plaid';

export interface SourceLine {
  externalId: string;
  date: string; // YYYY-MM-DD
  description: string;
  signedAmount: number; // canonical, 2dp
  runningBalance: number | null;
  /** Direct ledger transaction id this source line is known to be (statement promote-link). */
  matchHintTxnId: string | null;
  /** A transactions.reference value this source line corresponds to (Plaid: 'plaid:<id>'). */
  matchHintRef: string | null;
}

export interface SourceData {
  kind: SourceKind;
  importId: string | null; // statement source only
  // The window to reconcile over: a statement uses its OWN printed period (a
  // billing cycle, e.g. Sep 21 – Oct 21); Plaid uses the calendar month.
  periodStart: string;
  periodEnd: string;
  lines: SourceLine[];
  openingBalance: number | null;
  closingBalance: number | null;
}

export interface LedgerTxn {
  id: string;
  date: string;
  description: string;
  signedAmount: number; // canonical, 2dp
  isManual: boolean;
  reference: string | null;
}

export type MatchKind = 'EXACT' | 'FUZZY' | 'SPLIT' | 'TRANSFER';

export interface Match {
  sourceExternalId: string;
  transactionId: string;
  matchType: MatchKind;
  score: number;
  /** 'engine' | 'ai' | a real user id (manual match, preserved across re-runs). */
  createdBy: string;
}

export interface MatchResult {
  matches: Match[];
  /** Source lines with no ledger match. */
  unmatchedSource: SourceLine[];
  /** Ledger txns with no source match. */
  unmatchedLedger: LedgerTxn[];
}

export interface ReconcileResult {
  status: 'RECONCILED' | 'OPEN' | 'SKIPPED';
  reason?: string;
  periodId?: string;
  sourceKind?: SourceKind;
  difference?: number;
  explanation?: string;
  counts?: { sourceLines: number; ledgerTxns: number; matched: number; unmatchedSource: number; unmatchedLedger: number };
}
