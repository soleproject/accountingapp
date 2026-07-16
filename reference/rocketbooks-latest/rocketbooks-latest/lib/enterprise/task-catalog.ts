// The catalog of recurring bookkeeping/accounting tasks a firm and its client
// split between them. Single source of truth for keys, labels, cadence, and the
// smart default owner. Used by the business-edit "Responsibilities" matrix now,
// and later to drive who-does-what task generation automatically.

export type TaskCadence = 'monthly' | 'quarterly' | 'annual';
export type TaskOwner = 'pro' | 'client';

// How a task's DEFAULT owner is decided:
//   bookkeeping  → follows who keeps the books (firm→pro, client→client)
//   client_data  → the client (they provide documents / answers / approvals)
//   firm_filing  → the firm (filings, returns, compliance the pro owns)
export type TaskKind = 'bookkeeping' | 'client_data' | 'firm_filing';

export interface CatalogTask {
  key: string;
  label: string;
  description: string;
  cadence: TaskCadence;
  kind: TaskKind;
  /** What RocketBooks' AI does for this task — shown to the pro so they know
   *  what's automated vs. what a person still owns. Truthful: the AI drafts,
   *  flags, estimates, and reminds; it never moves money or files on its own. */
  ai: string;
}

export const TASK_CADENCES: { key: TaskCadence; label: string }[] = [
  { key: 'monthly', label: 'Monthly' },
  { key: 'quarterly', label: 'Quarterly' },
  { key: 'annual', label: 'Annual' },
];

export const TASK_CATALOG: CatalogTask[] = [
  // ── Monthly ────────────────────────────────────────────────────────────
  { key: 'categorize_transactions', cadence: 'monthly', kind: 'bookkeeping',
    label: 'Categorize & review transactions',
    description: 'Code and review every transaction to the right account.',
    ai: 'Auto-categorizes every transaction with a confidence score; flags the low-confidence ones for review.' },
  { key: 'reconcile_accounts', cadence: 'monthly', kind: 'bookkeeping',
    label: 'Reconcile bank & credit-card accounts',
    description: 'Reconcile every account to its statement each month.',
    ai: 'Auto-reconciles against statements & bank feeds and suggests matches for unmatched lines.' },
  { key: 'book_review_findings', cadence: 'monthly', kind: 'bookkeeping',
    label: 'Clear book-review findings',
    description: 'Resolve duplicates, anomalies, and integrity issues.',
    ai: 'Runs the audit sweep — finds duplicates, anomalies & integrity issues for you to clear.' },
  { key: 'accounts_payable', cadence: 'monthly', kind: 'bookkeeping',
    label: 'Manage bills & accounts payable',
    description: 'Record and schedule vendor bills; keep AP current.',
    ai: 'Surfaces overdue bills and the cash impact (reminds only — never pays).' },
  { key: 'accounts_receivable', cadence: 'monthly', kind: 'bookkeeping',
    label: 'Send invoices & follow up on receivables',
    description: 'Issue invoices and chase overdue customer payments.',
    ai: 'Drafts invoices and surfaces overdue receivables to follow up on.' },
  { key: 'apply_payments', cadence: 'monthly', kind: 'bookkeeping',
    label: 'Match & apply payments',
    description: 'Match received payments to the right invoice or bill.',
    ai: 'Surfaces payments that haven’t been applied to an invoice or bill.' },
  { key: 'upload_receipts', cadence: 'monthly', kind: 'client_data',
    label: 'Upload receipts & source documents',
    description: 'Provide receipts and IRS documentation for expenses.',
    ai: 'Extracts the data from uploaded receipts and matches them to transactions.' },
  { key: 'bank_connections', cadence: 'monthly', kind: 'client_data',
    label: 'Keep bank connections live',
    description: 'Reconnect bank/credit-card feeds when they break.',
    ai: 'Detects broken feeds and prompts a reconnect (the client reconnects).' },
  { key: 'categorization_questions', cadence: 'monthly', kind: 'client_data',
    label: 'Answer categorization questions',
    description: 'Clarify unknown vendors or one-off transactions.',
    ai: 'Drafts the “what was this?” question to the client.' },
  { key: 'month_end_close', cadence: 'monthly', kind: 'bookkeeping',
    label: 'Month-end close & financial review',
    description: 'Close the month and review the financial statements.',
    ai: 'Tracks period status and sends the monthly P&L summary.' },

  // ── Quarterly ──────────────────────────────────────────────────────────
  { key: 'sales_tax', cadence: 'quarterly', kind: 'firm_filing',
    label: 'File & remit sales tax',
    description: 'Prepare, file, and remit sales tax to the authority.',
    ai: 'Calculates sales tax collected/owed and reminds before the deadline (you file).' },
  { key: 'payroll_tax_filings', cadence: 'quarterly', kind: 'firm_filing',
    label: 'Payroll tax filings',
    description: 'File quarterly payroll returns (e.g. Form 941).',
    ai: 'Reminds before each quarterly payroll-tax (Form 941) deadline.' },
  { key: 'estimated_taxes', cadence: 'quarterly', kind: 'client_data',
    label: 'Estimated income tax payments',
    description: 'Make quarterly estimated income tax payments.',
    ai: 'Reminds before each quarterly estimated-tax deadline.' },
  { key: 'quarterly_review', cadence: 'quarterly', kind: 'bookkeeping',
    label: 'Quarterly financial review',
    description: 'Review the quarter’s results with the client.',
    ai: 'Generates the quarterly P&L and trend summary.' },
  { key: 'loans_fixed_assets', cadence: 'quarterly', kind: 'bookkeeping',
    label: 'Reconcile loans & fixed assets',
    description: 'Tie out loan balances and the fixed-asset register.',
    ai: 'Flags loan/asset balances that don’t tie out.' },

  // ── Annual ─────────────────────────────────────────────────────────────
  { key: 'year_end_close', cadence: 'annual', kind: 'bookkeeping',
    label: 'Year-end close',
    description: 'Complete the full year-end close checklist.',
    ai: 'Drives the year-end-close checklist and auto-checks what’s already done.' },
  // firm_filing (default Pro even when the client keeps their own books): booking
  // accruals/deferrals and posting depreciation are accountant-skill work a typical
  // client can't do. The firm can still override to the client per business.
  { key: 'adjusting_entries', cadence: 'annual', kind: 'firm_filing',
    label: 'Post adjusting entries',
    description: 'Book accruals, deferrals, and other year-end entries.',
    ai: 'Suggests accruals/deferrals for you to post.' },
  { key: 'depreciation', cadence: 'annual', kind: 'firm_filing',
    label: 'Record depreciation & review fixed assets',
    description: 'Post depreciation and confirm the fixed-asset register.',
    ai: 'Computes depreciation per asset for you to review and post.' },
  { key: 'opening_balances', cadence: 'annual', kind: 'bookkeeping',
    label: 'Confirm opening balances',
    description: 'Verify beginning balances tie to last year’s ending.',
    ai: 'Sources opening balances from bank data for the new year.' },
  { key: 'collect_w9s', cadence: 'annual', kind: 'client_data',
    label: 'Collect W-9s from vendors',
    description: 'Get a W-9 / TIN on file for every 1099 vendor.',
    ai: 'Tracks which 1099 vendors are missing a W-9 and drafts the request.' },
  { key: 'file_1099s', cadence: 'annual', kind: 'firm_filing',
    label: 'Confirm & file 1099-NEC',
    description: 'Confirm 1099 vendors and file their 1099-NECs.',
    ai: 'Identifies 1099-eligible vendors and amounts (you file).' },
  { key: 'books_signoff', cadence: 'annual', kind: 'bookkeeping',
    label: 'Send books to client for sign-off',
    description: 'Share finalized financials and get client approval.',
    ai: 'Packages the financials and drafts the sign-off request.' },
  { key: 'tax_prep_handoff', cadence: 'annual', kind: 'firm_filing',
    label: 'Hand off books to tax preparer',
    description: 'Package the books for the tax preparer / return.',
    ai: 'Assembles the year-end package for the tax preparer.' },
  { key: 'annual_state_filings', cadence: 'annual', kind: 'client_data',
    label: 'File annual report / state registrations',
    description: 'Submit state annual reports and registered-agent filings.',
    ai: 'Reminds before the annual-report deadline you set for the business’s state.' },
];

// Tasks whose AI capability is NOT built yet — rendered with a "Planned" badge
// so the matrix never overstates what's automated today. Verified against the
// codebase (audit Jun 2026): these have no implementing code.
export const AI_PLANNED_KEYS = new Set<string>([
  'loans_fixed_assets',
  'adjusting_entries',
  'books_signoff',
  'tax_prep_handoff',
]);

// Maps a dashboard "needs attention" signal (OutreachIssueType) to the catalog
// task key whose matrix owner decides which Pro/Client tab it routes to. Signals
// not listed here (meeting_followup, onboarding, ad-hoc tasks) keep their default
// taxonomy owner. The live signal is the detailed, self-clearing work item.
export const SIGNAL_TO_TASK_KEY: Record<string, string> = {
  to_review: 'categorize_transactions',
  recon_off: 'reconcile_accounts',
  findings_open: 'book_review_findings',
  overdue_bills: 'accounts_payable',
  overdue_invoices: 'accounts_receivable',
  broken_bank: 'bank_connections',
};

// Catalog keys already covered by a live dashboard signal — the recurring-task
// generator SKIPS these so we never create a duplicate generic task on top of
// the detailed live signal.
export const SIGNAL_COVERED_TASK_KEYS = new Set<string>(Object.values(SIGNAL_TO_TASK_KEY));

export type TaskResponsibilities = Record<string, TaskOwner>;

/** The default owner for a task given who keeps this client's books. */
export function defaultOwnerFor(
  task: CatalogTask,
  booksManagedBy: 'firm' | 'client' | null | undefined,
): TaskOwner {
  if (task.kind === 'client_data') return 'client';
  if (task.kind === 'firm_filing') return 'pro';
  return booksManagedBy === 'client' ? 'client' : 'pro';
}

/** Effective owner: a saved override if present, otherwise the smart default. */
export function resolveOwner(
  task: CatalogTask,
  saved: TaskResponsibilities | null | undefined,
  booksManagedBy: 'firm' | 'client' | null | undefined,
): TaskOwner {
  const v = saved?.[task.key];
  return v === 'pro' || v === 'client' ? v : defaultOwnerFor(task, booksManagedBy);
}

/**
 * Three-tier resolution for a client business:
 *   client override → enterprise firm-wide default → catalog smart default.
 */
export function resolveEffectiveOwner(
  task: CatalogTask,
  clientMatrix: TaskResponsibilities | null | undefined,
  enterpriseDefaults: TaskResponsibilities | null | undefined,
  booksManagedBy: 'firm' | 'client' | null | undefined,
): TaskOwner {
  const c = clientMatrix?.[task.key];
  if (c === 'pro' || c === 'client') return c;
  const e = enterpriseDefaults?.[task.key];
  if (e === 'pro' || e === 'client') return e;
  return defaultOwnerFor(task, booksManagedBy);
}

/** Coerce arbitrary jsonb into a clean TaskResponsibilities map (catalog keys only). */
export function parseResponsibilities(raw: unknown): TaskResponsibilities {
  const out: TaskResponsibilities = {};
  if (!raw || typeof raw !== 'object') return out;
  const keys = new Set(TASK_CATALOG.map((t) => t.key));
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (keys.has(k) && (v === 'pro' || v === 'client')) out[k] = v;
  }
  return out;
}
