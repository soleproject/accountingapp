/**
 * Tool schemas exposed to the OpenAI Realtime AI.
 * These let the voice assistant query data and create invoices conversationally.
 */
export const REALTIME_TOOLS = [
  {
    type: 'function' as const,
    name: 'lookup_contact',
    description:
      'Find a customer or vendor by name in the current organization. Returns matches with id and name. Always call this before creating a new contact to avoid duplicates.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name to search for (case-insensitive partial match)' },
      },
      required: ['name'],
    },
  },
  {
    type: 'function' as const,
    name: 'create_contact',
    description:
      "Create a new contact when lookup_contact returns no matches. role is 'customer' for someone who pays the company, 'vendor' for someone the company pays.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        role: { type: 'string', enum: ['customer', 'vendor'] },
        email: { type: 'string' },
        phone: { type: 'string' },
      },
      required: ['name', 'role'],
    },
  },
  {
    type: 'function' as const,
    name: 'list_revenue_accounts',
    description:
      'List the chart-of-accounts entries that are valid revenue accounts (income / sales / fees). Use these for invoice line items. Also returns AR account candidates.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function' as const,
    name: 'save_invoice_draft',
    description:
      'Create or update a draft invoice. Each call replaces the entire draft state, so always include the full current line list. Returns { draftId, total, lines, contact } that the UI uses to render a live preview. Call this every time the user changes anything (adds a line, edits price, changes due date, etc.).',
    parameters: {
      type: 'object',
      properties: {
        draftId: {
          type: 'string',
          description: 'Existing draft to update. Omit on first call; the response will give you a draftId to use on subsequent calls.',
        },
        contactId: { type: 'string', description: 'Customer contact id (from lookup_contact or create_contact)' },
        invoiceDate: { type: 'string', description: 'YYYY-MM-DD' },
        dueDate: { type: 'string', description: 'YYYY-MM-DD (optional)' },
        invoiceNumber: { type: 'string', description: 'Optional human-readable number' },
        memo: { type: 'string' },
        arAccountId: { type: 'string', description: "AR account id (from list_revenue_accounts.ar). If omitted, the first AR candidate is used." },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unitPrice: { type: 'number' },
              revenueAccountId: { type: 'string', description: 'Revenue account id (from list_revenue_accounts.revenue)' },
            },
            required: ['description', 'quantity', 'unitPrice', 'revenueAccountId'],
          },
        },
      },
      required: ['contactId', 'invoiceDate', 'lines'],
    },
  },
  {
    type: 'function' as const,
    name: 'post_invoice',
    description:
      "Finalize a draft invoice — posts a journal entry (debit AR, credit revenue grouped per line). Only call after the user confirms they're ready to post.",
    parameters: {
      type: 'object',
      properties: { draftId: { type: 'string' } },
      required: ['draftId'],
    },
  },
  {
    type: 'function' as const,
    name: 'cancel_invoice_draft',
    description: 'Cancel and delete a draft invoice if the user changes their mind before posting.',
    parameters: {
      type: 'object',
      properties: { draftId: { type: 'string' } },
      required: ['draftId'],
    },
  },
  {
    type: 'function' as const,
    name: 'get_onboarding_status',
    description:
      'Get the current state of onboarding for this business: which phase the user is on (business_info → quickbooks → plaid → bank_statements → receipts → review → complete), and signal counts (whether business info is filled, how many plaid accounts are linked, how many bank statements imported, how many receipts uploaded). Call this at the start of any onboarding-related conversation, and after every state-changing tool call.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function' as const,
    name: 'set_business_info',
    description:
      'Save the business name, description, and optionally entity type and beneficiary roster. The first save automatically advances the onboarding phase from business_info to quickbooks (also requires entity_type to be set when the org\'s Enterprise has entity-type onboarding enabled).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The legal or doing-business-as name of the business' },
        description: { type: 'string', description: 'A short description of what the business does (1-3 sentences)' },
        entity_type: {
          type: 'string',
          enum: ['llc', 'c_corp', 's_corp', 'partnership', 'sole_prop', 'beneficial_trust', 'business_trust', 'nonprofit', 'other'],
          description: 'Only set when the org\'s Enterprise has entity_type_onboarding_enabled. Picking beneficial_trust or business_trust activates the matching trust-accounting feature pack.',
        },
        beneficiaries: {
          type: 'array',
          description: 'Required when entity_type=beneficial_trust. Each item describes one trust beneficiary.',
          items: {
            type: 'object',
            properties: {
              full_name: { type: 'string' },
              date_of_birth: { type: 'string', description: 'ISO date YYYY-MM-DD' },
              is_incapacitated: { type: 'boolean' },
              relationship: { type: 'string', description: 'Relationship to the grantor (e.g. son, daughter, grandchild)' },
            },
            required: ['full_name'],
          },
        },
      },
      required: [],
    },
  },
  {
    type: 'function' as const,
    name: 'advance_onboarding',
    description:
      "Move onboarding to the next phase, or jump to a specific phase. Use to: 'next' to advance one step, or set to: '<phase_name>' to jump. Phases: business_info, quickbooks, plaid, bank_statements, receipts, review, complete. Call advance_onboarding({ to: 'complete' }) when the user finishes the review step.",
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          enum: ['next', 'business_info', 'quickbooks', 'plaid', 'bank_statements', 'receipts', 'review', 'complete'],
        },
      },
      required: [],
    },
  },
  {
    type: 'function' as const,
    name: 'query_transactions',
    description:
      "Query and DISPLAY transactions to the user as a live table panel. Call this whenever the user asks to see / show / list / find transactions matching any criteria. The result returns rows + totals which the UI renders right next to the chat. Don't read every row aloud — summarize verbally (e.g. \"Showing 12 transactions for John Smith totalling $4,200\"). For date phrases like 'last month', 'this quarter', 'in May', compute the YYYY-MM-DD range from today's date.",
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive)' },
        contactId: { type: 'string', description: 'Exact contact id (use after lookup_contact for precision)' },
        contactName: { type: 'string', description: 'Contact name — partial match. If the user names a contact and you have not looked them up, you may pass it here directly.' },
        type: { type: 'string', enum: ['deposit', 'withdrawal'], description: 'Type of transaction' },
        minAmount: { type: 'number' },
        maxAmount: { type: 'number' },
        accountName: { type: 'string', description: 'Filter by category account name (partial match) e.g. "travel"' },
        onlyUnreviewed: { type: 'boolean', description: 'If true, only return transactions still needing review' },
        uncategorizedOnly: { type: 'boolean', description: 'If true, only return transactions where category_account_id IS NULL — the right filter for the "Categorize N transactions" flow.' },
        searchText: { type: 'string', description: 'Match against description / bank description text' },
        limit: { type: 'number', description: 'Max rows (1-200, default 50)' },
        sort: {
          type: 'string',
          enum: ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'],
          description: 'Sort order, default date_desc',
        },
      },
      required: [],
    },
  },
  {
    type: 'function' as const,
    name: 'list_accounts',
    description:
      'List the chart-of-accounts entries available for categorization. Returns active accounts with id, accountNumber, accountName, gaapType, normalBalance. Use the optional `types` filter to narrow (e.g. ["expense","cost_of_goods_sold"] when categorizing withdrawals; ["revenue","income","other_income"] for deposits). Cache the response per session — the COA does not change mid-conversation.',
    parameters: {
      type: 'object',
      properties: {
        types: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Optional gaap_type filter. Common values: 'revenue', 'income', 'other_income', 'expense', 'cost_of_goods_sold', 'cogs', 'other_expense', 'asset', 'current_asset', 'liability', 'equity'. Omit to receive all active accounts.",
        },
      },
      required: [],
    },
  },
  // Categorization tools are no longer surfaced to the realtime AI. The
  // workflow lives at /ai-chat?categorize=open. Dispatcher cases stay alive
  // for backward compat / programmatic callers but the AI never sees them.
];

// Categorization tool names removed from the AI-visible union. Dispatcher
// cases stay alive in realtime-tool-dispatch.ts for direct programmatic
// callers (the workspace and tests) but isRealtimeToolName returns false
// for them, so chat fall-through no longer routes to them.
export type RealtimeToolName =
  | 'lookup_contact'
  | 'create_contact'
  | 'list_revenue_accounts'
  | 'list_accounts'
  | 'save_invoice_draft'
  | 'post_invoice'
  | 'cancel_invoice_draft'
  | 'query_transactions'
  | 'get_onboarding_status'
  | 'set_business_info'
  | 'advance_onboarding';
