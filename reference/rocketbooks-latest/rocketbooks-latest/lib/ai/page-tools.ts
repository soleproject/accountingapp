import 'server-only';
import { randomUUID } from 'crypto';
import { and, count, eq, gte, ilike, inArray, isNull, lte, or, sql, sum } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, contacts, chartOfAccounts } from '@/db/schema/schema';
import { categorizeTransaction } from '@/lib/accounting/categorize';
import { resolveAccount } from '@/lib/accounting/resolve-account';
import { promoteRule, pendingRuleForTransaction, pendingContactCategorization } from '@/lib/accounting/rule-promotion';
import { GUIDED_REVIEW_URLS } from '@/lib/transactions/guided-review-urls';
import type { EnterpriseOnboardingPatch } from '@/lib/enterprise/onboarding';
import { getOutstandingInvoices } from '@/lib/accounting/invoices-outstanding';
import { propagateTransactionMetadataToJE } from '@/lib/accounting/propagate-metadata';
import {
  GAAP_TYPES,
  validateCoaTriple,
  getAccountType,
  accountTypesForGaap,
  type GaapType,
} from '@/lib/accounting/coa-taxonomy';
import { logger } from '@/lib/logger';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { onboardingAwarePath } from '@/lib/ai/onboarding-destination';
import { saveInteractiveDeliverable } from '@/lib/meetings/followups';
import { replaceTaskSteps } from '@/app/(organizer)/organizer/dashboard/_actions/taskPlan';
import { PERSONAL_TOOLS, isPersonalToolName, executePersonalTool } from '@/lib/ai/personal-tools';
import { saveSubstantiationFields, getNextSubstantiationTarget } from '@/lib/accounting/substantiation';
import type { DocType } from '@/lib/accounting/substantiation-types';
import { TAX_INTAKE_TOOL_DEFINITIONS, isTaxIntakeToolName, executeTaxIntakeTool } from '@/lib/tax/intake-tools';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';

/**
 * Page-scoped tools — exposed to the floating assistant ONLY when the user is
 * on the matching page. Anything in the global `TOOL_DEFINITIONS` (lib/ai/tools.ts)
 * is always available; this file holds the page-specific surface.
 *
 * Tools that need the client to do something (apply URL filters, scroll, open
 * a modal) return `client_action: { name, args }` in their result. The
 * AIAssistantSidecar reads that field and dispatches via AssistantContext.
 */

export interface PageToolContext {
  organizationId: string;
  /** Per-turn id; forwarded to tools with a turn gate (e.g. advance_tax_intake). */
  turnId?: string;
}

const STR_OR_NULL = ['string', 'null'] as const;

// ---------------------------------------------------------------------------
// Transactions page tools
// ---------------------------------------------------------------------------

const TRANSACTIONS_TOOLS: ChatCompletionFunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'apply_transactions_filters',
      description:
        "Update the transactions page URL to filter the visible list by any combination of contact, category, account, date range, search text, status filter, or sort. Use this whenever the user says \"show me\", \"filter to\", \"only show\", or describes a subset of transactions they want to see — e.g. 'show transactions from openai' → resolve openai's contactId then call this with contactId set. Resolve human names to ids via lookup_contact / list_accounts before passing them. The result includes the actual `count` and `totalFormatted` for the filtered set, plus a ready-to-relay `message`; when announcing the result to the user, use these values verbatim — never guess counts or totals.",
      parameters: {
        type: 'object',
        properties: {
          contactId: { type: STR_OR_NULL as unknown as 'string', description: 'Filter to one contact by id' },
          categoryId: { type: STR_OR_NULL as unknown as 'string', description: 'Category account id' },
          accountId: { type: STR_OR_NULL as unknown as 'string', description: 'Bank account id' },
          start: { type: STR_OR_NULL as unknown as 'string', description: 'Start date YYYY-MM-DD' },
          end: { type: STR_OR_NULL as unknown as 'string', description: 'End date YYYY-MM-DD' },
          q: { type: STR_OR_NULL as unknown as 'string', description: 'Free-text search against descriptions' },
          filter: {
            type: 'string',
            enum: ['all', 'to_review', 'reviewed', 'uncategorized', 'unposted'],
            description: 'Status pill',
          },
          sort: {
            type: 'string',
            enum: ['date', 'description', 'contact', 'account', 'category', 'amount'],
          },
          dir: { type: 'string', enum: ['asc', 'desc'] },
          // Pass `clear: true` to wipe all current filters before applying the new ones.
          clear: { type: 'boolean' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_transactions_for_categorization',
      description:
        "List transactions matching a description (used to gather a set the user wants to bulk-categorize). Returns ids + summary. Pair with categorize_transaction_ids to apply a category. Limit defaults to 50.",
      parameters: {
        type: 'object',
        properties: {
          contactId: { type: 'string' },
          contactName: { type: 'string' },
          q: { type: 'string', description: 'Free-text search' },
          uncategorizedOnly: { type: 'boolean' },
          unreviewedOnly: { type: 'boolean' },
          start: { type: 'string', description: 'YYYY-MM-DD' },
          end: { type: 'string', description: 'YYYY-MM-DD' },
          limit: { type: 'number' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'categorize_transaction_ids',
      description:
        "Apply one category account to a specific list of transaction ids. Use after the user has confirmed (e.g. 'yes go ahead'). The category is resolved against the org's chart of accounts in this order: UUID → accountNumber → exact accountName (case-insensitive). Always prefer passing the UUID `id` from list_accounts when you have it. Returns counts of posted vs updated vs skipped — and on no-match, returns the closest-name suggestions so you can confirm with the user.",
      parameters: {
        type: 'object',
        properties: {
          transactionIds: { type: 'array', items: { type: 'string' }, description: 'Transaction UUIDs' },
          categoryAccountId: {
            type: 'string',
            description:
              "Account UUID, accountNumber, or exact accountName from list_accounts. UUID is preferred — the others are best-effort fallbacks.",
          },
          markVerified: {
            type: 'boolean',
            description:
              "Set true when CORRECTING a category in the 'Review AI Categorized' verify flow — recategorizes AND marks the transactions human-verified (green check) so the group leaves the queue and the guided review advances. Omit/false for normal categorization.",
          },
        },
        required: ['transactionIds', 'categoryAccountId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'categorize_filtered_transactions',
      description:
        "Categorize EVERY transaction matching a set of filters in one shot — even across pages. Call this ONLY when the user EXPLICITLY asks to categorize them (\"categorize all of these\", \"yes, do it\", \"all the AIO Solutions ones\", \"every uncategorized transaction\") — NOT when they're just asking what category something should be or thinking out loud. Use it while looking at a filtered view. Pass whichever filters constrain the set (contactId, accountId, categoryId, q, date range, status, uncategorizedOnly). At least one filter is required so we never categorize the entire org by accident. Returns counts of posted / updated / skipped.",
      parameters: {
        type: 'object',
        properties: {
          categoryAccountId: {
            type: 'string',
            description: 'Account UUID, accountNumber, or exact accountName. UUID preferred.',
          },
          contactId: { type: 'string' },
          accountId: { type: 'string' },
          categoryId: { type: 'string' },
          q: { type: 'string' },
          start: { type: 'string', description: 'YYYY-MM-DD' },
          end: { type: 'string', description: 'YYYY-MM-DD' },
          uncategorizedOnly: { type: 'boolean' },
          unreviewedOnly: { type: 'boolean' },
          /**
           * Hard cap so a stray broad filter doesn't blast 10k transactions.
           * Defaults to 200; the AI can raise it after warning the user.
           */
          maxRows: { type: 'number' },
        },
        required: ['categoryAccountId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_categorization_rule',
      description:
        "Create a deterministic categorization RULE for a merchant so FUTURE transactions matching it auto-categorize (skipping the AI), and mark all existing matching transactions reviewed/verified. Call this ONLY after the user has EXPLICITLY confirmed they want a rule ('yes', 'create the rule', 'always categorize X as Y') — do NOT call it when the user is just asking a question or naming a category. Pass the merchant text `pattern` (a substring matched in the description, e.g. \"Walmart\") and the `categoryAccountId`. If the merchant's deposits and withdrawals belong on DIFFERENT accounts (e.g. a refund deposit vs a purchase withdrawal), scope the rule with `transactionType` ('deposit' or 'withdrawal') matching the transactions you're ruling on; omit it for a rule that applies to any direction. Do NOT use create_chart_account for this — that creates a new ledger account, not a rule.",
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Merchant text to match, e.g. "Walmart".' },
          categoryAccountId: { type: 'string', description: 'Account UUID, accountNumber, or exact accountName.' },
          transactionType: {
            type: 'string',
            enum: ['deposit', 'withdrawal'],
            description:
              "Optional — scope the rule to one direction. Use it when a merchant's deposits and withdrawals categorize differently (a deposit-review rule should be 'deposit'). Omit for any direction.",
          },
        },
        required: ['pattern', 'categoryAccountId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_guided_review',
      description:
        "Enter one of the three guided review flows. Call this when the user picks which review to start from the 'Start guided review' picker — by tapping a chip OR by telling/saying which (e.g. 'let's do deposits', 'the AI-categorized ones', 'uncategorized'). Navigates the page into that guided flow.",
      parameters: {
        type: 'object',
        properties: {
          which: {
            type: 'string',
            enum: ['deposits', 'ai_categorized', 'uncategorized'],
            description:
              "'deposits' = Review Deposits; 'ai_categorized' = Review AI Categorized; 'uncategorized' = Uncategorized Transactions.",
          },
        },
        required: ['which'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_transaction_ids',
      description:
        "Mark specific transactions as human-VERIFIED (the green check) — used in the 'Review AI Categorized' guided flow when the user confirms your categorization ('yes', 'sound good'). Does NOT change the category, only verifies. Returns pendingRule (the merchant maps consistently → offer create_categorization_rule) and/or pendingContact (other unverified same-contact transactions you can offer to align).",
      parameters: {
        type: 'object',
        properties: {
          transactionIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Transaction ids to verify (pageContext.data.guide.transactionIds).',
          },
        },
        required: ['transactionIds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_contact_for_transactions',
      description:
        "Reassign the contact on one or more transactions. Resolve the new contact via lookup_contact (or create_contact) first to get the id.",
      parameters: {
        type: 'object',
        properties: {
          transactionIds: { type: 'array', items: { type: 'string' } },
          contactId: { type: STR_OR_NULL as unknown as 'string', description: 'New contact id, or null to clear' },
        },
        required: ['transactionIds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_transaction',
      description:
        'Navigate the user to a single transaction detail/edit screen. Set split=true to open it directly in SPLIT mode — use this for the "Split deposit" flow (splitting a deposit/withdrawal across multiple categories).',
      parameters: {
        type: 'object',
        properties: {
          transactionId: { type: 'string' },
          split: { type: 'boolean', description: 'Open directly in split-edit mode.' },
        },
        required: ['transactionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_transfer_counterpart',
      description:
        "For a DEPOSIT you suspect is an internal transfer between the user's own accounts, find the matching outgoing transaction on ANOTHER account (same amount, opposite direction, within ±5 days). Returns the counterpart + its source account, or none. Use it to confirm a transfer and tell the user which account the money came from — transfers are NOT income.",
      parameters: {
        type: 'object',
        properties: {
          transactionId: {
            type: 'string',
            description: 'The deposit transaction id (from pageContext.data.guide.transactionIds).',
          },
        },
        required: ['transactionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_matching_invoice',
      description:
        "For a DEPOSIT you think is a customer payment, find OPEN (posted, unpaid) invoices for that transaction's contact whose outstanding balance matches the deposit amount. A match means this deposit is a payment against that invoice (it reduces A/R) rather than fresh income — confirm with the user. Returns matching invoices, or none.",
      parameters: {
        type: 'object',
        properties: {
          transactionId: { type: 'string', description: 'The deposit transaction id.' },
        },
        required: ['transactionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'restore_view',
      description:
        "Take the user BACK to the exact transactions view they were on before they started discussing (their filters / toggles / a guided-review process). Call this ONCE you've finished helping and applied any changes — pass the `url` you were given in the discussion context. Only /transactions URLs are allowed.",
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The /transactions URL (path + query) to return to, provided in the discussion context.',
          },
        },
        required: ['url'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Sidebar-assistant global tools — always available regardless of page.
// ---------------------------------------------------------------------------

/**
 * Whitelist of destinations the `navigate` tool can route to. Keep this in
 * sync with components/layout/Sidebar.tsx. The model picks one by name; the
 * client action then routes to the matching href.
 */
const NAVIGATION_DESTINATIONS: Record<string, string> = {
  dashboard: '/dashboard',
  pulse: '/pulse',
  transactions: '/transactions',
  invoices: '/invoices',
  new_invoice: '/invoices/new',
  follow_up_invoices: '/invoices/follow-up',
  bills: '/bills',
  overdue_bills: '/bills?filter=overdue',
  payments: '/payments',
  new_payment: '/payments/new',
  receipts: '/receipts',
  upload_receipt: '/receipts/upload',
  reports: '/reports',
  balance_sheet: '/reports/balance-sheet',
  income_statement: '/reports/income-statement',
  cash_flow: '/reports/cash-flow',
  trial_balance: '/reports/trial-balance',
  general_ledger: '/reports/general-ledger',
  contacts: '/contacts',
  new_contact: '/contacts/new',
  imports: '/imports',
  new_import: '/imports/new',
  bank_connections: '/integrations/plaid',
  qbo: '/integrations/qbo',
  plaid_feed: '/plaid-feed',
  reconciliation: '/reconciliation',
  period_close: '/period-close',
  book_review: '/book-review',
  chart_of_accounts: '/chart-of-accounts',
  journal_entries: '/journal-entries',
  new_journal_entry: '/journal-entries/new',
  assets: '/assets',
  loans: '/loans',
  inventory: '/inventory',
  tags: '/tags',
  rental_properties: '/rental-properties',
  communications: '/connections/communications',
  businesses: '/businesses',
  personal: '/personal',
  tasks: '/tasks',
  activity: '/activity',
  settings: '/settings',
  ai_chat: '/ai-chat',
  categorize_transactions: '/ai-chat?categorize=open',
  // Enterprise (firm) area — the staff-accountant surface. firm_setup is the
  // "Set up your firm" wizard (NOT ai_chat, which is the client accounting onboarding).
  firm_setup: '/enterprise/onboarding',
  enterprise_dashboard: '/enterprise/dashboard',
  enterprise_clients: '/enterprise/clients',
  enterprise_client_businesses: '/enterprise/businesses',
  enterprise_work: '/enterprise/work',
  enterprise_billing: '/enterprise/billing',
  enterprise_communications: '/enterprise/communications',
  enterprise_staff: '/enterprise/staff',
  enterprise_settings: '/enterprise/settings',
};

/**
 * Pages that are MULTI-STEP processes. When navigation lands on one of these,
 * the tool result carries a `workflow` note so the assistant walks the client
 * through it (one step at a time, acting on their approval) rather than just
 * dropping them there. Pages NOT listed here are simple navigations — the
 * assistant just confirms briefly. Keyed by resolved path (query included).
 */
export const WORKFLOW_GUIDES: Record<string, string> = {
  '/invoices/follow-up':
    "Overdue-invoice follow-up. Steps: (1) the overdue invoices are pre-selected — together confirm or trim the selection; (2) Generate previews to see the reminder you've drafted for each customer; (3) review/edit the drafts together; (4) on the client's approval the reminders send from their business with replies routed back to them. Walk it one step at a time in 'we' language — you draft and send on their go-ahead, then confirm it's done.",
  '/ai-chat?categorize=open':
    "Transaction categorization workspace. We clear the review queue together: you propose a category (with brief reasoning) for each transaction, the client confirms or corrects, and you apply it. Move through them; act on each confirmation.",
  '/reconciliation':
    "Bank reconciliation. Steps together: (1) pick the open reconciliation to work (or start a new one with the account + statement dates + ending balance); (2) for a statement reconciliation, match each statement line to its ledger transaction; for a manual one, check off the transactions that cleared; (3) keep chasing the remaining difference until it's about $0 — it marks reconciled automatically once it balances. Walk through one item at a time in 'we' language and keep them oriented on how much difference is left.",
  '/reports/form-1099':
    "1099 prep. Steps together: (1) review which vendors crossed $600 and confirm who truly needs a 1099-NEC (the AI eligibility suggestions help — Accept/Dismiss each); (2) for anyone missing a W-9/TIN, request it (per-vendor or the bulk 'Request W-9' button); (3) once W-9s are on file, generate the 1099-NEC PDFs. Walk through in 'we' language; the page has the buttons.",
  '/substantiation':
    "IRS documentation. Steps together: (1) review the recent transactions flagged as needing substantiation (meals, travel, gifts, vehicle, charitable); (2) request the required details from the client (the 'Request documentation' button emails them); (3) their reply is filed automatically and shows under 'On file'. Walk through in 'we' language.",
  '/year-end-close':
    "Year-end close. Work the checklist together, highest-priority 'attention' items first: each item links to where it's handled (categorize the review queue, clear book-review findings, confirm 1099 vendors, collect W-9s, remit sales tax) plus manual check-offs (reconcile, depreciation, opening balances, client approval). Take them one at a time and keep them oriented on what's left.",
  '/imports':
    "Statement import. Steps together: (1) upload a bank statement (PDF/image) — it extracts automatically; (2) open the import to review the extracted transactions; (3) promote them into the ledger so they join the books. Walk through in 'we' language.",
  '/receipts':
    "Receipts. Steps together: (1) upload a receipt — it extracts automatically (vendor, date, total); (2) review the suggested transaction match; (3) post it so it's linked in the books. Walk through in 'we' language.",
  '/book-review':
    "Book review. FIRST call get_book_review_findings to load the open findings (duplicates, near-duplicates, integrity issues, anomalies) — do NOT use query_transactions/list_attention_items here, they're a different dataset and will make you wrongly say there's nothing. Then walk them highest-severity first ('warn' before 'info'): for each, look at the flagged transaction(s) and decide together — fix the books, or dismiss if it's fine — then resolve it so it clears. Move one at a time in 'we' language.",
  '/period-close':
    "Monthly close. Steps together, oldest open month first: (1) confirm the month's transactions are categorized and reconciled; (2) mark it reviewed; (3) lock (close) the period so it can't change. Take one month at a time and keep them oriented on what's still open.",
  '/plaid-feed':
    "Bank feed review. Steps together: (1) go through the synced transactions that aren't in the books yet; (2) confirm the category/account for each (you propose, the client confirms); (3) post them so they join the ledger. Work through them and act on each confirmation.",
  '/contacts':
    "Contact cleanup. Steps together: (1) review the contacts that look like duplicates of the same vendor/customer; (2) pick which record to keep as the primary; (3) merge the duplicates into it (the page's merge bar combines them) so history stays intact. Walk through in 'we' language, one duplicate group at a time.",
  '/assets':
    "Fixed assets. Steps together: (1) review the active assets and their depreciation status; (2) when a period is due, run depreciation so the expense and accumulated-depreciation entries post; (3) confirm the result. Walk through in 'we' language.",
};

export const SIDEBAR_GLOBAL_TOOLS: ChatCompletionFunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'find_contact',
      description:
        "Smart contact lookup — use this FIRST whenever the user names a person/company so you can get a real id. Tolerates ampersand vs 'and' (Grace&Love ↔ Grace and Love), missing/extra LLC/Inc/Trust suffixes, punctuation, and typos. Returns ranked candidates with id + name. Always prefer this over lookup_contact in the sidecar — lookup_contact does a strict substring match and misses common phrasings.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What the user said — pass it verbatim, the tool normalizes.' },
          limit: { type: 'number', description: 'Max candidates to return (1-10, default 5).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_chart_account',
      description:
        "Create a new account in the org's chart of accounts. Use this when the user describes a transaction whose correct GAAP category doesn't have a matching account yet — e.g. an investor capital contribution into an LLC where there's no 'Partner Contributions' / 'Paid-In Capital' account. After creating, you may immediately reference the returned id in categorize_transaction_ids. Pick the canonical (gaap_type, account_type, detail_type) triple for the GAAP-correct treatment of this kind of transaction; don't ask the user for technical slugs. account_number is auto-assigned in the right range (1xxx asset, 2xxx liability, 3xxx equity, 4xxx income, 5xxx-6xxx expense) when omitted.",
      parameters: {
        type: 'object',
        properties: {
          accountName: { type: 'string', description: 'User-facing name (e.g. "Capital Contributions - Grace & Love Trust")' },
          gaapType: {
            type: 'string',
            enum: ['asset', 'liability', 'equity', 'income', 'expense'],
          },
          accountType: {
            type: 'string',
            description:
              'Canonical account_type slug. Common picks: "equity" for owner/partner/investor capital, "long_term_liabilities" for investor loans / notes payable, "income" for revenue, "other_current_assets" for receivables/prepaids, "expense" for operating expenses.',
          },
          detailType: {
            type: 'string',
            description:
              'Canonical detail_type slug for that account_type. Examples: equity → "partner_contributions" / "paid_in_capital_or_surplus" / "common_stock" / "owners_equity"; long_term_liabilities → "notes_payable"; income → "service_fee_income" / "sales_of_product_income" / "other_miscellaneous_income".',
          },
          parentAccountNumber: {
            type: 'string',
            description: "Existing accountNumber to nest under (e.g. '3000' to make this a sub-account of Owner's Equity). Optional.",
          },
          accountNumber: { type: 'string', description: 'Specific account number; auto-assigned if omitted.' },
        },
        required: ['accountName', 'gaapType', 'accountType', 'detailType'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description:
        "Take the user to another page in the app. Use this whenever the user says they want to go to / open / look at / work on / do something on another page (\"take me to transactions\", \"I want to do an invoice\", \"open my reports\", \"I need to upload a receipt\"). Pick the closest destination from the enum. Don't navigate when the user is just asking a question that you can answer here. AFTER it runs: if the result includes a `workflow` note, that page is a multi-step process — walk the client through it one step at a time in 'we' language and act on their approval (don't just say 'you can take it from here'). If there's no `workflow`, just briefly confirm what we're doing in one sentence.",
      parameters: {
        type: 'object',
        properties: {
          destination: {
            type: 'string',
            enum: Object.keys(NAVIGATION_DESTINATIONS),
            description:
              "Where to go. 'new_invoice' / 'new_contact' / 'new_payment' / 'new_journal_entry' / 'upload_receipt' / 'new_import' open the create form directly. 'qbo' is the QuickBooks Online integration page; 'bank_connections' is the Plaid bank-link page; 'plaid_feed' is the synced bank-transaction feed. 'follow_up_invoices' opens the overdue-invoice follow-up workflow (use it when the user agrees to chase/follow up on overdue invoices). 'overdue_bills' opens the bills list filtered to overdue (use when the user wants to pay/review bills that are due). 'categorize_transactions' opens the AI categorization workspace for the review queue (use when the user agrees to categorize/review their transactions). Accounting registers/ledger: 'assets' (fixed assets), 'loans', 'inventory', 'tags', 'rental_properties', 'chart_of_accounts', 'journal_entries', 'book_review' (audit findings), 'period_close' (close the books monthly). 'communications' is the client email/message thread list. 'pulse' is the business-health dashboard.",
          },
        },
        required: ['destination'],
      },
    },
  },
];

const SIDEBAR_GLOBAL_TOOL_NAMES = new Set(SIDEBAR_GLOBAL_TOOLS.map((t) => t.function.name));

export function isSidebarGlobalToolName(name: string): boolean {
  return SIDEBAR_GLOBAL_TOOL_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// Page registry — pageId → tool defs.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Task Workspace page tools
// ---------------------------------------------------------------------------

const GENERATE_ARTIFACT_TOOL: ChatCompletionFunctionTool = {
  type: 'function',
  function: {
    name: 'generate_artifact',
    description:
      "Render (or revise) a drafted artifact onto the open canvas the user is looking at in the Task Workspace. Call this ONLY after the user has confirmed what they want. Ground the body in the linked context from your page state (the contact's real name, the email you're replying to, the overdue invoice, what the note said) — do not invent names or facts. REVISION: if your page state has a non-null `current_draft`, the user is iterating on existing text — start from current_draft.body, apply ONLY the change they asked for, and return the FULL updated body (never a diff or a fragment, and don't drop content they didn't mention). The `body` is the full finished text (markdown allowed: # headings, ** bold **, - bullets). Keep it honest: this drafts text onto the canvas, it does not send or file anything. Returns a confirmation; after it, tell the user in one short sentence what changed (or that the draft is ready) and that they can edit it on the canvas.",
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['letter', 'email', 'text', 'resolution', 'deck'],
          description:
            "The kind of artifact. For kind='deck' (a slideshow), write the body as slides separated by a line with only '---'; each slide starts with '# Slide Title' then '-' bullet lines, optional '> ' speaker-note lines, and — when the user wants pictures/images — an 'img: <concise visual description>' line per slide. IMPORTANT: you do NOT render images; the user clicks the 'Generate images' button on the canvas to create them. NEVER claim the deck already contains images, icons, or pictures — say you've added image prompts and they can click Generate images.",
        },
        title: {
          type: 'string',
          description:
            "A short title for the draft (e.g. 'Follow-up on invoice INV-1044' or, for an email, the subject line).",
        },
        body: {
          type: 'string',
          description: 'The full drafted text. Markdown allowed for light formatting.',
        },
      },
      required: ['kind', 'title', 'body'],
    },
  },
};

const TASK_WORKSPACE_TOOLS: ChatCompletionFunctionTool[] = [GENERATE_ARTIFACT_TOOL];

// Meeting debrief interactive session: draft each approved deliverable on the
// canvas (generate_artifact), then file the finished one with save_deliverable,
// which persists it to the documents area and advances the queue.
const MEETING_DEBRIEF_SESSION_TOOLS: ChatCompletionFunctionTool[] = [
  GENERATE_ARTIFACT_TOOL,
  {
    type: 'function',
    function: {
      name: 'save_deliverable',
      description:
        "File the FINISHED deliverable currently on the canvas for the action item you're working on, saving it to the user's Documents and marking that item done. Call this ONLY after the user has reviewed the draft and says it's good. Use the item id from your page state's `current_item.id`. After it succeeds, the session advances to the next queued item automatically — tell the user what was saved and move on to the next one (or say you're all done).",
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: "The current action item's id (from page state current_item.id)." },
          kind: { type: 'string', enum: ['letter', 'email', 'resolution', 'deck'], description: 'Document kind being saved.' },
          title: { type: 'string', description: 'A title for the saved document.' },
          body: { type: 'string', description: 'The full finished document text (the current canvas draft).' },
        },
        required: ['item_id', 'kind', 'title', 'body'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Task step-plan review (dashboard flip) tools
// ---------------------------------------------------------------------------

const TASK_STEP_PLAN_TOOLS: ChatCompletionFunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'update_task_steps',
      description:
        "Update the step plan for the task the user is reviewing on the dashboard (pageId='task-step-plan'). Your page state has `task_id` and the current `steps`. Use this when the user wants to add, remove, reorder, or relabel steps, AND/OR when they approve the plan. Pass the FULL new ordered list of steps every time (not a diff) — include the steps you're keeping. Set confirm=true when the user approves the plan so work can begin (you may pass the unchanged steps with confirm=true to approve as-is). After it succeeds, say in one short sentence what changed / that you're starting, then go step by step.",
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task id from your page state (task_id).' },
          steps: {
            type: 'array',
            description: 'The full ordered list of steps after the edit. Keep titles short and imperative.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short imperative step title.' },
                type: {
                  type: 'string',
                  enum: ['document', 'email', 'text', 'manual'],
                  description: "document = produce a letter/memo/etc; email/text = send a message; manual = something the app can't do for the user.",
                },
                docKind: {
                  type: 'string',
                  enum: ['letter', 'email', 'text', 'resolution', 'deck'],
                  description: 'For document steps only: the document kind. Default letter.',
                },
              },
              required: ['title', 'type'],
            },
          },
          confirm: {
            type: 'boolean',
            description: 'True when the user has approved the plan and work should begin.',
          },
        },
        required: ['task_id', 'steps'],
      },
    },
  },
];

// Enterprise "Set up your firm" walkthrough — one tool: record the current
// step's answer + advance. Exposed only on pageId='enterprise-onboarding'.
const ENTERPRISE_ONBOARDING_TOOLS: ChatCompletionFunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'advance_onboarding_step',
      description:
        "Record the firm's answer for the CURRENT 'Set up your firm' step and advance to the next step. Call this once the user answers the current step (or says to continue / skip). Pass ONLY the field(s) relevant to the current step; omit the rest. Default advance=true.",
      parameters: {
        type: 'object',
        properties: {
          privateLabelEnabled: { type: 'boolean', description: 'Private label step: whether the firm wants to private-label ($95/mo).' },
          aiAssistantName: { type: 'string', description: "Branding step: the name for the firm's AI assistant." },
          brandColorHex: { type: 'string', description: 'Branding step: brand color hex like #2563eb.' },
          clientBillingMode: { type: 'string', enum: ['client_pays', 'firm_pays'], description: 'Client Billing step: who pays.' },
          clientPriceMode: { type: 'string', enum: ['discount_69', 'standard_referral'], description: 'Client Billing step: discounted client price vs standard rate + referral.' },
          clientOnboardingHandoff: { type: 'string', enum: ['meeting', 'self'], description: 'Client experience step: AI books a setup meeting vs the client self-serves.' },
          advance: { type: 'boolean', description: 'Move to the next step (default true). false = save without advancing.' },
        },
        required: [],
      },
    },
  },
];

// Enterprise (firm) staff-accountant tools — exposed area-wide on pageId='enterprise'.
const ENTERPRISE_TOOLS: ChatCompletionFunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_clients_needing_attention',
      description:
        "List the firm's client companies that need attention right now (broken bank feeds, transactions to review, off reconciliations, overdue bills/invoices, open tasks), worst-first, with firm-wide totals. Use for 'what needs attention?' / 'what should I do?'.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_client_status',
      description: "Get one client company's current status and open-item counts, by name.",
      parameters: {
        type: 'object',
        properties: { clientName: { type: 'string', description: 'Client company or owner name (fuzzy match).' } },
        required: ['clientName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_client_books',
      description:
        "Open a client company's books (impersonate + drop into their workspace) so the in-books assistant can do the actual bookkeeping/reconciling. Identify the client by orgId (from list_clients_needing_attention) or by name. Confirm with the user before opening.",
      parameters: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The client company orgId (preferred; from list_clients_needing_attention).' },
          clientName: { type: 'string', description: 'Client company or owner name (fallback if no orgId).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'focus_client',
      description:
        "Spotlight a client on the firm dashboard — switches to the Client Businesses tab, scrolls that client's row to the top, and gives it a blue glow. Call this right BEFORE you talk about a client during client review so the user sees which client you mean. Pass the orgId from list_clients_needing_attention.",
      parameters: {
        type: 'object',
        properties: { orgId: { type: 'string', description: 'The client company orgId (from list_clients_needing_attention).' } },
        required: ['orgId'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// IRS Documentation (/substantiation) page tools
// ---------------------------------------------------------------------------

const SUBSTANTIATION_TOOLS: ChatCompletionFunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'fill_substantiation_card',
      description:
        'Fill the IRS-documentation fields for the ONE transaction the user is currently documenting on the IRS Documentation page. Page context `activeTransaction` holds its `transactionId`, doc type, and `askFields` (the exact field keys + labels to collect). Flow: the user clicked "Ask AI" on a transaction card, so FIRST ask them for the needed details in ONE short, natural, friendly sentence — like a helpful bookkeeper, NEVER a numbered list or a field-by-field form, and don\'t echo the field labels verbatim. Once they answer, call this tool with { transactionId: activeTransaction.transactionId, fields: { "<exact field key>": "<value>" } }. Use ONLY the exact keys from activeTransaction.askFields; include only fields the user actually gave you; never invent values. The values drop into the card for the user to review and Save — you do not save them. After calling, confirm in one short sentence that you filled it in to review + Save.',
      parameters: {
        type: 'object',
        properties: {
          transactionId: {
            type: 'string',
            description: 'The activeTransaction.transactionId from page context — the card being filled.',
          },
          fields: {
            type: 'object',
            description: 'Map of field key → value string, using the exact keys from activeTransaction.askFields.',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['transactionId', 'fields'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_substantiation_card',
      description:
        'Save the IRS documentation for the active transaction and advance to the next one. Call this when the user confirms (says "save", "looks good", "yes", "go ahead") AFTER you filled the card with fill_substantiation_card. Pass { transactionId, docType, fields } — the exact values the user provided (same keys as the fill call, plus any correction they made). Only call it once you have every REQUIRED (non-optional) field. It persists the record; the result includes `next` = the next transaction still needing docs (with its description + askFields) or null when none remain. AFTER it returns ok:true: if `next` is present, immediately move on — ask about that next transaction in one short natural sentence (per next.askFields); if `next` is null, tell the user everything is documented. Never say something was saved unless you called THIS tool and it returned ok:true.',
      parameters: {
        type: 'object',
        properties: {
          transactionId: { type: 'string', description: 'activeTransaction.transactionId — the card being saved.' },
          docType: { type: 'string', description: 'activeTransaction.docType (e.g. meal, travel, gift, vehicle, lodging, charitable).' },
          fields: {
            type: 'object',
            description: 'Map of field key → value, using the exact keys from activeTransaction.askFields.',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['transactionId', 'docType', 'fields'],
      },
    },
  },
];

export const PAGE_TOOL_REGISTRY: Record<string, ChatCompletionFunctionTool[]> = {
  transactions: TRANSACTIONS_TOOLS,
  substantiation: SUBSTANTIATION_TOOLS,
  'task-workspace': TASK_WORKSPACE_TOOLS,
  'task-step-plan': TASK_STEP_PLAN_TOOLS,
  'meeting-debrief-session': MEETING_DEBRIEF_SESSION_TOOLS,
  personal: PERSONAL_TOOLS,
  // The Taxes product's sidecar: the full tax intake/onboarding toolset, exposed only
  // while the user is on a /taxes page (registered via TaxAssistantRegistrar).
  taxes: TAX_INTAKE_TOOL_DEFINITIONS,
  'enterprise-onboarding': ENTERPRISE_ONBOARDING_TOOLS,
  enterprise: ENTERPRISE_TOOLS,
};

/** All page tool names — used by the executor to check whether a tool is page-scoped. */
const PAGE_TOOL_NAMES = new Set<string>(
  Object.values(PAGE_TOOL_REGISTRY).flat().map((t) => t.function.name),
);

export function isPageToolName(name: string): boolean {
  return PAGE_TOOL_NAMES.has(name);
}

/**
 * Pick the tool definitions to expose for a given page + allow-list. If the
 * page didn't pre-filter, all of that page's tools are available.
 */
export function getPageTools(pageId: string | undefined, allowList?: string[]): ChatCompletionFunctionTool[] {
  if (!pageId) return [];
  const defs = PAGE_TOOL_REGISTRY[pageId];
  if (!defs) return [];
  if (!allowList || allowList.length === 0) return defs;
  const allow = new Set(allowList);
  return defs.filter((t) => allow.has(t.function.name));
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ClientAction {
  name: string;
  args: Record<string, unknown>;
}

function clientAction(name: string, args: Record<string, unknown>): { client_action: ClientAction } {
  return { client_action: { name, args } };
}

// Turn-gate for the enterprise onboarding advance — prevents a double-advance
// (skipped step) when the model calls advance_onboarding_step twice in one turn.
// Keyed by turnId; within a chat turn all tool rounds share the same process.
const advancedOnboardingTurns = new Set<string>();

export async function executePageTool(
  ctx: PageToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Personal-finance tools are user-scoped (not org-scoped); resolve the
  // effective user and delegate to the personal tool executor.
  if (isPersonalToolName(name)) {
    const userId = await getEffectiveUserId();
    return executePersonalTool(userId, name, args);
  }

  // Tax intake/onboarding tools — org-scoped; forward the turnId for the
  // advance_tax_intake turn gate.
  if (isTaxIntakeToolName(name)) {
    return executeTaxIntakeTool({ organizationId: ctx.organizationId, turnId: ctx.turnId }, name, args);
  }

  switch (name) {
    case 'advance_onboarding_step': {
      // Turn-gate: gpt-4o sometimes calls this twice in one turn (narrate → call →
      // call again), which would skip a step. Allow one advance per turnId.
      if (ctx.turnId) {
        if (advancedOnboardingTurns.has(ctx.turnId)) {
          return { ok: true, alreadyAdvanced: true, note: 'Already advanced this turn — coach the current step now; do not advance again.' };
        }
        advancedOnboardingTurns.add(ctx.turnId);
        if (advancedOnboardingTurns.size > 500) advancedOnboardingTurns.clear();
      }
      const { getCurrentEnterprise } = await import('@/lib/auth/enterprise');
      const { saveEnterpriseOnboardingStep } = await import('@/lib/enterprise/onboarding');
      const ent = await getCurrentEnterprise();
      if (!ent) return { error: 'No active enterprise.' };
      const patch: EnterpriseOnboardingPatch = {};
      if (typeof args.privateLabelEnabled === 'boolean') patch.privateLabelEnabled = args.privateLabelEnabled;
      if (typeof args.aiAssistantName === 'string' && args.aiAssistantName.trim()) patch.aiAssistantName = args.aiAssistantName.trim();
      if (typeof args.brandColorHex === 'string' && args.brandColorHex.trim()) patch.brandColorHex = args.brandColorHex.trim();
      if (args.clientBillingMode === 'client_pays' || args.clientBillingMode === 'firm_pays') patch.clientBillingMode = args.clientBillingMode;
      if (args.clientPriceMode === 'discount_69' || args.clientPriceMode === 'standard_referral') patch.clientPriceMode = args.clientPriceMode;
      if (args.clientOnboardingHandoff === 'meeting' || args.clientOnboardingHandoff === 'self') patch.clientOnboardingHandoff = args.clientOnboardingHandoff;
      const status = await saveEnterpriseOnboardingStep(ent.id, {
        patch: Object.keys(patch).length > 0 ? patch : undefined,
        to: args.advance === false ? 'stay' : 'next',
      });
      return { ok: true, phase: status.phase, ...clientAction('refresh_page', {}) };
    }
    case 'list_clients_needing_attention': {
      const { getCurrentEnterpriseId } = await import('@/lib/auth/enterprise');
      const { getEnterpriseClientHealth } = await import('@/lib/enterprise/client-health');
      const entId = await getCurrentEnterpriseId();
      if (!entId) return { error: 'No active enterprise.' };
      const health = await getEnterpriseClientHealth(entId, null);
      const clients = health.clients
        .filter((c) => c.needsAttentionCount > 0 || c.blockingCount > 0)
        .slice(0, 25)
        .map((c) => ({
          orgId: c.orgId,
          client: c.orgName,
          owner: c.ownerName,
          blocking: c.blockingCount > 0,
          brokenBankFeeds: c.brokenBankFeeds,
          toReview: c.toReview,
          reconOff: c.reconOff,
          overdueBills: c.overdueBills,
          overdueInvoices: c.overdueInvoices,
          openTasks: c.openTasks,
        }));
      return { ok: true, count: clients.length, totals: health.totals, clients };
    }
    case 'get_client_status': {
      const q = String(args.clientName ?? '').trim().toLowerCase();
      if (!q) return { error: 'clientName required' };
      const { getCurrentEnterpriseId } = await import('@/lib/auth/enterprise');
      const { getEnterpriseClientHealth } = await import('@/lib/enterprise/client-health');
      const entId = await getCurrentEnterpriseId();
      if (!entId) return { error: 'No active enterprise.' };
      const health = await getEnterpriseClientHealth(entId, null);
      const c = health.clients.find(
        (x) => x.orgName?.toLowerCase().includes(q) || (x.ownerName ?? '').toLowerCase().includes(q),
      );
      if (!c) return { ok: false, note: `No client matching "${args.clientName}".` };
      return {
        ok: true,
        client: {
          orgId: c.orgId,
          name: c.orgName,
          owner: c.ownerName,
          brokenBankFeeds: c.brokenBankFeeds,
          onboardingIncomplete: c.onboardingIncomplete,
          toReview: c.toReview,
          reconOff: c.reconOff,
          overdueBills: c.overdueBills,
          overdueInvoices: c.overdueInvoices,
          openTasks: c.openTasks,
          needsAttentionCount: c.needsAttentionCount,
        },
      };
    }
    case 'open_client_books': {
      const orgId = String(args.orgId ?? '').trim();
      const q = String(args.clientName ?? '').trim().toLowerCase();
      const { getCurrentEnterpriseId } = await import('@/lib/auth/enterprise');
      const { getEnterpriseClientHealth } = await import('@/lib/enterprise/client-health');
      const entId = await getCurrentEnterpriseId();
      if (!entId) return { error: 'No active enterprise.' };
      const health = await getEnterpriseClientHealth(entId, null);
      let target = orgId ? health.clients.find((c) => c.orgId === orgId) : undefined;
      if (!target && q) {
        target = health.clients.find(
          (c) => c.orgName?.toLowerCase().includes(q) || (c.ownerName ?? '').toLowerCase().includes(q),
        );
      }
      if (!target) return { ok: false, note: 'Could not find that client company — ask which client, or list clients first.' };
      return {
        ok: true,
        opening: target.orgName,
        note: `Opening ${target.orgName}'s books — the in-books assistant takes over there.`,
        ...clientAction('open_client_books', { path: `/api/enterprise/open-books?org=${target.orgId}` }),
      };
    }
    case 'focus_client': {
      const orgId = String(args.orgId ?? '').trim();
      if (!orgId) return { error: 'orgId required' };
      return { ok: true, ...clientAction('spotlight_client', { orgId }) };
    }
    case 'generate_artifact': {
      const kind = String(args.kind ?? '').trim();
      const title = String(args.title ?? '').trim();
      const body = String(args.body ?? '').trim();
      const ALLOWED = new Set(['letter', 'email', 'text', 'resolution', 'deck']);
      if (!ALLOWED.has(kind)) return { error: `Unknown artifact kind "${kind}".` };
      if (!body) return { error: 'Refusing to render an empty draft.' };
      // The page renders it via the registered `render_artifact` client action;
      // the canvas holds it client-side for the user to edit (no DB write yet).
      return {
        ...clientAction('render_artifact', { kind, title, body }),
        ok: true,
        message: `Drafted the ${kind} on the canvas — the user can edit it there.`,
      };
    }

    case 'update_task_steps': {
      const taskId = String(args.task_id ?? '').trim();
      if (!taskId) return { error: 'Missing task_id (use task_id from page state).' };
      const rawSteps = Array.isArray(args.steps) ? args.steps : [];
      const confirm = args.confirm === true;
      const res = await replaceTaskSteps(taskId, rawSteps, confirm);
      if (!res.ok) return { error: res.error ?? 'Could not update the steps.' };
      // The dashboard re-renders the live checklist + (if confirmed) starts the
      // step drafting via this client action.
      return {
        ...clientAction('task_plan_updated', { taskId, steps: res.steps, confirmed: res.confirmed }),
        ok: true,
        confirmed: res.confirmed,
        message: res.confirmed ? 'Plan confirmed — starting on the steps.' : 'Updated the steps.',
      };
    }

    case 'save_deliverable': {
      const itemId = String(args.item_id ?? '').trim();
      const kind = String(args.kind ?? '').trim();
      const title = String(args.title ?? '').trim();
      const body = String(args.body ?? '').trim();
      const ALLOWED = new Set(['letter', 'email', 'resolution', 'deck']);
      if (!itemId) return { error: 'Missing item_id (use current_item.id from page state).' };
      if (!ALLOWED.has(kind)) return { error: `Unknown document kind "${kind}".` };
      if (!body) return { error: 'Refusing to save an empty document.' };

      const userId = await getEffectiveUserId();
      const res = await saveInteractiveDeliverable({
        organizationId: ctx.organizationId,
        userId,
        actionItemId: itemId,
        kind: kind as 'letter' | 'email' | 'resolution' | 'deck',
        title,
        body,
      });
      if (!res.ok) return { error: res.error ?? 'Could not save the deliverable.' };

      // Advance the client session (clear the canvas, move to the next item).
      return {
        ...clientAction('debrief_advance', { savedItemId: itemId, completed: res.completed }),
        ok: true,
        message: res.completed
          ? `Saved "${title}" to Documents. That was the last item — the debrief is complete.`
          : `Saved "${title}" to Documents. ${res.remaining} item${res.remaining === 1 ? '' : 's'} left.`,
      };
    }

    case 'find_contact': {
      const raw = String(args.query ?? '').trim();
      const limit = Math.min(10, Math.max(1, Number(args.limit ?? 5)));
      if (!raw) return { matches: [] };

      // Normalize: lowercase, replace & with " and ", strip everything that
      // isn't a letter/digit/space, collapse whitespace. Then tokenize and
      // drop common entity-suffix stopwords so "Grace and Love Trust" and
      // "Grace&Love" hash to the same token set.
      const STOPWORDS = new Set([
        'the', 'a', 'an', 'of',
        'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
        'ltd', 'limited', 'lp', 'pllc', 'pllc', 'pc',
        'trust', 'foundation', 'fund', 'group', 'holdings', 'holding',
      ]);
      const normalize = (s: string): string =>
        s
          .toLowerCase()
          .replace(/&/g, ' and ')
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      const tokens = (s: string): string[] =>
        normalize(s)
          .split(' ')
          .filter((t) => t.length > 0 && !STOPWORDS.has(t));

      const queryTokens = tokens(raw);
      if (queryTokens.length === 0) return { matches: [] };

      // Pull active contacts in the org (small enough — typically <500). Score
      // each by token overlap; tie-break by total contact name length so
      // shorter, more-specific names win.
      const all = await db
        .select({
          id: contacts.id,
          contactName: contacts.contactName,
          companyName: contacts.companyName,
        })
        .from(contacts)
        .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.isActive, true)));

      type Scored = {
        id: string;
        contactName: string;
        companyName: string | null;
        score: number;
        matchedTokens: string[];
      };
      const scored: Scored[] = [];
      for (const c of all) {
        const haystack = [c.contactName ?? '', c.companyName ?? ''].join(' ');
        const haystackTokens = new Set(tokens(haystack));
        const matched = queryTokens.filter((q) => haystackTokens.has(q));
        if (matched.length === 0) continue;
        // Score: fraction of query tokens that hit. Bonus if ALL matched.
        const score = matched.length / queryTokens.length;
        scored.push({
          id: c.id,
          contactName: c.contactName ?? '',
          companyName: c.companyName ?? null,
          score,
          matchedTokens: matched,
        });
      }

      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.contactName.length - b.contactName.length;
      });

      return {
        query: raw,
        normalizedTokens: queryTokens,
        matches: scored.slice(0, limit).map((s) => ({
          id: s.id,
          name: s.contactName,
          companyName: s.companyName,
          score: Math.round(s.score * 100) / 100,
          matchedTokens: s.matchedTokens,
        })),
      };
    }

    case 'create_chart_account': {
      const accountName = String(args.accountName ?? '').trim();
      const gaapType = String(args.gaapType ?? '').trim();
      const accountType = String(args.accountType ?? '').trim();
      const detailType = String(args.detailType ?? '').trim();
      const parentAccountNumber =
        typeof args.parentAccountNumber === 'string' ? args.parentAccountNumber.trim() : '';
      const explicitNumber =
        typeof args.accountNumber === 'string' ? args.accountNumber.trim() : '';

      if (!accountName) return { error: 'accountName required' };
      if (!(GAAP_TYPES as readonly string[]).includes(gaapType)) {
        return { error: `gaapType must be one of: ${GAAP_TYPES.join(', ')}` };
      }
      const triple = validateCoaTriple({ gaapType, accountType, detailType });
      if (triple) return { error: `Invalid taxonomy: ${triple}` };
      const at = getAccountType(accountType);
      if (!at) return { error: `Unknown account_type: ${accountType}` };

      // Reject duplicate (org, gaap_type, detail_type) — schema enforces it
      // anyway, but a friendlier error here keeps the AI from looping.
      const [dup] = await db
        .select({ id: chartOfAccounts.id, accountName: chartOfAccounts.accountName })
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.organizationId, ctx.organizationId),
            eq(chartOfAccounts.gaapType, gaapType),
            eq(chartOfAccounts.detailType, detailType),
          ),
        )
        .limit(1);
      if (dup) {
        // Help the AI recover. Two angles: list unused details within the
        // CHOSEN account_type (preferred — least surprise), and also list
        // every existing account in the same gaap_type so the AI can fall
        // back to one of those if no unused detail fits semantically.
        const usedDetails = new Set(
          (
            await db
              .select({ detailType: chartOfAccounts.detailType })
              .from(chartOfAccounts)
              .where(
                and(
                  eq(chartOfAccounts.organizationId, ctx.organizationId),
                  eq(chartOfAccounts.accountType, accountType),
                ),
              )
          )
            .map((r) => r.detailType)
            .filter((d): d is string => !!d),
        );
        const alternativeDetailTypes = at.details
          .filter((d) => !usedDetails.has(d.slug))
          .map((d) => ({ slug: d.slug, label: d.label }));

        // Existing accounts in this gaap_type — the AI should fall back to
        // one of these (via categorize_transaction_ids using the .id) if
        // no unused detail_type semantically fits the user's intent.
        const existingInGaapType = await db
          .select({
            id: chartOfAccounts.id,
            accountNumber: chartOfAccounts.accountNumber,
            accountName: chartOfAccounts.accountName,
            accountType: chartOfAccounts.accountType,
            detailType: chartOfAccounts.detailType,
          })
          .from(chartOfAccounts)
          .where(
            and(
              eq(chartOfAccounts.organizationId, ctx.organizationId),
              eq(chartOfAccounts.gaapType, gaapType),
              eq(chartOfAccounts.isActive, true),
            ),
          );

        // Other account_types in the same gaap_type that have unused details
        // available — for users who want a category that doesn't fit the
        // chosen account_type.
        const otherAccountTypes = accountTypesForGaap(gaapType as GaapType)
          .filter((t) => t.slug !== accountType)
          .map((t) => ({ slug: t.slug, label: t.label }));

        return {
          error: `An account with detail_type="${detailType}" already exists in this org.`,
          existing: { id: dup.id, accountName: dup.accountName },
          alternativeDetailTypes,
          otherAccountTypes,
          existingAccountsInGaapType: existingInGaapType,
          hint:
            "Don't loop on create_chart_account. Try ONCE more with an unused detail_type that semantically fits. If none fit, USE one of the existingAccountsInGaapType ids with categorize_transaction_ids — for example, IP licensing payments fit into Legal & Professional Fees if no royalties slot exists.",
        };
      }

      // Resolve optional parent account number → id (org-scoped).
      let parentId: string | null = null;
      if (parentAccountNumber) {
        const [p] = await db
          .select({ id: chartOfAccounts.id })
          .from(chartOfAccounts)
          .where(
            and(
              eq(chartOfAccounts.organizationId, ctx.organizationId),
              eq(chartOfAccounts.accountNumber, parentAccountNumber),
            ),
          )
          .limit(1);
        if (!p) return { error: `parentAccountNumber "${parentAccountNumber}" not found in this organization.` };
        parentId = p.id;
      }

      // Pick an account number if the AI didn't supply one. Convention:
      //   asset 1xxx, liability 2xxx, equity 3xxx, income 4xxx, expense 5xxx.
      // Find the highest existing number in that prefix, add 10. Falls back
      // to <prefix>000 + 10 if there are no rows yet.
      const prefixDigit: Record<GaapType, string> = {
        asset: '1',
        liability: '2',
        equity: '3',
        income: '4',
        expense: '5',
      };
      let chosenNumber = explicitNumber;
      if (!chosenNumber) {
        const prefix = prefixDigit[gaapType as GaapType];
        const existing = await db
          .select({ accountNumber: chartOfAccounts.accountNumber })
          .from(chartOfAccounts)
          .where(
            and(
              eq(chartOfAccounts.organizationId, ctx.organizationId),
              ilike(chartOfAccounts.accountNumber, `${prefix}%`),
            ),
          );
        let max = parseInt(`${prefix}000`, 10);
        for (const e of existing) {
          const n = parseInt(e.accountNumber, 10);
          if (Number.isFinite(n) && n >= max && n < parseInt(`${prefix}999`, 10)) {
            max = n;
          }
        }
        chosenNumber = String(max + 10);
      } else {
        // Avoid collision on caller-supplied number.
        const [collision] = await db
          .select({ id: chartOfAccounts.id })
          .from(chartOfAccounts)
          .where(
            and(
              eq(chartOfAccounts.organizationId, ctx.organizationId),
              eq(chartOfAccounts.accountNumber, explicitNumber),
            ),
          )
          .limit(1);
        if (collision) return { error: `accountNumber "${explicitNumber}" is already in use.` };
      }

      const newId = randomUUID();
      await db.insert(chartOfAccounts).values({
        id: newId,
        organizationId: ctx.organizationId,
        accountNumber: chosenNumber,
        accountName,
        gaapType,
        accountType,
        detailType,
        parentAccountId: parentId,
        normalBalance: at.normalBalance,
        isActive: true,
        isTemporary: false,
        createdByAi: true,
        systemGenerated: false,
        needsReview: false,
        passedNameContactCheck: true,
      });
      logger.info(
        { orgId: ctx.organizationId, accountName, gaapType, accountType, detailType, accountNumber: chosenNumber },
        'create_chart_account: AI created CoA row',
      );
      return {
        ok: true,
        account: {
          id: newId,
          accountNumber: chosenNumber,
          accountName,
          gaapType,
          accountType,
          detailType,
          normalBalance: at.normalBalance,
          parentAccountId: parentId,
        },
        hint: 'You can now use this account.id with categorize_transaction_ids or categorize_filtered_transactions.',
      };
    }

    case 'navigate': {
      const destination = String(args.destination ?? '').trim();
      const path = NAVIGATION_DESTINATIONS[destination];
      if (!path) {
        return {
          error: `Unknown destination "${destination}". Choose one of: ${Object.keys(NAVIGATION_DESTINATIONS).join(', ')}`,
        };
      }
      // If this page is the org's current incomplete onboarding step (e.g. bank
      // connection while still onboarding), send them into the onboarding wizard.
      const resolved = await onboardingAwarePath(ctx.organizationId, path);
      const workflow = WORKFLOW_GUIDES[resolved];
      return {
        ok: true,
        destination,
        path: resolved,
        // Present only for multi-step pages — tells the assistant to walk the
        // client through rather than just confirm the navigation.
        ...(workflow ? { workflow } : {}),
        ...clientAction('navigate', { path: resolved }),
      };
    }

    case 'find_transfer_counterpart': {
      const id = String(args.transactionId ?? '').trim();
      if (!id) return { error: 'transactionId required' };
      const [tx] = (await db.execute(sql`
        select amount, date, account_id, type
        from transactions where id = ${id} and organization_id = ${ctx.organizationId} limit 1
      `)) as unknown as Array<Record<string, unknown>>;
      if (!tx) return { error: 'Transaction not found in this organization' };
      const amount = Math.abs(Number(tx.amount ?? 0));
      const rows = (await db.execute(sql`
        select t.id, t.date, t.amount, t.type,
               coalesce(t.bank_description, t.description) as descr,
               a.account_name as account_name
        from transactions t
        left join chart_of_accounts a on a.id = t.account_id
        where t.organization_id = ${ctx.organizationId}
          and t.id <> ${id}
          and t.account_id is distinct from ${tx.account_id}
          and t.type <> ${tx.type}
          and abs(t.amount) = ${amount}
          and t.date between (${tx.date}::date - interval '5 days') and (${tx.date}::date + interval '5 days')
        order by abs(t.date - ${tx.date}::date)
        limit 5
      `)) as unknown as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        return {
          ok: true,
          found: false,
          message: 'No matching outgoing transaction on another account within 5 days — this may not be an internal transfer.',
        };
      }
      return {
        ok: true,
        found: true,
        counterparts: rows.map((r) => ({
          id: String(r.id),
          date: String(r.date),
          amount: Number(r.amount),
          sourceAccount: r.account_name ? String(r.account_name) : null,
          description: r.descr ? String(r.descr) : null,
        })),
        hint: 'A match means this is an internal transfer — do NOT post income. Tell the user which account it came from.',
      };
    }

    case 'find_matching_invoice': {
      const id = String(args.transactionId ?? '').trim();
      if (!id) return { error: 'transactionId required' };
      const [tx] = (await db.execute(sql`
        select t.amount, t.contact_id, c.contact_name
        from transactions t left join contacts c on c.id = t.contact_id
        where t.id = ${id} and t.organization_id = ${ctx.organizationId} limit 1
      `)) as unknown as Array<Record<string, unknown>>;
      if (!tx) return { error: 'Transaction not found in this organization' };
      const amount = Math.abs(Number(tx.amount ?? 0));
      const contactId = tx.contact_id ? String(tx.contact_id) : null;
      const outstanding = await getOutstandingInvoices(ctx.organizationId);
      const scoped = contactId ? outstanding.filter((i) => i.contactId === contactId) : outstanding;
      const exact = scoped.filter((i) => Math.abs(i.balance - amount) < 0.01);
      const close = scoped.filter((i) => Math.abs(i.balance - amount) <= Math.max(1, amount * 0.02));
      const chosen = exact.length > 0 ? exact : close;
      if (chosen.length === 0) {
        return {
          ok: true,
          found: false,
          message: contactId
            ? 'No open invoice for this customer matches the deposit amount.'
            : 'This transaction has no contact set — assign one first, or there are no matching open invoices.',
        };
      }
      return {
        ok: true,
        found: true,
        invoices: chosen.slice(0, 5).map((i) => ({
          id: i.id,
          invoiceNumber: i.invoiceNumber,
          balance: i.balance,
          dueDate: i.dueDate,
          customerName: i.customerName,
        })),
        hint: 'A match means this deposit is a payment against that invoice (reduces A/R), not fresh income. Confirm with the user before booking.',
      };
    }

    case 'restore_view': {
      const url = String(args.url ?? '').trim();
      if (!url.startsWith('/transactions')) {
        return { error: 'restore_view only supports /transactions URLs' };
      }
      return { ok: true, message: 'Taking you back to where you were.', ...clientAction('navigate', { path: url }) };
    }

    case 'fill_substantiation_card': {
      // Relay the extracted IRS fields to the card (client-side, unsaved — the user
      // reviews + Saves). Sanitize: keep string values only, drop blanks.
      const transactionId = typeof args.transactionId === 'string' ? args.transactionId : '';
      const raw = args.fields && typeof args.fields === 'object' ? (args.fields as Record<string, unknown>) : {};
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (v != null && String(v).trim()) fields[k] = String(v).trim();
      }
      const n = Object.keys(fields).length;
      if (!transactionId || n === 0) {
        return { ok: false, message: 'Nothing to fill yet — ask the user for the details first.' };
      }
      return {
        ...clientAction('fill_substantiation_card', { transactionId, fields }),
        ok: true,
        message: `Filled ${n} field${n === 1 ? '' : 's'} on the card — ask the user to review and Save.`,
      };
    }

    case 'save_substantiation_card': {
      const transactionId = typeof args.transactionId === 'string' ? args.transactionId : '';
      const docType = typeof args.docType === 'string' ? (args.docType as DocType) : undefined;
      const raw = args.fields && typeof args.fields === 'object' ? (args.fields as Record<string, unknown>) : {};
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (v != null && String(v).trim()) fields[k] = String(v).trim();
      }
      if (!transactionId || !docType) {
        return { ok: false, message: 'Missing transaction or documentation type.' };
      }
      const saved = await saveSubstantiationFields(ctx.organizationId, transactionId, docType, fields);
      if (!saved.ok) {
        return { ok: false, message: saved.error ?? 'Could not save.' };
      }
      const next = await getNextSubstantiationTarget(ctx.organizationId, transactionId);
      return {
        ...clientAction('substantiation_saved', { transactionId, next }),
        ok: true,
        saved: saved.status,
        next,
        message: next
          ? `Saved. Next up: a ${next.docLabel.toLowerCase()} — ${next.description ?? 'transaction'}. Ask the user about it.`
          : 'Saved — that was the last one. Everything is documented. Let the user know.',
      };
    }

    case 'apply_transactions_filters': {
      // The client applies the URL change. We also compute count + signed
      // total against the same conditions the list page uses, so the AI's
      // follow-up message ("Filtered to X — N transactions, $Y") quotes
      // real numbers instead of guessing.
      const contactId = typeof args.contactId === 'string' && args.contactId.trim() ? args.contactId.trim() : null;
      const categoryId = typeof args.categoryId === 'string' && args.categoryId.trim() ? args.categoryId.trim() : null;
      const accountId = typeof args.accountId === 'string' && args.accountId.trim() ? args.accountId.trim() : null;
      const startDate = typeof args.start === 'string' && args.start.trim() ? args.start.trim() : null;
      const endDate = typeof args.end === 'string' && args.end.trim() ? args.end.trim() : null;
      const q = typeof args.q === 'string' && args.q.trim() ? args.q.trim() : null;
      const filter =
        typeof args.filter === 'string' && ['all', 'to_review', 'reviewed', 'uncategorized', 'unposted'].includes(args.filter)
          ? (args.filter as 'all' | 'to_review' | 'reviewed' | 'uncategorized' | 'unposted')
          : 'all';

      const conditions = [eq(transactions.organizationId, ctx.organizationId)];
      if (filter === 'uncategorized') conditions.push(isNull(transactions.categoryAccountId));
      if (filter === 'unposted') conditions.push(isNull(transactions.journalEntryId));
      if (filter === 'reviewed') conditions.push(eq(transactions.reviewed, true));
      if (filter === 'to_review') {
        conditions.push(or(eq(transactions.reviewed, false), isNull(transactions.reviewed))!);
      }
      if (q) {
        const search = `%${q}%`;
        conditions.push(
          or(
            ilike(transactions.description, search),
            ilike(transactions.bankDescription, search),
            ilike(transactions.userDescription, search),
          )!,
        );
      }
      if (accountId) conditions.push(eq(transactions.accountId, accountId));
      if (categoryId) conditions.push(eq(transactions.categoryAccountId, categoryId));
      if (contactId) conditions.push(eq(transactions.contactId, contactId));
      if (startDate) conditions.push(gte(transactions.date, startDate));
      if (endDate) conditions.push(lte(transactions.date, endDate));

      const [agg] = await db
        .select({ n: count(), total: sum(transactions.amount) })
        .from(transactions)
        .where(and(...conditions));
      const countN = Number(agg?.n ?? 0);
      const totalN = Number(agg?.total ?? 0);

      let contactName: string | null = null;
      if (contactId) {
        const [c] = await db
          .select({ name: contacts.contactName })
          .from(contacts)
          .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, ctx.organizationId)))
          .limit(1);
        contactName = c?.name ?? null;
      }

      const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
      const totalDisplay = fmt.format(Math.abs(totalN));
      const signedTotalDisplay = totalN < 0 ? `-${totalDisplay}` : totalDisplay;
      const noun = countN === 1 ? 'transaction' : 'transactions';
      const subject = contactName ?? 'matching transactions';
      const message =
        countN === 0
          ? `No transactions match those filters.`
          : `Filtered to ${subject} — ${countN} ${noun}, ${signedTotalDisplay}.`;

      return {
        ok: true,
        count: countN,
        total: totalN,
        totalFormatted: signedTotalDisplay,
        contactName,
        message,
        ...clientAction('apply_transactions_filters', args),
      };
    }

    case 'open_transaction': {
      const transactionId = String(args.transactionId ?? '').trim();
      if (!transactionId) return { error: 'transactionId required' };
      // Org-scope check so we don't navigate to a sibling-org's id.
      const [hit] = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.id, transactionId), eq(transactions.organizationId, ctx.organizationId)))
        .limit(1);
      if (!hit) return { error: 'Transaction not found' };
      if (args.split === true) {
        return {
          ok: true,
          message: 'Opening the split screen — tell me what each portion is for.',
          ...clientAction('navigate', { path: `/transactions/${transactionId}?mode=split` }),
        };
      }
      return { ok: true, ...clientAction('open_transaction', { transactionId }) };
    }

    case 'start_guided_review': {
      const which = String(args.which ?? '') as keyof typeof GUIDED_REVIEW_URLS;
      const url = GUIDED_REVIEW_URLS[which];
      if (!url) return { error: "Unknown review — use 'deposits', 'ai_categorized', or 'uncategorized'." };
      return { ok: true, ...clientAction('navigate', { path: url }) };
    }

    case 'find_transactions_for_categorization': {
      const limit = Math.min(200, Math.max(1, Number(args.limit ?? 50)));
      const conditions = [eq(transactions.organizationId, ctx.organizationId)];

      if (typeof args.contactId === 'string' && args.contactId.trim()) {
        conditions.push(eq(transactions.contactId, args.contactId.trim()));
      } else if (typeof args.contactName === 'string' && args.contactName.trim()) {
        // Resolve by partial name. Picks the first match — caller should use
        // lookup_contact for explicit disambiguation.
        const [c] = await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.organizationId, ctx.organizationId),
              ilike(contacts.contactName, `%${args.contactName.trim()}%`),
            ),
          )
          .limit(1);
        if (!c) return { error: `No contact matching "${args.contactName}"` };
        conditions.push(eq(transactions.contactId, c.id));
      }
      if (typeof args.q === 'string' && args.q.trim()) {
        const search = `%${args.q.trim()}%`;
        conditions.push(
          or(
            ilike(transactions.description, search),
            ilike(transactions.bankDescription, search),
          )!,
        );
      }
      if (args.uncategorizedOnly === true) conditions.push(isNull(transactions.categoryAccountId));
      if (args.unreviewedOnly === true) {
        conditions.push(or(eq(transactions.reviewed, false), isNull(transactions.reviewed))!);
      }
      if (typeof args.start === 'string' && args.start.trim()) {
        conditions.push(sql`${transactions.date} >= ${args.start.trim()}`);
      }
      if (typeof args.end === 'string' && args.end.trim()) {
        conditions.push(sql`${transactions.date} <= ${args.end.trim()}`);
      }

      const rows = await db
        .select({
          id: transactions.id,
          date: transactions.date,
          description: transactions.description,
          bankDescription: transactions.bankDescription,
          amount: transactions.amount,
          type: transactions.type,
          contactId: transactions.contactId,
          categoryAccountId: transactions.categoryAccountId,
        })
        .from(transactions)
        .where(and(...conditions))
        .limit(limit);

      return {
        count: rows.length,
        transactions: rows.map((r) => ({
          id: r.id,
          date: r.date,
          memo: r.bankDescription ?? r.description,
          amount: r.amount,
          type: r.type,
          uncategorized: r.categoryAccountId === null,
        })),
      };
    }

    case 'categorize_transaction_ids': {
      const ids = Array.isArray(args.transactionIds) ? args.transactionIds.filter((x): x is string => typeof x === 'string') : [];
      const candidate = String(args.categoryAccountId ?? '').trim();
      if (ids.length === 0) return { error: 'transactionIds is empty' };
      if (!candidate) return { error: 'categoryAccountId required' };

      // Tolerate id / accountNumber / exact accountName via the shared resolver.
      // The model sometimes passes the name even when explicitly told to use
      // the id — this hardening matches the realtime tool dispatcher.
      const resolved = await resolveAccount(ctx.organizationId, candidate);
      if (!resolved) {
        // Final fallback: partial-name match against the org's CoA. Return up
        // to 5 suggestions so the AI can confirm with the user instead of
        // dead-ending with "not in your organization".
        const suggestions = await db
          .select({
            id: chartOfAccounts.id,
            accountNumber: chartOfAccounts.accountNumber,
            accountName: chartOfAccounts.accountName,
          })
          .from(chartOfAccounts)
          .where(
            and(
              eq(chartOfAccounts.organizationId, ctx.organizationId),
              eq(chartOfAccounts.isActive, true),
              ilike(chartOfAccounts.accountName, `%${candidate}%`),
            ),
          )
          .limit(5);
        return {
          error: `No active CoA account matched "${candidate}".`,
          suggestions: suggestions.map((s) => ({
            id: s.id,
            accountNumber: s.accountNumber,
            accountName: s.accountName,
          })),
          hint:
            suggestions.length > 0
              ? 'Re-call categorize_transaction_ids with one of the suggestion ids.'
              : 'Call list_accounts to fetch the full chart and pick from there.',
        };
      }
      if (resolved.resolvedVia !== 'id') {
        logger.info(
          { tool: 'categorize_transaction_ids', candidate, resolvedVia: resolved.resolvedVia, resolvedToId: resolved.id },
          'category resolved via fallback',
        );
      }
      const categoryAccountId = resolved.id;

      let posted = 0;
      let updated = 0;
      let skipped = 0;
      const errors: string[] = [];
      for (const id of ids) {
        const result = await categorizeTransaction({
          organizationId: ctx.organizationId,
          transactionId: id,
          categoryAccountId,
        });
        if (!result.ok) {
          skipped++;
          if (errors.length < 3) errors.push(`${id}: ${result.error}`);
          logger.warn({ txnId: id, err: result.error }, 'page-tool categorize: skip');
        } else if (result.mode === 'posted') {
          posted++;
        } else {
          updated++;
        }
      }

      // Verify-flow correction: recategorizing a group the user said was wrong
      // also marks it human-verified, so it leaves the to_verify queue + advances.
      let verified = 0;
      if (args.markVerified === true && posted + updated > 0) {
        const done = await db
          .update(transactions)
          .set({ verified: true })
          .where(and(eq(transactions.organizationId, ctx.organizationId), inArray(transactions.id, ids)))
          .returning({ id: transactions.id });
        verified = done.length;
      }

      return {
        ok: true,
        accountName: resolved.accountName,
        posted,
        updated,
        skipped,
        verified: verified || undefined,
        errors: errors.length > 0 ? errors : undefined,
        // Refresh the visible list so the user sees the new category labels.
        ...clientAction('refresh_page', {}),
      };
    }

    case 'create_categorization_rule': {
      const pattern = String(args.pattern ?? '').trim();
      const candidate = String(args.categoryAccountId ?? '').trim();
      const transactionType =
        args.transactionType === 'deposit' || args.transactionType === 'withdrawal' ? args.transactionType : null;
      if (!pattern || !candidate) return { error: 'pattern and categoryAccountId are required' };
      const resolved = await resolveAccount(ctx.organizationId, candidate);
      if (!resolved) {
        return { error: `No active CoA account matched "${candidate}".`, hint: 'Call list_accounts and retry with the right id.' };
      }
      const promoted = await promoteRule(ctx.organizationId, pattern, resolved.id, transactionType);
      if (!promoted.ok) return { error: promoted.error ?? 'Could not create the rule' };
      // Mark all existing matching transactions verified, scoped to the rule's direction.
      const updated = (await db.execute(sql`
        update transactions set verified = true
        where organization_id = ${ctx.organizationId} and id in (
          select t.id from transactions t
          left join contacts c on c.id = t.contact_id
          where t.organization_id = ${ctx.organizationId}
            and (${transactionType}::text is null or t.type = ${transactionType})
            and lower(coalesce(c.contact_name, t.bank_description, t.description)) like '%' || lower(${pattern}) || '%'
        )
        returning id
      `)) as unknown as Array<unknown>;
      const verifiedCount = Array.isArray(updated) ? updated.length : 0;
      return {
        ok: true,
        rule: `${pattern} → ${resolved.accountName}${transactionType ? ` (${transactionType}s)` : ''}`,
        verified: verifiedCount,
        message: `Rule created${transactionType ? ` for ${transactionType}s` : ''} — "${pattern}" will auto-categorize to ${resolved.accountName}. ${verifiedCount} matching transaction${verifiedCount === 1 ? '' : 's'} marked reviewed.`,
        ...clientAction('refresh_page', {}),
      };
    }

    case 'verify_transaction_ids': {
      const ids = Array.isArray(args.transactionIds)
        ? args.transactionIds.filter((x): x is string => typeof x === 'string')
        : [];
      if (ids.length === 0) return { error: 'transactionIds is empty' };
      await db
        .update(transactions)
        .set({ verified: true })
        .where(and(eq(transactions.organizationId, ctx.organizationId), inArray(transactions.id, ids)));
      // Same post-verify suggestions as the manual green check: a pending rule
      // for the merchant, else aligning the rest of the contact's same-direction txns.
      const first = ids[0];
      const pendingRule = await pendingRuleForTransaction(ctx.organizationId, first);
      const pendingContact = pendingRule ? null : await pendingContactCategorization(ctx.organizationId, first);
      return {
        ok: true,
        verified: ids.length,
        pendingRule: pendingRule ?? undefined,
        pendingContact: pendingContact ?? undefined,
        message: `Marked ${ids.length} transaction${ids.length === 1 ? '' : 's'} verified.`,
        ...clientAction('refresh_page', {}),
      };
    }

    case 'categorize_filtered_transactions': {
      const candidate = String(args.categoryAccountId ?? '').trim();
      if (!candidate) return { error: 'categoryAccountId required' };

      const resolved = await resolveAccount(ctx.organizationId, candidate);
      if (!resolved) {
        const suggestions = await db
          .select({
            id: chartOfAccounts.id,
            accountNumber: chartOfAccounts.accountNumber,
            accountName: chartOfAccounts.accountName,
          })
          .from(chartOfAccounts)
          .where(
            and(
              eq(chartOfAccounts.organizationId, ctx.organizationId),
              eq(chartOfAccounts.isActive, true),
              ilike(chartOfAccounts.accountName, `%${candidate}%`),
            ),
          )
          .limit(5);
        return {
          error: `No active CoA account matched "${candidate}".`,
          suggestions,
          hint:
            suggestions.length > 0
              ? 'Re-call with one of the suggestion ids.'
              : 'Call list_accounts and try again with the right id.',
        };
      }

      // Build the WHERE that mirrors the transactions page's filter pills.
      // At least one filter is required to avoid "categorize everything".
      const conditions = [eq(transactions.organizationId, ctx.organizationId)];
      let hasFilter = false;
      if (typeof args.contactId === 'string' && args.contactId.trim()) {
        conditions.push(eq(transactions.contactId, args.contactId.trim()));
        hasFilter = true;
      }
      if (typeof args.accountId === 'string' && args.accountId.trim()) {
        conditions.push(eq(transactions.accountId, args.accountId.trim()));
        hasFilter = true;
      }
      if (typeof args.categoryId === 'string' && args.categoryId.trim()) {
        conditions.push(eq(transactions.categoryAccountId, args.categoryId.trim()));
        hasFilter = true;
      }
      if (typeof args.q === 'string' && args.q.trim()) {
        const search = `%${args.q.trim()}%`;
        conditions.push(
          or(
            ilike(transactions.description, search),
            ilike(transactions.bankDescription, search),
          )!,
        );
        hasFilter = true;
      }
      if (typeof args.start === 'string' && args.start.trim()) {
        conditions.push(sql`${transactions.date} >= ${args.start.trim()}`);
        hasFilter = true;
      }
      if (typeof args.end === 'string' && args.end.trim()) {
        conditions.push(sql`${transactions.date} <= ${args.end.trim()}`);
        hasFilter = true;
      }
      if (args.uncategorizedOnly === true) {
        conditions.push(isNull(transactions.categoryAccountId));
        hasFilter = true;
      }
      if (args.unreviewedOnly === true) {
        conditions.push(or(eq(transactions.reviewed, false), isNull(transactions.reviewed))!);
        hasFilter = true;
      }
      if (!hasFilter) {
        return {
          error: 'At least one filter is required so the entire org is not categorized at once.',
        };
      }

      const cap = Math.min(2000, Math.max(1, Number(args.maxRows ?? 200)));
      const rows = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(...conditions))
        .limit(cap);

      if (rows.length === 0) {
        return { ok: true, posted: 0, updated: 0, skipped: 0, accountName: resolved.accountName };
      }
      if (rows.length === cap) {
        // Hit the cap — surface that fact so the AI can warn the user there
        // are more rows that didn't get categorized.
        logger.info({ cap, candidate }, 'categorize_filtered_transactions hit row cap');
      }

      let posted = 0;
      let updated = 0;
      let skipped = 0;
      const errors: string[] = [];
      for (const r of rows) {
        const result = await categorizeTransaction({
          organizationId: ctx.organizationId,
          transactionId: r.id,
          categoryAccountId: resolved.id,
        });
        if (!result.ok) {
          skipped++;
          if (errors.length < 3) errors.push(`${r.id}: ${result.error}`);
        } else if (result.mode === 'posted') {
          posted++;
        } else {
          updated++;
        }
      }

      // Categorizing via the AI is a human-confirmed action (the user okayed it
      // in chat), so mark the affected rows human-verified too.
      await db
        .update(transactions)
        .set({ verified: true })
        .where(
          and(
            eq(transactions.organizationId, ctx.organizationId),
            inArray(
              transactions.id,
              rows.map((r) => r.id),
            ),
          ),
        );

      return {
        ok: true,
        accountName: resolved.accountName,
        matched: rows.length,
        capReached: rows.length === cap,
        posted,
        updated,
        skipped,
        errors: errors.length > 0 ? errors : undefined,
        ...clientAction('refresh_page', {}),
      };
    }

    case 'set_contact_for_transactions': {
      const ids = Array.isArray(args.transactionIds) ? args.transactionIds.filter((x): x is string => typeof x === 'string') : [];
      const contactIdRaw = args.contactId;
      const contactId =
        contactIdRaw === null || contactIdRaw === undefined || contactIdRaw === ''
          ? null
          : String(contactIdRaw);

      if (ids.length === 0) return { error: 'transactionIds is empty' };

      if (contactId) {
        const [c] = await db
          .select({ id: contacts.id, name: contacts.contactName })
          .from(contacts)
          .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, ctx.organizationId)))
          .limit(1);
        if (!c) return { error: 'Contact not in this organization' };
      }

      const updatedRows = await db
        .update(transactions)
        .set({ contactId })
        .where(
          and(
            eq(transactions.organizationId, ctx.organizationId),
            inArray(transactions.id, ids),
          ),
        )
        .returning({ id: transactions.id });

      // Propagate the new contact down to the JE / JE lines / GL so the
      // journal-entry detail page and reports stay in sync. Metadata-only —
      // doesn't touch debits/credits.
      const propagation = await propagateTransactionMetadataToJE({
        organizationId: ctx.organizationId,
        transactionIds: updatedRows.map((r) => r.id),
      });

      return {
        ok: true,
        updated: updatedRows.length,
        cleared: contactId === null,
        glRowsUpdated: propagation.updatedGlRows,
        journalEntryLinesUpdated: propagation.updatedLines,
        ...clientAction('refresh_page', {}),
      };
    }

    default:
      return { error: `Unknown page tool: ${name}` };
  }
}
