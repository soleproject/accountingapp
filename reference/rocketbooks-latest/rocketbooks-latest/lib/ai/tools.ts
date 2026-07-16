import 'server-only';
import { eq, and, asc, sql, desc, gte, lte, count } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/db/client';
import { transactions, journalEntries, generalLedger, chartOfAccounts, contacts, organizations, notes, tasks, appointments, inboxMessages, taskLinks, reconciliationPeriods, bookReviewFindings } from '@/db/schema/schema';
import { entityExistsInOrg } from '@/lib/task-links/queries';
import { isTaskLinkEntityType, type TaskLinkEntityType } from '@/lib/task-links/types';
import { executeRealtimeTool, isRealtimeToolName } from '@/lib/ai/realtime-tool-dispatch';
import { getActionCards } from '@/lib/server/action-cards';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { sendAsUser } from '@/lib/email-accounts/send-as-user';
import { sendTransactionalSms, isTwilioConfigured } from '@/lib/sms/twilio';
import { E164_RE, normalizePhone } from '@/lib/sms/normalize';
import { textMessages, users } from '@/db/schema/schema';
import { isTextsEnabled } from '@/lib/texts/access';
import { createGoogleEvent, updateGoogleEvent, deleteGoogleEvent } from '@/lib/calendar/google';
import { getOrCreateBookingProfile } from '@/lib/booking/profile';
import { publicBookingUrl, eventTypeUrl } from '@/lib/booking/links';
import { blockTime, unblockDate, checkAvailability, listAvailability } from '@/lib/booking/blocks';
import { hhmmToMinutes } from '@/lib/booking/constants';
import { sendOrganizerEmail, resolveEmailRecipient, resolveBookingLink, createVideoInvite, findDocument, sendDocumentForSignature, sendDocumentToContact } from '@/lib/organizer/ai-actions';
import { getDocument } from '@/lib/documents/store';
import { appendLearning } from '@/lib/ai/client-profile';
import { isAllowedAppPath } from '@/lib/ai/app-routes';
import { onboardingAwarePath } from '@/lib/ai/onboarding-destination';
import { WORKFLOW_GUIDES } from '@/lib/ai/page-tools';
import { loadIncomeStatement } from '@/lib/reports/income-statement-data';
import { resolveBasis } from '@/lib/reports/basis-filter';

export interface AiToolContext {
  organizationId: string;
  /** Per-request turn id; threaded into onboarding tools so the server-side
   * turn gate can refuse a second advance within the same user turn. */
  turnId?: string;
  /** Accounting basis the user is CURRENTLY viewing on the page (e.g. the
   * Income Statement's Accrual/Cash toggle, read from the URL). Used so
   * get_period_pnl mirrors exactly what's on screen. Falls back to the org's
   * saved method when absent. */
  viewBasis?: 'cash' | 'accrual';
}

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_org_summary',
      description: 'Get high-level summary of the organization: name, plan, accounting method, and counts of transactions, contacts, accounts, and journal entries.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'remember_about_client',
      description:
        "Persist a DURABLE preference or fact about how THIS client likes their books handled, so you remember it in future conversations. Use for standing preferences only — e.g. 'Codes all Home Depot purchases to the rental property', 'Prefers brief replies', \"Doesn't want to be asked about amounts under $25\", 'Reviews bills on Fridays'. Do NOT use it for one-off requests, transient context, or anything already shown in the CLIENT CONTEXT. Pass one concise, self-contained note.",
      parameters: {
        type: 'object',
        properties: {
          note: {
            type: 'string',
            description:
              'A concise, self-contained preference or fact to remember, phrased about the client. E.g. "Codes all Home Depot purchases to the rental property."',
          },
        },
        required: ['note'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_attention_items',
      description:
        "Get the user's prioritized attention list — the action items that need their attention (overdue bills/invoices, transactions to review, reconciliation, incomplete setup, taxes due). Call this when the user asks to 'walk me through everything', 'what needs my attention', or 'what should I do first'. Returns items ordered highest-priority first, each with what it is, how to act on it, and a targetPath (the in-app page to open if they want to do it).",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'open_app_page',
      description:
        "Navigate the user's browser to an in-app page — use this to actually TAKE the user somewhere when they agree to act on an attention item that has a targetPath (e.g. finishing onboarding → '/ai-chat?onboarding=start', chasing invoices → '/invoices/follow-up'). Pass the item's targetPath as `path`. Only same-app paths starting with '/'. AFTER it runs: if the result includes a `workflow` note, that page is a multi-step process — walk the client through it step by step in 'we' language and act on their approval. Otherwise just confirm in one short sentence (e.g. 'Taking us there now.').",
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: "In-app path starting with '/', from the attention item's targetPath." } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_recent_transactions',
      description: 'List the most recent transactions in the organization. Use limit between 1 and 25.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'How many to return (1-25)' } },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_account_balance',
      description: 'Compute the current balance of a chart-of-accounts entry by name (case-insensitive partial match). Sums general_ledger debits/credits respecting the account normal balance.',
      parameters: {
        type: 'object',
        properties: { account_name: { type: 'string', description: 'Account name to search for' } },
        required: ['account_name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_top_contacts_by_spend',
      description: 'Return the top contacts ranked by total transaction amount (debits + credits) for an optional date range. Useful for "who do I pay most?" or "biggest customers".',
      parameters: {
        type: 'object',
        properties: {
          from_date: { type: 'string', description: 'YYYY-MM-DD (optional)' },
          to_date: { type: 'string', description: 'YYYY-MM-DD (optional)' },
          limit: { type: 'number', description: 'How many (1-25)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_period_pnl',
      description:
        "Compute revenue, expenses, and net income for a date range — using the EXACT same engine and accounting basis as the Reports → Income Statement page, so the numbers always match the report. Defaults to YTD if dates omitted, and to the org's saved accounting method (cash or accrual) if basis is omitted. The result includes a `basis` field — ALWAYS tell the user whether the figures are on a cash or accrual basis in your answer, since the two can differ a lot.",
      parameters: {
        type: 'object',
        properties: {
          from_date: { type: 'string', description: 'YYYY-MM-DD (optional)' },
          to_date: { type: 'string', description: 'YYYY-MM-DD (optional)' },
          basis: {
            type: 'string',
            enum: ['cash', 'accrual'],
            description: "Accounting basis. Omit to use the org's default (what the Income Statement report shows by default). Only set it if the user explicitly asks for cash or accrual.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_book_review_findings',
      description:
        "List the OPEN book-review findings — the EXACT issues shown on the Book Review page: likely-duplicate transactions, possible near-duplicates, integrity problems (e.g. trial balance doesn't tie out), and anomalies. ALWAYS use this when the user wants to review/walk through their book-review findings, or asks about duplicates flagged in their books. Do NOT use query_transactions or list_attention_items for this — the review queue and attention cards are different datasets and will make you wrongly say there are no findings. Returns total + per-kind counts and the findings (severity 'warn' first), so your numbers match the Book Review page.",
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['duplicate', 'integrity', 'anomaly'],
            description: 'Optional — filter to one kind. Omit for all open findings.',
          },
          limit: { type: 'number', description: 'Max findings to return (1-100, default 50).' },
        },
        required: [],
      },
    },
  },
  // ---- Action tools (shared with the realtime voice assistant) ----
  {
    type: 'function' as const,
    function: {
      name: 'lookup_contact',
      description:
        'Find a customer or vendor by name. Returns matches with id and name. Always call this before creating a new contact to avoid duplicates.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Name to search for (case-insensitive partial match)' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
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
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_revenue_accounts',
      description:
        'List the chart-of-accounts entries that are valid revenue accounts (income / sales / fees). Use these for invoice line items. Also returns AR account candidates.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'save_invoice_draft',
      description:
        'Create or update a draft invoice. Each call replaces the entire draft state — always include the full current line list. Returns the draft snapshot which the UI renders as a live invoice preview. Call this on every change (line added, price edited, etc).',
      parameters: {
        type: 'object',
        properties: {
          draftId: {
            type: 'string',
            description: 'Existing draft to update. Omit on first call; the response will give you a draftId to reuse.',
          },
          contactId: { type: 'string', description: 'Customer contact id (from lookup_contact or create_contact)' },
          invoiceDate: { type: 'string', description: 'YYYY-MM-DD' },
          dueDate: { type: 'string', description: 'YYYY-MM-DD (optional)' },
          invoiceNumber: { type: 'string' },
          memo: { type: 'string' },
          arAccountId: { type: 'string', description: 'AR account id (from list_revenue_accounts.ar). If omitted, the first AR candidate is used.' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                quantity: { type: 'number' },
                unitPrice: { type: 'number' },
                revenueAccountId: { type: 'string' },
              },
              required: ['description', 'quantity', 'unitPrice', 'revenueAccountId'],
            },
          },
        },
        required: ['contactId', 'invoiceDate', 'lines'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'post_invoice',
      description:
        "Finalize a draft invoice — posts the journal entry (debit AR, credit revenue grouped per line). Only call after the user confirms they're ready to post.",
      parameters: {
        type: 'object',
        properties: { draftId: { type: 'string' } },
        required: ['draftId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'cancel_invoice_draft',
      description: 'Cancel and delete a draft invoice if the user changes their mind before posting.',
      parameters: {
        type: 'object',
        properties: { draftId: { type: 'string' } },
        required: ['draftId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_onboarding_status',
      description:
        'Get the current onboarding state for this business: phase (business_info → quickbooks → plaid → bank_statements → receipts → review → complete) plus signals about what is already done. Call this whenever onboarding comes up.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_business_info',
      description:
        'Save the business name, description, and optionally entity type and beneficiary roster. The first save with name + description auto-advances onboarding to the quickbooks phase (also requires entity_type when the org\'s Enterprise has entity-type onboarding enabled).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string', description: 'Short description of what the business does (1-3 sentences)' },
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
  },
  {
    type: 'function' as const,
    function: {
      name: 'advance_onboarding',
      description:
        "Move onboarding to the next phase or jump to a specific one. Use 'next' to advance, or specify a phase. Phases: business_info, quickbooks, plaid, bank_statements, receipts, review, complete.",
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
  },
  {
    type: 'function' as const,
    function: {
      name: 'query_transactions',
      description:
        "Query and DISPLAY transactions to the user as a live table. Call this whenever the user asks to see / show / list / find transactions matching any criteria. Returns rows + totals which the UI renders as a panel under the message. For date phrases like 'last month', 'this quarter', 'in May', compute YYYY-MM-DD ranges from today's date.",
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive)' },
          to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive)' },
          contactId: { type: 'string' },
          contactName: { type: 'string', description: 'Contact name — partial match' },
          type: { type: 'string', enum: ['deposit', 'withdrawal'] },
          minAmount: { type: 'number' },
          maxAmount: { type: 'number' },
          accountName: { type: 'string', description: 'Filter by category account name (partial match)' },
          onlyUnreviewed: { type: 'boolean' },
          uncategorizedOnly: { type: 'boolean', description: 'If true, only return transactions where category_account_id IS NULL.' },
          searchText: { type: 'string', description: 'Match against description / bank description text' },
          limit: { type: 'number', description: 'Max rows (1-200, default 50)' },
          sort: {
            type: 'string',
            enum: ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'],
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'query_invoices',
      description:
        "Query and DISPLAY invoices (Accounts Receivable) to the user as a live panel. Use this whenever the user asks about invoices — outstanding, overdue, paid, by customer, etc. NEVER answer invoice questions with query_transactions. Returns invoice rows + totals + aging which the UI renders under the message. For date phrases compute YYYY-MM-DD ranges from today's date. " +
        "AFTER THIS TOOL RUNS, the UI already shows every row (invoice number, customer, dates, status, amount) in a panel below your message. Your reply MUST be one short sentence summarizing the count and total — e.g. 'You have 1 overdue invoice totaling $5,600.' or 'No outstanding invoices.' Do NOT enumerate fields, do NOT bullet the rows, do NOT repeat invoice numbers, dates, or customer names — the panel shows all of that.",
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['all', 'overdue', 'outstanding', 'paid', 'draft', 'sent'],
            description: "Filter by status. 'overdue' = unpaid + past due date. 'outstanding' = anything not paid. Default 'all'.",
          },
          customerId: { type: 'string', description: 'Filter to a specific customer by id' },
          customerName: { type: 'string', description: 'Filter to a customer by partial name match' },
          from: { type: 'string', description: 'Min invoice date YYYY-MM-DD (inclusive)' },
          to: { type: 'string', description: 'Max invoice date YYYY-MM-DD (inclusive)' },
          limit: { type: 'number', description: 'Max rows (1-200, default 50)' },
          sort: { type: 'string', enum: ['date_desc', 'date_asc', 'due_asc', 'due_desc', 'amount_desc', 'amount_asc'] },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'query_bills',
      description:
        "Query and DISPLAY bills (Accounts Payable) to the user as a live panel. Use this whenever the user asks about bills — outstanding, overdue, paid, by vendor, A/P, money owed, what we owe, etc. NEVER answer bill questions with query_transactions. Returns bill rows + totals + aging. " +
        "AFTER THIS TOOL RUNS, the UI already shows every row (bill number, vendor, dates, status, amount) in a panel below your message. Your reply MUST be one short sentence summarizing the count and total — e.g. 'You have 1 overdue bill totaling $4,500.' or 'No outstanding bills.' Do NOT enumerate fields, do NOT bullet the rows, do NOT repeat bill numbers, dates, or vendor names — the panel shows all of that.",
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['all', 'overdue', 'outstanding', 'paid'],
            description: "Filter by status. 'overdue' = unpaid bills past due. 'outstanding' = any unpaid. 'paid' = fully paid. Default 'all'.",
          },
          vendorId: { type: 'string', description: 'Filter to a specific vendor by id' },
          vendorName: { type: 'string', description: 'Filter to a vendor by partial name match' },
          from: { type: 'string', description: 'Min bill date YYYY-MM-DD (inclusive)' },
          to: { type: 'string', description: 'Max bill date YYYY-MM-DD (inclusive)' },
          limit: { type: 'number', description: 'Max rows (1-200, default 50)' },
          sort: { type: 'string', enum: ['date_desc', 'date_asc', 'due_asc', 'due_desc', 'amount_desc', 'amount_asc'] },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_accounts',
      description:
        'List the chart-of-accounts entries available for categorization. Returns active accounts with id, accountNumber, accountName, gaapType, normalBalance. Use the optional `types` filter to narrow (e.g. ["expense","cost_of_goods_sold"] for withdrawals; ["revenue","income","other_income"] for deposits). Cache the response per session.',
      parameters: {
        type: 'object',
        properties: {
          types: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Optional gaap_type filter. Common values: 'revenue', 'income', 'other_income', 'expense', 'cost_of_goods_sold', 'cogs', 'other_expense', 'asset', 'current_asset', 'liability', 'equity'.",
          },
        },
        required: [],
      },
    },
  },
  // Categorization tools (list_uncategorized_by_contact, categorize_contact_uncategorized,
  // categorize_contact_uncategorized_subset) have been removed from the public chat catalog.
  // Categorization is now a workspace-driven flow at /ai-chat?categorize=open. The dispatcher
  // cases stay alive in lib/ai/realtime-tool-dispatch.ts as internal hatches but the AI no
  // longer sees them.
  // ---- Organizer action tools ----
  {
    type: 'function' as const,
    function: {
      name: 'create_note',
      description:
        "Save a note for the current user. Use this whenever the user is logging what they observed, decided, or talked about — e.g. after a meeting or call. CONTACT LINKING IS NOT OPTIONAL: if the note mentions a specific person, you MUST call lookup_contact first to get their contactId and pass it here, so the note shows up on that contact's drill-in page. Only omit contactId when the note is genuinely general (no person involved). Re-using a contactId from earlier in the same conversation is fine. DO NOT RECREATE NOTES YOU ALREADY MADE: if you successfully created a note earlier in this conversation, don't call create_note again with the same content just because a different tool (email, calendar) failed and needs retry. Re-call only the failed tool. The server soft-suppresses duplicate notes (same body within 60s) but you should still not attempt them.",
      parameters: {
        type: 'object',
        properties: {
          body: { type: 'string', description: 'The note text (1-5000 chars).' },
          contactId: { type: 'string', description: 'Optional contact to attach the note to.' },
          appointmentId: { type: 'string', description: "Optional meeting/appointment id to attach the note to. Pass this when the note is what happened on a specific scheduled call/meeting (from list_my_appointments) — it lets RocketSuite close out that meeting's follow-up loop." },
        },
        required: ['body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_task',
      description:
        "Create an open task for the current user. Use this when the user mentions something that needs follow-up — 'remind me to…', 'I need to send Bob a contract', 'follow up next week'. Include dueDate (YYYY-MM-DD) when the user hints at timing. CONTACT LINKING IS NOT OPTIONAL: if the task is about / for / with a specific person, you MUST call lookup_contact first and pass the contactId so the task shows up on that contact's drill-in page. Only omit contactId for tasks with no person involved. DO NOT RECREATE TASKS YOU ALREADY MADE: if you successfully created a task earlier in this conversation (whether or not other tools in that turn also succeeded), don't call create_task again with the same title on a retry — only re-call the tool that actually failed. The server soft-suppresses duplicate tasks (same title within 60s) but you should still not attempt them.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short imperative title (max 200 chars).' },
          description: { type: 'string', description: 'Optional longer details.' },
          dueDate: { type: 'string', description: 'Optional due date in YYYY-MM-DD.' },
          priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Optional priority.' },
          contactId: { type: 'string', description: 'Optional contact this task is about.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'complete_task',
      description:
        "Mark a task as done. Use when the user mentions finishing or no-longer-needing something on their list — 'I sent that email', 'we already handled that', 'mark the proposal task done'. Pass the task's id (from list_my_open_tasks or a recent create_task result).",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Internal task id.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_task',
      description:
        "Permanently delete a task. ALWAYS confirm with the user before calling — deletion is irreversible. Prefer complete_task when the work is just finished; reserve delete_task for tasks the user wants to throw away (created by mistake, no longer relevant).",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Internal task id.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_task',
      description:
        "Edit an existing open task — change its title, description, due date, priority, or which contact it's attached to. Only the fields you include get touched. Pass empty string for dueDate / contactId to clear them.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Internal task id.' },
          title: { type: 'string', description: 'Max 200 chars.' },
          description: { type: 'string', description: 'Pass empty string to clear.' },
          dueDate: { type: 'string', description: 'YYYY-MM-DD or empty string to clear.' },
          priority: { type: 'string', enum: ['low', 'normal', 'high'] },
          contactId: { type: 'string', description: 'Contact id to attach. Empty string clears.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'link_task',
      description:
        "Link an existing task to a related item so they show up together (on the task's linked-items list and on the item's own view). Use when the user says a task relates to a specific note, meeting/appointment, email, text, or contact — e.g. 'link that follow-up to the Acme meeting', 'attach this task to the email from Dana'. Resolve the entityId first (lookup_contact for contacts; list tools for notes/appointments/inbox/texts), then call this. A task can have many links.",
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Internal task id (from list_my_open_tasks or a recent create_task).' },
          entityType: { type: 'string', enum: ['contact', 'note', 'appointment', 'inbox_message', 'text_message'], description: "What kind of item to link. 'appointment' = meeting, 'inbox_message' = email, 'text_message' = SMS." },
          entityId: { type: 'string', description: 'Id of the contact / note / appointment / inbox message / text message to link.' },
        },
        required: ['taskId', 'entityType', 'entityId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'unlink_task',
      description: 'Remove a previously created link between a task and a contact/note/appointment/email/text. Same params as link_task.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Internal task id.' },
          entityType: { type: 'string', enum: ['contact', 'note', 'appointment', 'inbox_message', 'text_message'] },
          entityId: { type: 'string', description: 'Id of the linked item to detach.' },
        },
        required: ['taskId', 'entityType', 'entityId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_my_open_tasks',
      description:
        "List the current user's open tasks, sorted by due date (soonest first; undated tasks last). Use this when the user asks what they have to do, what's due, what's coming up, etc. Returns id, title, dueDate, priority, contactId.",
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max rows (1-50, default 20)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_contact_context',
      description:
        "Load the user's recent activity with a specific contact in one call: contact details, last 5 notes, top 5 open tasks, next 5 upcoming appointments, last 5 inbox messages, plus totals. Call this AT THE START of any conversation that mentions a known contact (especially the 'log a conversation' flow) — it gives you the background you need to speak intelligently instead of asking the user to repeat what's already in the system. After reading, summarize in ONE short sentence what stands out before asking the user what came up.",
      parameters: {
        type: 'object',
        properties: {
          contactId: { type: 'string', description: 'Internal contact id (use lookup_contact first if you only have a name).' },
        },
        required: ['contactId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_appointment',
      description:
        "Add an appointment to the user's calendar (will sync to Google Calendar if connected). Use this whenever the user mentions scheduling a meeting, call, or event. startsAt is required as ISO 8601 (e.g. '2026-05-28T14:30:00Z' or local '2026-05-28T14:30:00'). CONTACT LINKING IS NOT OPTIONAL: if the appointment is with a specific person, you MUST call lookup_contact first and pass the contactId — otherwise it won't appear on their drill-in page AND the Google Calendar event won't invite them. DO NOT RECREATE APPOINTMENTS YOU ALREADY MADE: if you successfully created an appointment earlier in this conversation, don't call create_appointment again for the same meeting just because email or another tool needs retry. The server soft-suppresses duplicate appointments (same title + same startsAt within 60s) but you should still not attempt them.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title (max 200 chars).' },
          startsAt: { type: 'string', description: 'ISO 8601 datetime when the appointment starts.' },
          endsAt: { type: 'string', description: 'Optional ISO 8601 end datetime.' },
          description: { type: 'string', description: 'Optional details / agenda.' },
          location: { type: 'string', description: 'Optional location or meeting link.' },
          contactId: { type: 'string', description: 'Optional contact this appointment is with.' },
        },
        required: ['title', 'startsAt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_booking_link',
      description:
        "Get the current user's public booking (scheduling) link — the page where someone can pick a time on the user's calendar. Use this whenever the user wants to SHARE their availability / let someone book a time / 'send my calendar link' / 'send my booking link'. Returns the link URL; put that exact URL into the email or text you then draft or send (never invent a booking URL). To actually create/schedule a specific meeting at a known time, use create_appointment instead — this tool only returns the self-service link.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'block_booking_time',
      description:
        "Block the user's booking availability so people can NOT book them then. Use for 'block Friday', 'block tomorrow', 'block June 6 from 1pm to 3pm', 'I'm out next Monday'. Resolve the day to an absolute YYYY-MM-DD first (today's date is in the system prompt). Times are in the user's OWN booking timezone (returned in the result) — pass them as 24-hour HH:MM. OMIT startTime/endTime to block the WHOLE day. This both closes the slots on the public booking page AND adds a visible 'Busy' event to the user's calendar (syncing to Google if connected). Reversible with unblock_booking_time. Do NOT use this to schedule a real meeting with someone — that's create_appointment.",
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'The day to block, as YYYY-MM-DD.' },
          startTime: { type: 'string', description: "Start of the blocked range, 24h 'HH:MM' in the user's booking timezone. Omit to block the whole day." },
          endTime: { type: 'string', description: "End of the blocked range, 24h 'HH:MM'. Omit to block the whole day." },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'unblock_booking_time',
      description:
        "Undo a previous block on a date — reopens that day to the user's normal weekly availability and removes the 'Busy' calendar event(s) the assistant created for it. Use for 'unblock Friday', 'I'm free that day after all', 'remove the block on June 6'. Resolve the day to YYYY-MM-DD first. Note: this clears the WHOLE day's block(s); it can't reopen just part of a blocked range.",
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'The day to unblock, as YYYY-MM-DD.' },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'check_booking_availability',
      description:
        "Check whether the user is OPEN/FREE for a booking at a specific day and time. Use for 'am I free Thursday at 2pm?', 'can someone book me at 10am tomorrow?'. Resolve the day to YYYY-MM-DD and pass time as 24h 'HH:MM' in the user's booking timezone (returned in the result). durationMinutes defaults to 30. Returns available true/false plus a reason when not (outside_hours, conflict, blocked, too_soon, too_far_out, past).",
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Day to check, YYYY-MM-DD.' },
          time: { type: 'string', description: "Start time, 24h 'HH:MM', in the user's booking timezone." },
          durationMinutes: { type: 'number', description: 'Meeting length in minutes (default 30).' },
        },
        required: ['date', 'time'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_booking_availability',
      description:
        "List the user's OPEN/free booking times over a date range, as time ranges grouped by day (in the user's booking timezone). Use for 'what do I have open next week?', 'when am I free Friday?', 'my availability June 5–9'. Resolve days to YYYY-MM-DD; if the user names a single day, pass it as both from and to (or omit to). durationMinutes defaults to 30. Respects the user's weekly hours, blocks, and existing meetings.",
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Start of range, YYYY-MM-DD.' },
          to: { type: 'string', description: 'End of range, YYYY-MM-DD (inclusive). Omit for a single day.' },
          durationMinutes: { type: 'number', description: 'Slot length in minutes (default 30).' },
        },
        required: ['from'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_appointment',
      description:
        "Reschedule or edit an existing appointment. Pass the appointment's id (from list_my_appointments or a prior create_appointment) plus any fields you want to change. Only the fields you include are touched. When the appointment is mirrored to Google Calendar, the change is pushed there first; if Google rejects the update, the local row is NOT modified so the two sides don't drift.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Internal appointment id.' },
          title: { type: 'string' },
          startsAt: { type: 'string', description: 'ISO 8601 datetime.' },
          endsAt: { type: 'string', description: 'ISO 8601 datetime. Pass empty string to clear.' },
          description: { type: 'string' },
          location: { type: 'string' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_appointment',
      description:
        "Cancel an appointment. When mirrored to Google Calendar, the deletion is pushed there first; on success (or if Google already lost the event), the local row is removed too. ALWAYS confirm with the user before calling — deletion is irreversible.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Internal appointment id.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_my_appointments',
      description:
        "List the current user's upcoming appointments, sorted by start time. Use 'today' to scope to today only, otherwise returns the next N appointments. Returns id, title, startsAt, endsAt, location, contactId.",
      parameters: {
        type: 'object',
        properties: {
          today: { type: 'boolean', description: "If true, only today's appointments." },
          limit: { type: 'number', description: 'Max rows (1-50, default 20).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_inbox',
      description:
        "List open inbound messages (emails, SMS) in the user's inbox, newest first. Use this when the user asks 'what's in my inbox', 'any new messages', 'who reached out', etc. Returns id, source, fromAddress, fromName, subject, body (truncated), receivedAt, contactId.",
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max rows (1-50, default 20).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'triage_inbox_message',
      description:
        "Mark an inbox message as triaged (handled) or archived (dismissed without action). Call this after the user resolves a message — e.g. you created a task/note from it, or the user said 'ignore that'.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Inbox message id.' },
          status: { type: 'string', enum: ['triaged', 'archived'] },
        },
        required: ['id', 'status'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'send_email',
      description:
        "Send a transactional email on the user's behalf. ALWAYS read the full draft (recipient, subject, body) back to the user and get explicit confirmation BEFORE calling this tool — sending is irreversible. Pass `to` as either a literal email address or a contactId (the tool will look up the contact's email). Body is plain text.",
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Either an email address (foo@bar.com) or a contactId.' },
          subject: { type: 'string', description: 'Email subject (1-200 chars).' },
          body: { type: 'string', description: 'Plain-text email body (1-10000 chars).' },
          replyTo: { type: 'string', description: 'Optional reply-to email.' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'send_text_to_contact',
      description:
        "Send an SMS text message to a contact via Twilio. Use lookup_contact first to resolve a name to a contactId. ALWAYS read the full draft (contact + message body) back to the user and get explicit confirmation BEFORE calling — sending is irreversible. Returns the message snapshot which the UI renders as a text-bubble card; the assistant should reference the card rather than re-read the body verbatim.",
      parameters: {
        type: 'object',
        properties: {
          contactId: { type: 'string', description: 'The contact to text (from lookup_contact).' },
          body: { type: 'string', description: 'Message body, 1-1600 chars.' },
        },
        required: ['contactId', 'body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'draft_organizer_email',
      description:
        "Draft an email to send on the user's behalf and PREVIEW it as a confirmation card with Send/Cancel buttons. Use for: 'send <contact> an email about …', 'send <contact> my calendar link', 'email <contact> and include my calendar link'. Resolve the contact with find_contact first and pass its id as `to` (or a literal email). Set include_booking_link=true to append the user's scheduling/calendar link. This does NOT send — the user sends via the card button or by confirming verbally. Ask for anything missing (what to say, which contact/email) BEFORE drafting.",
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient: a contactId (from find_contact) or a literal email address.' },
          subject: { type: 'string', description: 'Email subject (1-200 chars).' },
          body: { type: 'string', description: 'Plain-text body (1-10000 chars). For a calendar-link request, write a short friendly note; the link is appended automatically when include_booking_link is true.' },
          include_booking_link: { type: 'boolean', description: "Append the user's public calendar/booking link to the body." },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'send_organizer_email',
      description:
        "Actually send an email previously shown via draft_organizer_email, AFTER the user confirms verbally (says yes/send). Prefer letting the user click the card's Send button; only call this when they confirm in chat. Sends the email, appends the calendar link if requested, and logs a completed task as a trail.",
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'contactId or literal email (same as the draft).' },
          subject: { type: 'string', description: 'Email subject.' },
          body: { type: 'string', description: 'Plain-text body (without the calendar link — set include_booking_link to append it).' },
          include_booking_link: { type: 'boolean', description: "Append the user's calendar link." },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'draft_video_invite',
      description:
        "Draft an email inviting a contact to a video call and PREVIEW it as a confirm card with a Join button. Use for 'send <contact> a link to my video call', 'invite <contact> to a video call'. Resolve the contact with find_contact first. This provisions a room and shows the preview — it does NOT send. After drafting, ASK the user whether they want to open/join the room now (the card has a Join button). The user sends via the card's Send button or by confirming verbally.",
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'contactId (from find_contact) or a literal email address.' },
          subject: { type: 'string', description: 'Email subject. Default: "Video call invite".' },
          body: { type: 'string', description: 'Short friendly note. The join link is appended automatically — do NOT include it.' },
        },
        required: ['to'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'send_video_invite',
      description:
        "Send a video-call invite email previously shown via draft_video_invite, AFTER the user confirms verbally. Prefer the card's Send button. Emails the join link and logs a completed task. Pass the joinUrl from the draft.",
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'contactId or literal email (same as the draft).' },
          subject: { type: 'string', description: 'Email subject.' },
          body: { type: 'string', description: 'Short note (without the join link).' },
          joinUrl: { type: 'string', description: 'The join URL returned by the draft.' },
        },
        required: ['to', 'joinUrl'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_document',
      description:
        "Find an organizer document by title (fuzzy). Use to resolve 'the proposal', 'the NDA', etc. to a documentId before sending a document for signature. Returns up to 5 matches with id, title, kind, source.",
      parameters: {
        type: 'object',
        properties: { title_query: { type: 'string', description: 'Document title to search for.' } },
        required: ['title_query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'draft_signature_request',
      description:
        "Preview sending a document to a contact FOR SIGNATURE as a confirm card with Send/Cancel. Use for 'send <contact> <document> for signature' / 'have <contact> sign <document>'. Resolve the contact with find_contact and the document with find_document FIRST. Does NOT send. Only PDF uploads and created documents can be sent for signature.",
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'contactId (from find_contact) or a literal email.' },
          document_id: { type: 'string', description: 'Document id from find_document.' },
        },
        required: ['to', 'document_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'send_signature_request',
      description:
        "Actually send the document for signature AFTER the user confirms verbally. Prefer the card's Send button. Emails the signing link and logs a completed task.",
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'contactId or literal email (same as the draft).' },
          document_id: { type: 'string', description: 'Document id (same as the draft).' },
        },
        required: ['to', 'document_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'draft_send_document',
      description:
        "Preview EMAILING a document to a contact (attached as a PDF + a view link) as a confirm card with Send/Cancel. Use for 'send <contact> <document>' / 'email <contact> the <document>' (NOT for signature — use draft_signature_request for that). Resolve the contact with find_contact and the document with find_document FIRST. Does NOT send. Only PDF uploads and created documents can be emailed.",
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'contactId (from find_contact) or a literal email.' },
          document_id: { type: 'string', description: 'Document id from find_document.' },
          subject: { type: 'string', description: 'Optional email subject.' },
          body: { type: 'string', description: 'Optional short note.' },
        },
        required: ['to', 'document_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'send_document',
      description:
        "Actually email the document (PDF attachment + view link) AFTER the user confirms verbally. Prefer the card's Send button. Logs a completed task.",
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'contactId or literal email (same as the draft).' },
          document_id: { type: 'string', description: 'Document id (same as the draft).' },
          subject: { type: 'string', description: 'Optional subject.' },
          body: { type: 'string', description: 'Optional note.' },
        },
        required: ['to', 'document_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_client_email_settings',
      description:
        "Turn the automatic client-facing email features ON or OFF for this organization. Use whenever the user wants to stop (or resume) any of these recurring emails — they can change one, several, or all at once:\n" +
        "- 'contact_inquiry' — the email asking who an unrecognized contact/vendor is\n" +
        "- 'substantiation' — the email requesting IRS documentation (receipts/backup)\n" +
        "- 'review_reminders' — the reminder to answer questions on transactions in the review queue\n" +
        "- 'monthly_report' — the monthly P&L / balance-sheet summary email\n" +
        "- 'weekly_digest' — the Monday-morning 'what needs your attention' digest\n" +
        "After calling this, confirm to the user exactly which were turned off/on. To turn EVERYTHING off, pass all five.",
      parameters: {
        type: 'object',
        properties: {
          settings: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['contact_inquiry', 'substantiation', 'review_reminders', 'monthly_report', 'weekly_digest'],
            },
            description: 'Which email features to change. Include every one the user mentioned (all five to turn everything off).',
          },
          enabled: {
            type: 'boolean',
            description: 'false to turn the listed features OFF, true to turn them ON.',
          },
        },
        required: ['settings', 'enabled'],
      },
    },
  },
];


/** Seed used to derive a booking profile's slug on first use (full name or email). */
async function resolveBookingSeed(userId: string): Promise<string> {
  const [u] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u?.fullName || u?.email || 'meet';
}

export async function executeTool(
  ctx: AiToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'remember_about_client': {
      const note = typeof args.note === 'string' ? args.note : '';
      const saved = await appendLearning(ctx.organizationId, note);
      if (!saved) return { ok: false, error: 'Nothing to remember — the note was empty.' };
      return { ok: true, remembered: saved.note };
    }
    case 'set_client_email_settings': {
      // Let the recipient opt out of (or back into) any automatic email. Like an
      // unsubscribe link, this is intentionally NOT gated to accountants — it
      // controls the current org's own client-facing emails. Four map to per-org
      // flags; weekly_digest is a per-user opt-in on the signed-in user.
      const VALID = ['contact_inquiry', 'substantiation', 'review_reminders', 'monthly_report', 'weekly_digest'];
      const LABELS: Record<string, string> = {
        contact_inquiry: 'new-contact questions',
        substantiation: 'IRS documentation requests',
        review_reminders: 'review reminders',
        monthly_report: 'monthly report email',
        weekly_digest: 'weekly digest email',
      };
      const requested = Array.isArray(args.settings) ? args.settings : [];
      const settings = requested.filter((s): s is string => typeof s === 'string' && VALID.includes(s));
      const enabled = args.enabled === true;
      if (settings.length === 0) {
        return { ok: false, error: 'Tell me which emails to change: new-contact questions, IRS documentation requests, review reminders, the monthly report, or the weekly digest.' };
      }
      const orgPatch: Record<string, boolean> = {};
      if (settings.includes('contact_inquiry')) orgPatch.contactInquiryEnabled = enabled;
      if (settings.includes('substantiation')) orgPatch.substantiationEnabled = enabled;
      if (settings.includes('review_reminders')) orgPatch.reviewAutoOutreachEnabled = enabled;
      if (settings.includes('monthly_report')) orgPatch.monthlyReportEnabled = enabled;
      if (Object.keys(orgPatch).length > 0) {
        await db.update(organizations).set(orgPatch).where(eq(organizations.id, ctx.organizationId));
      }
      if (settings.includes('weekly_digest')) {
        const userId = await getEffectiveUserId();
        await db
          .update(users)
          .set({ weeklyDigestOptInAt: enabled ? new Date().toISOString() : null })
          .where(eq(users.id, userId));
      }
      return { ok: true, enabled, changed: settings.map((s) => LABELS[s]) };
    }
    case 'list_attention_items': {
      const cards = await getActionCards(ctx.organizationId);
      // For reconciliation, link straight to the first open period's page.
      let reconPath = '/reconciliation';
      if (cards.some((c) => c.id === 'reconciliation-off')) {
        const [p] = await db
          .select({ id: reconciliationPeriods.id })
          .from(reconciliationPeriods)
          .where(
            and(
              eq(reconciliationPeriods.organizationId, ctx.organizationId),
              eq(reconciliationPeriods.status, 'OPEN'),
              sql`${reconciliationPeriods.difference} is not null and ${reconciliationPeriods.difference} <> 0`,
            ),
          )
          .orderBy(desc(reconciliationPeriods.endDate))
          .limit(1);
        if (p) reconPath = `/reconciliation/${p.id}`;
      }
      const withFrom = (path: string) => `${path}${path.includes('?') ? '&' : '?'}from=tasks`;
      const targetFor = (c: (typeof cards)[number]): string | null => {
        if (c.id === 'onboarding') return withFrom('/ai-chat?onboarding=start');
        if (c.id === 'reconciliation-off') return withFrom(reconPath);
        if (c.id === 'bills-overdue') return withFrom('/bills?filter=overdue');
        switch (c.action.kind) {
          case 'navigate':
            return withFrom(c.action.href);
          case 'open-categorization-workspace':
            return withFrom('/ai-chat?categorize=open');
          case 'plaid-relink':
            return withFrom('/ai-chat');
          default:
            return null; // ask-ai data items → handle in chat
        }
      };
      return {
        count: cards.length,
        items: cards.map((c) => ({
          id: c.id,
          tier: c.tier,
          priority: c.priority,
          title: c.title,
          body: c.body ?? null,
          actionLabel: c.actionLabel,
          action: c.action,
          // The in-app page to take the user to if they agree to act on this
          // item (carries from=tasks for the back link). null = handle in chat.
          targetPath: targetFor(c),
        })),
      };
    }
    case 'open_app_page': {
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      if (!path.startsWith('/')) throw new Error('path must be an in-app path starting with /');
      if (!isAllowedAppPath(path)) {
        return { error: `"${path}" isn't a page I can open. Use the targetPath from list_attention_items, or the navigate tool.` };
      }
      // Onboarding-aware: an incomplete step's page → the onboarding wizard.
      const resolved = await onboardingAwarePath(ctx.organizationId, path);
      const workflow = WORKFLOW_GUIDES[resolved];
      return workflow ? { path: resolved, workflow } : { path: resolved };
    }
    case 'get_org_summary': {
      const [[org], [tCount], [cCount], [aCount], [jeCount]] = await Promise.all([
        db.select().from(organizations).where(eq(organizations.id, ctx.organizationId)).limit(1),
        db.select({ n: count() }).from(transactions).where(eq(transactions.organizationId, ctx.organizationId)),
        db.select({ n: count() }).from(contacts).where(eq(contacts.organizationId, ctx.organizationId)),
        db.select({ n: count() }).from(chartOfAccounts).where(eq(chartOfAccounts.organizationId, ctx.organizationId)),
        db.select({ n: count() }).from(journalEntries).where(eq(journalEntries.organizationId, ctx.organizationId)),
      ]);
      return {
        name: org?.name,
        plan: org?.planType,
        accounting_method: org?.accountingMethod,
        entity_type: org?.entityType,
        counts: {
          transactions: tCount?.n ?? 0,
          contacts: cCount?.n ?? 0,
          accounts: aCount?.n ?? 0,
          journal_entries: jeCount?.n ?? 0,
        },
      };
    }

    case 'get_recent_transactions': {
      const limit = Math.min(25, Math.max(1, Number(args.limit ?? 10)));
      const rows = await db
        .select({
          date: transactions.date,
          description: transactions.description,
          bankDescription: transactions.bankDescription,
          amount: transactions.amount,
          type: transactions.type,
          accountName: chartOfAccounts.accountName,
          contactName: contacts.contactName,
        })
        .from(transactions)
        .leftJoin(chartOfAccounts, eq(transactions.categoryAccountId, chartOfAccounts.id))
        .leftJoin(contacts, eq(transactions.contactId, contacts.id))
        .where(eq(transactions.organizationId, ctx.organizationId))
        .orderBy(desc(transactions.date))
        .limit(limit);
      return rows.map((r) => ({
        date: r.date,
        memo: r.description ?? r.bankDescription,
        amount: r.amount,
        type: r.type,
        account: r.accountName,
        contact: r.contactName,
      }));
    }

    case 'get_account_balance': {
      const accountName = String(args.account_name ?? '').trim();
      if (!accountName) return { error: 'account_name required' };

      const [match] = await db
        .select({
          id: chartOfAccounts.id,
          accountNumber: chartOfAccounts.accountNumber,
          accountName: chartOfAccounts.accountName,
          normalBalance: chartOfAccounts.normalBalance,
          gaapType: chartOfAccounts.gaapType,
        })
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.organizationId, ctx.organizationId),
            sql`LOWER(${chartOfAccounts.accountName}) LIKE ${'%' + accountName.toLowerCase() + '%'}`,
          ),
        )
        .limit(1);
      if (!match) return { error: `No account matching "${accountName}"` };

      const [agg] = await db
        .select({
          totalDebit: sql<string>`COALESCE(SUM(${generalLedger.debit}), 0)`.as('total_debit'),
          totalCredit: sql<string>`COALESCE(SUM(${generalLedger.credit}), 0)`.as('total_credit'),
        })
        .from(generalLedger)
        .where(
          and(eq(generalLedger.organizationId, ctx.organizationId), eq(generalLedger.accountId, match.id)),
        );

      const debit = Number(agg?.totalDebit ?? 0);
      const credit = Number(agg?.totalCredit ?? 0);
      const balance = match.normalBalance === 'debit' ? debit - credit : credit - debit;

      return {
        account_number: match.accountNumber,
        account_name: match.accountName,
        gaap_type: match.gaapType,
        balance,
      };
    }

    case 'get_top_contacts_by_spend': {
      const limit = Math.min(25, Math.max(1, Number(args.limit ?? 10)));
      const fromDate = String(args.from_date ?? '').trim();
      const toDate = String(args.to_date ?? '').trim();

      const conditions = [eq(transactions.organizationId, ctx.organizationId)];
      if (fromDate) conditions.push(gte(transactions.date, fromDate));
      if (toDate) conditions.push(lte(transactions.date, toDate));

      const rows = await db
        .select({
          contactId: contacts.id,
          contactName: contacts.contactName,
          total: sql<string>`COALESCE(SUM(ABS(${transactions.amount})), 0)`.as('total'),
          n: count(),
        })
        .from(transactions)
        .innerJoin(contacts, eq(transactions.contactId, contacts.id))
        .where(and(...conditions))
        .groupBy(contacts.id, contacts.contactName)
        .orderBy(sql`SUM(ABS(${transactions.amount})) DESC`)
        .limit(limit);

      return rows.map((r) => ({ contact: r.contactName, total: Number(r.total), txn_count: r.n }));
    }

    case 'get_period_pnl': {
      const today = new Date().toISOString().slice(0, 10);
      const ytd = `${new Date().getFullYear()}-01-01`;
      const fromDate = String(args.from_date ?? ytd).trim();
      const toDate = String(args.to_date ?? today).trim();
      // Use the SAME engine + basis as the Income Statement report so the AI's
      // numbers always match what the user sees on /reports/income-statement.
      // Basis defaults to the org's saved accounting method (resolveBasis).
      // Basis precedence: explicit user request > the basis they're currently
      // viewing on the page (live toggle) > the org's saved default.
      const requestedBasis =
        args.basis === 'cash' || args.basis === 'accrual'
          ? args.basis
          : ctx.viewBasis === 'cash' || ctx.viewBasis === 'accrual'
            ? ctx.viewBasis
            : undefined;
      const basis = await resolveBasis(ctx.organizationId, requestedBasis);
      const data = await loadIncomeStatement(ctx.organizationId, fromDate, toDate, basis);
      const t = data.totals;
      // "Total revenue" on the report includes other income; "total expenses"
      // includes COGS + opex + other expense. net_income == revenue - expenses.
      const revenue = t.revenue + t.otherIncome;
      const expenses = t.cogs + t.operatingExpenses + t.otherExpenses;
      return {
        from: fromDate,
        to: toDate,
        basis,
        revenue,
        expenses,
        gross_profit: t.grossProfit,
        net_income: t.netIncome,
      };
    }

    case 'get_book_review_findings': {
      const kindArg = args.kind;
      const kind =
        kindArg === 'duplicate' || kindArg === 'integrity' || kindArg === 'anomaly' ? kindArg : undefined;
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 50));

      // Per-kind counts across ALL open findings (not limited) so the totals
      // match the Book Review page header exactly.
      const counts = await db
        .select({ kind: bookReviewFindings.kind, n: count() })
        .from(bookReviewFindings)
        .where(and(eq(bookReviewFindings.organizationId, ctx.organizationId), eq(bookReviewFindings.status, 'open')))
        .groupBy(bookReviewFindings.kind);
      const byKind = { duplicate: 0, integrity: 0, anomaly: 0 } as Record<string, number>;
      for (const c of counts) byKind[c.kind] = Number(c.n);
      const total = byKind.duplicate + byKind.integrity + byKind.anomaly;

      const rows = await db
        .select({
          id: bookReviewFindings.id,
          kind: bookReviewFindings.kind,
          code: bookReviewFindings.code,
          severity: bookReviewFindings.severity,
          message: bookReviewFindings.message,
          transactionId: bookReviewFindings.transactionId,
          relatedTransactionId: bookReviewFindings.relatedTransactionId,
        })
        .from(bookReviewFindings)
        .where(
          and(
            eq(bookReviewFindings.organizationId, ctx.organizationId),
            eq(bookReviewFindings.status, 'open'),
            kind ? eq(bookReviewFindings.kind, kind) : undefined,
          ),
        )
        .orderBy(
          asc(sql`case when ${bookReviewFindings.severity} = 'warn' then 0 else 1 end`),
          desc(bookReviewFindings.createdAt),
        )
        .limit(limit);

      return { total, byKind, count: rows.length, filteredBy: kind ?? 'all', findings: rows };
    }

    case 'create_note': {
      const body = String(args.body ?? '').trim();
      if (!body) return { error: 'body required' };
      if (body.length > 5000) return { error: 'body exceeds 5000 chars' };
      const rawContact = args.contactId;
      const contactId =
        typeof rawContact === 'string' && rawContact.length > 0 ? rawContact : null;

      // Optional meeting link — only honored if the appointment is in this org,
      // so a stray/cross-org id silently degrades to an unlinked note rather
      // than throwing the turn.
      const rawAppt = args.appointmentId;
      let appointmentId: string | null = null;
      if (typeof rawAppt === 'string' && rawAppt.length > 0) {
        const [appt] = await db
          .select({ id: appointments.id })
          .from(appointments)
          .where(and(eq(appointments.id, rawAppt), eq(appointments.organizationId, ctx.organizationId)))
          .limit(1);
        appointmentId = appt?.id ?? null;
      }

      const userId = await getEffectiveUserId();

      // Dedup safety net: if the same user inserted a note with the
      // EXACT same body in the last 60 seconds, return that one
      // instead of creating a second row. Catches AI over-retry loops
      // and mic-echo-induced duplicate turns. 60s is conservative
      // enough that legitimate identical notes (very rare) still
      // succeed on a deliberate second attempt.
      const sixtyAgo = new Date(Date.now() - 60_000).toISOString();
      const [existing] = await db
        .select({ id: notes.id })
        .from(notes)
        .where(
          and(
            eq(notes.userId, userId),
            eq(notes.organizationId, ctx.organizationId),
            eq(notes.body, body),
            gte(notes.createdAt, sixtyAgo),
          ),
        )
        .limit(1);
      if (existing) {
        return { ok: true, id: existing.id, contactId, duplicate: true };
      }

      const id = randomUUID();
      await db.insert(notes).values({
        id,
        userId,
        organizationId: ctx.organizationId,
        contactId,
        appointmentId,
        body,
        source: 'ai',
      });
      return { ok: true, id, contactId, appointmentId };
    }

    case 'complete_task': {
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'id required' };
      const userId = await getEffectiveUserId();
      const updated = await db
        .update(tasks)
        .set({ status: 'DONE', updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(tasks.id, id),
            eq(tasks.userId, userId),
            eq(tasks.organizationId, ctx.organizationId),
          ),
        )
        .returning({ id: tasks.id, title: tasks.title });
      if (updated.length === 0) return { error: `Task ${id} not found.` };
      return { ok: true, id: updated[0].id, title: updated[0].title, status: 'DONE' };
    }

    case 'delete_task': {
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'id required' };
      const userId = await getEffectiveUserId();
      const deleted = await db
        .delete(tasks)
        .where(
          and(
            eq(tasks.id, id),
            eq(tasks.userId, userId),
            eq(tasks.organizationId, ctx.organizationId),
          ),
        )
        .returning({ id: tasks.id, title: tasks.title });
      if (deleted.length === 0) return { error: `Task ${id} not found.` };
      return { ok: true, id: deleted[0].id, title: deleted[0].title };
    }

    case 'update_task': {
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'id required' };
      const userId = await getEffectiveUserId();

      // Confirm ownership before constructing the patch so we don't
      // do anything if the id is bogus / cross-org.
      const [existing] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.id, id),
            eq(tasks.userId, userId),
            eq(tasks.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      if (!existing) return { error: `Task ${id} not found.` };

      // Sparse patch — only mutate columns the AI actually sent. The
      // empty-string convention clears nullable values; dueDate accepts
      // YYYY-MM-DD or a full ISO string. Anything malformed gets
      // surfaced as an error so the AI can retry instead of writing
      // wonky data.
      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };

      if (typeof args.title === 'string' && args.title.trim().length > 0) {
        const t = args.title.trim();
        if (t.length > 200) return { error: 'title exceeds 200 chars' };
        patch.title = t;
      }
      if (typeof args.description === 'string') {
        patch.description = args.description.trim().length > 0 ? args.description.trim() : null;
      }
      if (typeof args.dueDate === 'string') {
        if (args.dueDate.trim().length === 0) {
          patch.dueDate = null;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(args.dueDate.trim())) {
          patch.dueDate = `${args.dueDate.trim()}T00:00:00Z`;
        } else {
          const d = new Date(args.dueDate.trim());
          if (Number.isNaN(d.getTime())) return { error: 'dueDate must be YYYY-MM-DD, ISO 8601, or empty string' };
          patch.dueDate = d.toISOString();
        }
      }
      if (typeof args.priority === 'string') {
        const p = args.priority.trim().toLowerCase();
        if (!['low', 'normal', 'high'].includes(p)) return { error: 'priority must be low|normal|high' };
        patch.priority = p;
      }
      if (typeof args.contactId === 'string') {
        const c = args.contactId.trim();
        patch.assignedToContacts = c.length > 0 ? [c] : [];
      }

      if (Object.keys(patch).length === 1) {
        // Only updatedAt — nothing meaningful to write.
        return { error: 'No fields to update.' };
      }

      await db.update(tasks).set(patch).where(eq(tasks.id, id));
      return { ok: true, id };
    }

    case 'list_my_open_tasks': {
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
      const userId = await getEffectiveUserId();
      const rows = await db
        .select({
          id: tasks.id,
          title: tasks.title,
          dueDate: tasks.dueDate,
          priority: tasks.priority,
          assignedToContacts: tasks.assignedToContacts,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.organizationId, ctx.organizationId),
            eq(tasks.userId, userId),
            eq(tasks.status, 'OPEN'),
          ),
        )
        .orderBy(sql`${tasks.dueDate} IS NULL`, sql`${tasks.dueDate} ASC`, desc(tasks.createdAt))
        .limit(limit);
      return rows.map((r) => {
        const ac = Array.isArray(r.assignedToContacts) ? r.assignedToContacts : [];
        return {
          id: r.id,
          title: r.title,
          dueDate: r.dueDate,
          priority: r.priority,
          contactId: typeof ac[0] === 'string' ? (ac[0] as string) : null,
        };
      });
    }

    case 'get_contact_context': {
      const contactId = String(args.contactId ?? '').trim();
      if (!contactId) return { error: 'contactId required' };
      const userId = await getEffectiveUserId();

      const [contact] = await db
        .select({
          id: contacts.id,
          name: contacts.contactName,
          company: contacts.companyName,
          email: contacts.email,
          phone: contacts.phone,
          isActive: contacts.isActive,
        })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, ctx.organizationId)))
        .limit(1);
      if (!contact) return { error: `Contact ${contactId} not found.` };

      const tasksContainsContact = sql`${tasks.assignedToContacts}::jsonb @> ${JSON.stringify([contactId])}::jsonb`;
      const openTasksWhere = and(
        eq(tasks.organizationId, ctx.organizationId),
        eq(tasks.userId, userId),
        eq(tasks.status, 'OPEN'),
        tasksContainsContact,
      );
      const notesWhere = and(
        eq(notes.userId, userId),
        eq(notes.organizationId, ctx.organizationId),
        eq(notes.contactId, contactId),
      );
      const apptWhere = and(
        eq(appointments.organizationId, ctx.organizationId),
        eq(appointments.userId, userId),
        eq(appointments.contactId, contactId),
        gte(appointments.startsAt, new Date().toISOString()),
      );
      const inboxOpenWhere = and(
        eq(inboxMessages.organizationId, ctx.organizationId),
        eq(inboxMessages.userId, userId),
        eq(inboxMessages.contactId, contactId),
        eq(inboxMessages.status, 'open'),
      );
      const inboxRecentWhere = and(
        eq(inboxMessages.organizationId, ctx.organizationId),
        eq(inboxMessages.userId, userId),
        eq(inboxMessages.contactId, contactId),
      );

      const [
        recentNotes,
        [noteTotal],
        openTasks,
        [taskTotal],
        upcomingAppointments,
        recentInbox,
        [openInboxTotal],
      ] = await Promise.all([
        db
          .select({
            id: notes.id,
            body: notes.body,
            source: notes.source,
            createdAt: notes.createdAt,
          })
          .from(notes)
          .where(notesWhere)
          .orderBy(desc(notes.createdAt))
          .limit(5),
        db.select({ n: count() }).from(notes).where(notesWhere),
        db
          .select({
            id: tasks.id,
            title: tasks.title,
            dueDate: tasks.dueDate,
            priority: tasks.priority,
          })
          .from(tasks)
          .where(openTasksWhere)
          .orderBy(sql`${tasks.dueDate} IS NULL`, sql`${tasks.dueDate} ASC`, desc(tasks.createdAt))
          .limit(5),
        db.select({ n: count() }).from(tasks).where(openTasksWhere),
        db
          .select({
            id: appointments.id,
            title: appointments.title,
            startsAt: appointments.startsAt,
            endsAt: appointments.endsAt,
            location: appointments.location,
          })
          .from(appointments)
          .where(apptWhere)
          .orderBy(sql`${appointments.startsAt} ASC`)
          .limit(5),
        db
          .select({
            id: inboxMessages.id,
            subject: inboxMessages.subject,
            fromAddress: inboxMessages.fromAddress,
            body: inboxMessages.body,
            status: inboxMessages.status,
            receivedAt: inboxMessages.receivedAt,
          })
          .from(inboxMessages)
          .where(inboxRecentWhere)
          .orderBy(desc(inboxMessages.receivedAt))
          .limit(5),
        db.select({ n: count() }).from(inboxMessages).where(inboxOpenWhere),
      ]);

      return {
        contact,
        recent_notes: recentNotes.map((n) => ({
          ...n,
          body: n.body.length > 400 ? n.body.slice(0, 400) + '…' : n.body,
        })),
        open_tasks: openTasks,
        upcoming_appointments: upcomingAppointments,
        recent_inbox_messages: recentInbox.map((m) => ({
          ...m,
          body: m.body.length > 300 ? m.body.slice(0, 300) + '…' : m.body,
        })),
        totals: {
          notes: noteTotal?.n ?? 0,
          open_tasks: taskTotal?.n ?? 0,
          upcoming_appointments: upcomingAppointments.length,
          open_inbox_messages: openInboxTotal?.n ?? 0,
        },
      };
    }

    case 'create_appointment': {
      const title = String(args.title ?? '').trim();
      if (!title) return { error: 'title required' };
      if (title.length > 200) return { error: 'title exceeds 200 chars' };
      const startsAtRaw = String(args.startsAt ?? '').trim();
      const startsAt = startsAtRaw ? new Date(startsAtRaw) : null;
      if (!startsAt || Number.isNaN(startsAt.getTime())) {
        return { error: 'startsAt required as ISO 8601' };
      }
      const endsAtRaw = typeof args.endsAt === 'string' ? args.endsAt.trim() : '';
      const endsAtDate = endsAtRaw ? new Date(endsAtRaw) : null;
      const endsAt =
        endsAtDate && !Number.isNaN(endsAtDate.getTime()) ? endsAtDate.toISOString() : null;
      const description =
        typeof args.description === 'string' && args.description.trim().length > 0
          ? args.description.trim()
          : null;
      const location =
        typeof args.location === 'string' && args.location.trim().length > 0
          ? args.location.trim()
          : null;
      const rawContact = args.contactId;
      const contactId =
        typeof rawContact === 'string' && rawContact.length > 0 ? rawContact : null;

      const userId = await getEffectiveUserId();

      // Dedup safety net — appointments key on (title, startsAt) within
      // a 60s window. Mic-echo loops in voice mode were re-creating
      // the same 3pm meeting four times; this turns the second through
      // Nth call into idempotent no-ops.
      const sixtyAgo = new Date(Date.now() - 60_000).toISOString();
      const [existingAppt] = await db
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.userId, userId),
            eq(appointments.organizationId, ctx.organizationId),
            eq(appointments.title, title),
            eq(appointments.startsAt, startsAt.toISOString()),
            gte(appointments.createdAt, sixtyAgo),
          ),
        )
        .limit(1);
      if (existingAppt) {
        return {
          ok: true,
          id: existingAppt.id,
          startsAt: startsAt.toISOString(),
          endsAt,
          duplicate: true,
        };
      }

      const id = randomUUID();

      // Push to Google FIRST, then insert locally with the resulting
      // google_event_id already set. This sidesteps a race with the
      // sync engine: if we inserted locally first and the dashboard's
      // next sync fired before our UPDATE landed, the sync would
      // INSERT a duplicate row keyed on the same google_event_id.
      let pushed: { id?: string; htmlLink?: string } | null = null;
      let pushError: string | undefined;
      const attendees: string[] = [];
      if (contactId) {
        const [c] = await db
          .select({ email: contacts.email })
          .from(contacts)
          .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, ctx.organizationId)))
          .limit(1);
        if (c?.email) attendees.push(c.email);
      }
      const googleResult = await createGoogleEvent(userId, {
        title,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt ?? null,
        description,
        location,
        attendees,
      });
      if (googleResult.ok && googleResult.id) {
        pushed = { id: googleResult.id, htmlLink: googleResult.htmlLink };
      } else if (googleResult.reason && googleResult.reason !== 'no_connection') {
        // Surface real failures so the AI can mention them to the user.
        // no_connection is silent — the user simply hasn't connected
        // Google, and we don't want a noisy warning on every appointment.
        pushError = googleResult.error ?? googleResult.reason;
      }

      await db.insert(appointments).values({
        id,
        userId,
        organizationId: ctx.organizationId,
        contactId,
        title,
        description,
        startsAt: startsAt.toISOString(),
        endsAt,
        location,
        source: 'ai',
        googleEventId: pushed?.id ?? null,
      });

      return {
        ok: true,
        id,
        startsAt: startsAt.toISOString(),
        endsAt,
        google: pushed
          ? { synced: true, eventId: pushed.id, htmlLink: pushed.htmlLink }
          : { synced: false, error: pushError },
      };
    }

    case 'get_booking_link': {
      const userId = await getEffectiveUserId();
      const [u] = await db
        .select({ fullName: users.fullName, email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const bundle = await getOrCreateBookingProfile({
        userId,
        organizationId: ctx.organizationId,
        seed: u?.fullName || u?.email || 'meet',
      });
      const active = bundle.eventTypes.filter((e) => e.isActive);
      const profileUrl = publicBookingUrl(bundle.profile.slug);
      return {
        ok: true,
        link: profileUrl,
        active: bundle.profile.isActive,
        eventTypes: active.map((e) => ({
          name: e.name,
          durationMinutes: e.durationMinutes,
          url: eventTypeUrl(bundle.profile.slug, e.slug),
        })),
      };
    }

    case 'block_booking_time': {
      const date = String(args.date ?? '').trim();
      if (!date) return { error: 'date required (YYYY-MM-DD)' };
      const rawStart = typeof args.startTime === 'string' ? args.startTime.trim() : '';
      const rawEnd = typeof args.endTime === 'string' ? args.endTime.trim() : '';
      // Both or neither — a half-specified range is ambiguous.
      if ((rawStart && !rawEnd) || (!rawStart && rawEnd)) {
        return { error: 'Provide both startTime and endTime to block a range, or neither to block the whole day.' };
      }
      let startMinute: number | null = null;
      let endMinute: number | null = null;
      if (rawStart && rawEnd) {
        startMinute = hhmmToMinutes(rawStart);
        endMinute = hhmmToMinutes(rawEnd);
        if (startMinute == null || endMinute == null) return { error: "startTime / endTime must be 24h 'HH:MM'." };
      }
      const userId = await getEffectiveUserId();
      const seed = await resolveBookingSeed(userId);
      return await blockTime({ userId, organizationId: ctx.organizationId, seed, date, startMinute, endMinute });
    }

    case 'unblock_booking_time': {
      const date = String(args.date ?? '').trim();
      if (!date) return { error: 'date required (YYYY-MM-DD)' };
      const userId = await getEffectiveUserId();
      const seed = await resolveBookingSeed(userId);
      return await unblockDate({ userId, organizationId: ctx.organizationId, seed, date });
    }

    case 'check_booking_availability': {
      const date = String(args.date ?? '').trim();
      const time = String(args.time ?? '').trim();
      if (!date) return { error: 'date required (YYYY-MM-DD)' };
      const startMinute = hhmmToMinutes(time);
      if (startMinute == null) return { error: "time must be 24h 'HH:MM'." };
      const durationMinutes =
        typeof args.durationMinutes === 'number' && args.durationMinutes > 0 ? Math.floor(args.durationMinutes) : undefined;
      const userId = await getEffectiveUserId();
      const seed = await resolveBookingSeed(userId);
      return await checkAvailability({ userId, organizationId: ctx.organizationId, seed, date, startMinute, durationMinutes });
    }

    case 'list_booking_availability': {
      const from = String(args.from ?? '').trim();
      if (!from) return { error: 'from required (YYYY-MM-DD)' };
      const to = typeof args.to === 'string' && args.to.trim().length > 0 ? args.to.trim() : undefined;
      const durationMinutes =
        typeof args.durationMinutes === 'number' && args.durationMinutes > 0 ? Math.floor(args.durationMinutes) : undefined;
      const userId = await getEffectiveUserId();
      const seed = await resolveBookingSeed(userId);
      return await listAvailability({ userId, organizationId: ctx.organizationId, seed, from, to, durationMinutes });
    }

    case 'update_appointment': {
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'id required' };
      const userId = await getEffectiveUserId();

      const [row] = await db
        .select({
          id: appointments.id,
          googleEventId: appointments.googleEventId,
        })
        .from(appointments)
        .where(
          and(
            eq(appointments.id, id),
            eq(appointments.userId, userId),
            eq(appointments.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      if (!row) return { error: `Appointment ${id} not found.` };

      // Build sparse patch — only fields the AI actually sent. The
      // empty-string convention for endsAt means "clear the value"
      // (Google PATCH treats explicit null as clear).
      const patch: {
        title?: string;
        startsAt?: string;
        endsAt?: string | null;
        description?: string | null;
        location?: string | null;
      } = {};
      if (typeof args.title === 'string' && args.title.trim().length > 0) {
        patch.title = args.title.trim();
        if (patch.title.length > 200) return { error: 'title exceeds 200 chars' };
      }
      if (typeof args.startsAt === 'string' && args.startsAt.trim().length > 0) {
        const d = new Date(args.startsAt.trim());
        if (Number.isNaN(d.getTime())) return { error: 'startsAt must be ISO 8601' };
        patch.startsAt = d.toISOString();
      }
      if (typeof args.endsAt === 'string') {
        if (args.endsAt.trim().length === 0) {
          patch.endsAt = null;
        } else {
          const d = new Date(args.endsAt.trim());
          if (Number.isNaN(d.getTime())) return { error: 'endsAt must be ISO 8601 or empty string' };
          patch.endsAt = d.toISOString();
        }
      }
      if (typeof args.description === 'string') {
        patch.description = args.description.trim().length > 0 ? args.description.trim() : null;
      }
      if (typeof args.location === 'string') {
        patch.location = args.location.trim().length > 0 ? args.location.trim() : null;
      }

      if (Object.keys(patch).length === 0) {
        return { error: 'No fields to update.' };
      }

      // If mirrored to Google: push first. The sync engine treats
      // Google as authoritative for mirrored rows, so updating local
      // without Google would just get clobbered on the next sync.
      let googleResult: { synced: boolean; error?: string } = { synced: false };
      if (row.googleEventId) {
        const r = await updateGoogleEvent(userId, row.googleEventId, patch);
        if (!r.ok && r.reason !== 'gone') {
          return {
            ok: false,
            error: `Couldn't update Google Calendar (${r.reason ?? 'error'}). Local row not changed. ${r.error ?? ''}`.trim(),
          };
        }
        googleResult = { synced: r.ok };
      }

      // Translate patch → DB columns. patch.title maps to title, etc.
      const dbPatch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if (patch.title !== undefined) dbPatch.title = patch.title;
      if (patch.startsAt !== undefined) dbPatch.startsAt = patch.startsAt;
      if (patch.endsAt !== undefined) dbPatch.endsAt = patch.endsAt;
      if (patch.description !== undefined) dbPatch.description = patch.description;
      if (patch.location !== undefined) dbPatch.location = patch.location;

      await db.update(appointments).set(dbPatch).where(eq(appointments.id, id));
      return { ok: true, id, google: googleResult };
    }

    case 'delete_appointment': {
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'id required' };
      const userId = await getEffectiveUserId();

      const [row] = await db
        .select({
          id: appointments.id,
          googleEventId: appointments.googleEventId,
        })
        .from(appointments)
        .where(
          and(
            eq(appointments.id, id),
            eq(appointments.userId, userId),
            eq(appointments.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      if (!row) return { error: `Appointment ${id} not found.` };

      // Push delete to Google first when mirrored. 404/410 = already
      // gone there, which is success-equivalent for our purposes —
      // proceed to delete local.
      let googleResult: { deleted: boolean; alreadyGone?: boolean; error?: string } = { deleted: false };
      if (row.googleEventId) {
        const r = await deleteGoogleEvent(userId, row.googleEventId);
        if (r.ok) {
          googleResult = { deleted: true };
        } else if (r.reason === 'gone') {
          googleResult = { deleted: true, alreadyGone: true };
        } else {
          return {
            ok: false,
            error: `Couldn't delete from Google Calendar (${r.reason ?? 'error'}). Local row not removed. ${r.error ?? ''}`.trim(),
          };
        }
      }

      await db.delete(appointments).where(eq(appointments.id, id));
      return { ok: true, id, google: googleResult };
    }

    case 'list_my_appointments': {
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
      const onlyToday = args.today === true;
      const userId = await getEffectiveUserId();

      // "Today" = [start-of-day, start-of-next-day) in server local time.
      // Approximate enough for a personal calendar — if we add per-user
      // timezone later, swap this to user-tz aware bounds.
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const startOfNextDay = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
      ).toISOString();

      const baseConditions = [
        eq(appointments.organizationId, ctx.organizationId),
        eq(appointments.userId, userId),
      ];
      const conditions = onlyToday
        ? [...baseConditions, gte(appointments.startsAt, startOfDay), lte(appointments.startsAt, startOfNextDay)]
        : [...baseConditions, gte(appointments.startsAt, now.toISOString())];

      const rows = await db
        .select({
          id: appointments.id,
          title: appointments.title,
          startsAt: appointments.startsAt,
          endsAt: appointments.endsAt,
          location: appointments.location,
          contactId: appointments.contactId,
        })
        .from(appointments)
        .where(and(...conditions))
        .orderBy(sql`${appointments.startsAt} ASC`)
        .limit(limit);
      return rows;
    }

    case 'list_inbox': {
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
      const userId = await getEffectiveUserId();
      const rows = await db
        .select({
          id: inboxMessages.id,
          source: inboxMessages.source,
          fromAddress: inboxMessages.fromAddress,
          fromName: inboxMessages.fromName,
          subject: inboxMessages.subject,
          body: inboxMessages.body,
          receivedAt: inboxMessages.receivedAt,
          contactId: inboxMessages.contactId,
        })
        .from(inboxMessages)
        .where(
          and(
            eq(inboxMessages.organizationId, ctx.organizationId),
            eq(inboxMessages.userId, userId),
            eq(inboxMessages.status, 'open'),
          ),
        )
        .orderBy(desc(inboxMessages.receivedAt))
        .limit(limit);
      // Truncate body to keep the AI's tool-result window small — the
      // dashboard renders the full body, but the AI rarely needs it.
      return rows.map((r) => ({
        ...r,
        body: r.body.length > 500 ? r.body.slice(0, 500) + '…' : r.body,
      }));
    }

    case 'triage_inbox_message': {
      const id = String(args.id ?? '').trim();
      const status = String(args.status ?? '').trim();
      if (!id) return { error: 'id required' };
      if (status !== 'triaged' && status !== 'archived') {
        return { error: 'status must be "triaged" or "archived"' };
      }
      const userId = await getEffectiveUserId();
      const updated = await db
        .update(inboxMessages)
        .set({ status, triagedAt: new Date().toISOString() })
        .where(
          and(
            eq(inboxMessages.id, id),
            eq(inboxMessages.organizationId, ctx.organizationId),
            eq(inboxMessages.userId, userId),
          ),
        )
        .returning({ id: inboxMessages.id });
      if (updated.length === 0) return { error: `Message ${id} not found.` };
      return { ok: true, id, status };
    }

    case 'send_email': {
      const subject = String(args.subject ?? '').trim();
      const body = String(args.body ?? '').trim();
      const rawTo = String(args.to ?? '').trim();
      const replyTo = typeof args.replyTo === 'string' ? args.replyTo.trim() : '';

      if (!rawTo) return { error: 'to required' };
      if (!subject) return { error: 'subject required' };
      if (subject.length > 200) return { error: 'subject exceeds 200 chars' };
      if (!body) return { error: 'body required' };
      if (body.length > 10000) return { error: 'body exceeds 10000 chars' };

      // `to` is either a literal address or a contactId. We treat anything
      // without an '@' as a contactId and resolve it; this matches the
      // tool description and avoids round-tripping for the common case.
      let toEmail = rawTo;
      let resolvedContactName: string | null = null;
      if (!rawTo.includes('@')) {
        const [contact] = await db
          .select({ email: contacts.email, name: contacts.contactName })
          .from(contacts)
          .where(and(eq(contacts.id, rawTo), eq(contacts.organizationId, ctx.organizationId)))
          .limit(1);
        if (!contact) return { error: `Contact ${rawTo} not found.` };
        if (!contact.email) return { error: `Contact ${contact.name} has no email on file.` };
        toEmail = contact.email;
        resolvedContactName = contact.name;
      }

      // Prefer the user's linked mailbox (from their real address); fall back
      // to Resend when they haven't connected one.
      const emailUserId = await getEffectiveUserId();
      const result = await sendAsUser({
        userId: emailUserId,
        to: toEmail,
        subject,
        text: body,
        ...(replyTo ? { replyTo } : {}),
      });
      if (!result.sent) {
        return { ok: false, error: result.error ?? 'Send failed.' };
      }
      return { ok: true, to: toEmail, contactName: resolvedContactName, messageId: result.messageId };
    }

    case 'draft_organizer_email': {
      const to = String(args.to ?? '').trim();
      const subject = String(args.subject ?? '').trim();
      const body = String(args.body ?? '').trim();
      const includeBookingLink = args.include_booking_link === true;
      if (!to) return { error: 'to required' };
      if (!subject) return { error: 'subject required' };
      if (!body) return { error: 'body required' };
      const userId = await getEffectiveUserId();
      // Resolve recipient for the preview (validates it exists + has an email).
      const recip = await resolveEmailRecipient(ctx.organizationId, to);
      if ('error' in recip) return { error: recip.error };
      const bookingLink = includeBookingLink
        ? await resolveBookingLink(userId, ctx.organizationId)
        : null;
      return {
        ok: true,
        kind: 'organizer_email_draft',
        draftId: randomUUID(),
        to, // contactId or email — what the commit path sends with
        toEmail: recip.email,
        toName: recip.name,
        contactId: recip.contactId,
        subject,
        body,
        includeBookingLink,
        bookingLink,
      };
    }

    case 'send_organizer_email': {
      const to = String(args.to ?? '').trim();
      const subject = String(args.subject ?? '').trim();
      const body = String(args.body ?? '').trim();
      const includeBookingLink = args.include_booking_link === true;
      const userId = await getEffectiveUserId();
      const result = await sendOrganizerEmail({
        orgId: ctx.organizationId,
        userId,
        to,
        subject,
        body,
        includeBookingLink,
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { kind: 'organizer_email_sent', ...result };
    }

    case 'draft_video_invite': {
      const to = String(args.to ?? '').trim();
      if (!to) return { error: 'to required' };
      const subject = String(args.subject ?? '').trim() || 'Video call invite';
      const body = String(args.body ?? '').trim() || 'Click the link below to join my video call.';
      const userId = await getEffectiveUserId();
      const invite = await createVideoInvite(userId, ctx.organizationId, to);
      if ('error' in invite) return { error: invite.error };
      return {
        ok: true,
        kind: 'video_invite_draft',
        draftId: randomUUID(),
        to,
        toEmail: invite.toEmail,
        toName: invite.toName,
        contactId: invite.contactId,
        subject,
        body,
        roomName: invite.roomName,
        joinUrl: invite.joinUrl,
      };
    }

    case 'send_video_invite': {
      const to = String(args.to ?? '').trim();
      const joinUrl = String(args.joinUrl ?? '').trim();
      if (!to || !joinUrl) return { error: 'to and joinUrl required' };
      const subject = String(args.subject ?? '').trim() || 'Video call invite';
      const body = String(args.body ?? '').trim() || 'Click the link below to join my video call.';
      const userId = await getEffectiveUserId();
      const result = await sendOrganizerEmail({
        orgId: ctx.organizationId,
        userId,
        to,
        subject,
        body,
        extraLink: { label: 'Join the video call:', url: joinUrl },
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { kind: 'video_invite_sent', ...result, joinUrl };
    }

    case 'find_document': {
      const q = String(args.title_query ?? '').trim();
      const userId = await getEffectiveUserId();
      const matches = await findDocument(ctx.organizationId, userId, q);
      return { ok: true, matches };
    }

    case 'draft_signature_request': {
      const to = String(args.to ?? '').trim();
      const documentId = String(args.document_id ?? '').trim();
      if (!to || !documentId) return { error: 'to and document_id required' };
      const recip = await resolveEmailRecipient(ctx.organizationId, to);
      if ('error' in recip) return { error: recip.error };
      const doc = await getDocument(ctx.organizationId, documentId);
      if (!doc) return { error: 'Document not found.' };
      return {
        ok: true,
        kind: 'signature_draft',
        draftId: randomUUID(),
        to,
        toEmail: recip.email,
        toName: recip.name,
        contactId: recip.contactId,
        documentId,
        documentTitle: doc.title,
      };
    }

    case 'send_signature_request': {
      const to = String(args.to ?? '').trim();
      const documentId = String(args.document_id ?? '').trim();
      if (!to || !documentId) return { error: 'to and document_id required' };
      const userId = await getEffectiveUserId();
      const result = await sendDocumentForSignature({ orgId: ctx.organizationId, userId, to, documentId });
      if (!result.ok) return { ok: false, error: result.error };
      return { kind: 'signature_sent', ...result };
    }

    case 'draft_send_document': {
      const to = String(args.to ?? '').trim();
      const documentId = String(args.document_id ?? '').trim();
      if (!to || !documentId) return { error: 'to and document_id required' };
      const recip = await resolveEmailRecipient(ctx.organizationId, to);
      if ('error' in recip) return { error: recip.error };
      const doc = await getDocument(ctx.organizationId, documentId);
      if (!doc) return { error: 'Document not found.' };
      if (doc.source === 'uploaded' && doc.mimeType !== 'application/pdf') {
        return { error: 'Only PDF uploads can be emailed. Convert it first, or pick a created document.' };
      }
      const subject = String(args.subject ?? '').trim() || `Document: ${doc.title}`;
      const body =
        String(args.body ?? '').trim() ||
        `Hi${recip.name ? ` ${recip.name}` : ''}, here's ${doc.title} — attached as a PDF.`;
      return {
        ok: true,
        kind: 'send_document_draft',
        draftId: randomUUID(),
        to,
        toEmail: recip.email,
        toName: recip.name,
        contactId: recip.contactId,
        documentId,
        documentTitle: doc.title,
        subject,
        body,
      };
    }

    case 'send_document': {
      const to = String(args.to ?? '').trim();
      const documentId = String(args.document_id ?? '').trim();
      if (!to || !documentId) return { error: 'to and document_id required' };
      const subject = typeof args.subject === 'string' ? args.subject.trim() : undefined;
      const body = typeof args.body === 'string' ? args.body.trim() : undefined;
      const userId = await getEffectiveUserId();
      const result = await sendDocumentToContact({ orgId: ctx.organizationId, userId, to, documentId, subject, body });
      if (!result.ok) return { ok: false, error: result.error };
      return { kind: 'send_document_sent', ...result };
    }

    case 'send_text_to_contact': {
      const rawContactId = String(args.contactId ?? '').trim();
      const body = String(args.body ?? '').trim();
      if (!rawContactId) return { ok: false, error: 'contactId required' };
      if (!body) return { ok: false, error: 'body required' };
      if (body.length > 1600) return { ok: false, error: 'body exceeds 1600 chars' };

      const userId = await getEffectiveUserId();
      if (!(await isTextsEnabled(userId))) {
        return { ok: false, error: 'Texts is not enabled for your account.' };
      }

      const [contact] = await db
        .select({ id: contacts.id, name: contacts.contactName, phone: contacts.phone })
        .from(contacts)
        .where(and(eq(contacts.id, rawContactId), eq(contacts.organizationId, ctx.organizationId)))
        .limit(1);
      if (!contact) return { ok: false, error: `Contact ${rawContactId} not found.` };
      if (!contact.phone) {
        return { ok: false, error: `${contact.name} has no phone number on file.` };
      }

      const toPhone = normalizePhone(contact.phone);
      if (!E164_RE.test(toPhone)) {
        return { ok: false, error: `${contact.name}'s phone (${contact.phone}) is not a valid number.` };
      }

      const fromPhone = process.env.TWILIO_FROM_NUMBER ?? '';
      const id = randomUUID();

      if (!isTwilioConfigured()) {
        await db.insert(textMessages).values({
          id,
          organizationId: ctx.organizationId,
          contactId: contact.id,
          direction: 'outbound',
          fromPhone,
          toPhone,
          body,
          status: 'skipped',
          sentByUserId: userId,
          error: 'Twilio env not configured',
        });
        return {
          ok: false,
          error: 'Twilio is not configured — message saved locally but not sent.',
          id,
          contactId: contact.id,
          contactName: contact.name,
          contactPhone: toPhone,
          body,
          status: 'skipped',
          sentAt: new Date().toISOString(),
        };
      }

      const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
      const statusCallback =
        baseUrl && baseUrl.startsWith('https://')
          ? `${baseUrl.replace(/\/$/, '')}/api/twilio/status`
          : undefined;
      const result = await sendTransactionalSms({
        to: toPhone,
        body,
        statusCallback,
        usage: { userId, orgId: ctx.organizationId, actor: 'ai-chat', feature: 'ai-sms' },
      });

      await db.insert(textMessages).values({
        id,
        organizationId: ctx.organizationId,
        contactId: contact.id,
        direction: 'outbound',
        fromPhone: result.from ?? fromPhone,
        toPhone,
        body,
        status: result.sent ? 'sent' : 'failed',
        providerMessageId: result.id ?? null,
        segments: result.segments ?? null,
        sentByUserId: userId,
        error: result.sent ? null : (result.error ?? 'unknown'),
      });

      return {
        ok: result.sent,
        id,
        contactId: contact.id,
        contactName: contact.name,
        contactPhone: toPhone,
        fromPhone: result.from ?? fromPhone,
        body,
        status: result.sent ? 'sent' : 'failed',
        segments: result.segments ?? null,
        sentAt: new Date().toISOString(),
        error: result.sent ? null : (result.error ?? 'send failed'),
      };
    }

    case 'create_task': {
      const title = String(args.title ?? '').trim();
      if (!title) return { error: 'title required' };
      if (title.length > 200) return { error: 'title exceeds 200 chars' };
      const description =
        typeof args.description === 'string' && args.description.trim().length > 0
          ? args.description.trim()
          : null;
      const rawPriority = typeof args.priority === 'string' ? args.priority.trim().toLowerCase() : '';
      const priority = ['low', 'normal', 'high'].includes(rawPriority) ? rawPriority : null;
      // Accept YYYY-MM-DD; store as the day's midnight UTC. Anything else
      // gets dropped rather than thrown so a wonky AI date doesn't blow
      // the turn — the user can always edit on the tasks page.
      const rawDue = typeof args.dueDate === 'string' ? args.dueDate.trim() : '';
      const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDue) ? `${rawDue}T00:00:00Z` : null;
      const rawContact = args.contactId;
      const assignedToContacts =
        typeof rawContact === 'string' && rawContact.length > 0 ? [rawContact] : [];

      const userId = await getEffectiveUserId();

      // Dedup safety net — same shape as create_note. The AI tends to
      // re-call create_task on retry turns even when the task already
      // landed; suppress within a 60s exact-title window so the
      // dashboard doesn't fill up with copies.
      const sixtyAgo = new Date(Date.now() - 60_000).toISOString();
      const [existingTask] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.userId, userId),
            eq(tasks.organizationId, ctx.organizationId),
            eq(tasks.title, title),
            eq(tasks.status, 'OPEN'),
            gte(tasks.createdAt, sixtyAgo),
          ),
        )
        .limit(1);
      if (existingTask) {
        return { ok: true, id: existingTask.id, title, dueDate, duplicate: true };
      }

      const id = randomUUID();
      await db.insert(tasks).values({
        id,
        userId,
        organizationId: ctx.organizationId,
        product: 'organizer',
        page: '/organizer/dashboard',
        title,
        description,
        priority,
        dueDate,
        status: 'OPEN',
        source: 'ai',
        autoCreated: true,
        reviewRequired: false,
        assignedToUsers: [userId],
        assignedToContacts,
        subitems: [],
      });
      return { ok: true, id, title, dueDate };
    }

    case 'link_task':
    case 'unlink_task': {
      const taskId = String(args.taskId ?? '').trim();
      const entityType = String(args.entityType ?? '').trim();
      const entityId = String(args.entityId ?? '').trim();
      if (!taskId || !entityId) return { error: 'taskId and entityId required' };
      if (!isTaskLinkEntityType(entityType)) {
        return { error: 'entityType must be one of contact|note|appointment|inbox_message|text_message' };
      }
      const userId = await getEffectiveUserId();
      const [own] = await db
        .select({ id: tasks.id, assigned: tasks.assignedToContacts })
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), eq(tasks.organizationId, ctx.organizationId)))
        .limit(1);
      if (!own) return { error: `Task ${taskId} not found.` };

      const linking = name === 'link_task';
      if (linking && !(await entityExistsInOrg(ctx.organizationId, entityType as TaskLinkEntityType, entityId))) {
        return { error: 'Linked item not found in this workspace.' };
      }

      if (entityType === 'contact') {
        const ids = Array.isArray(own.assigned)
          ? (own.assigned as unknown[]).filter((v): v is string => typeof v === 'string')
          : [];
        const next = linking ? (ids.includes(entityId) ? ids : [...ids, entityId]) : ids.filter((c) => c !== entityId);
        await db.update(tasks).set({ assignedToContacts: next, updatedAt: new Date().toISOString() }).where(eq(tasks.id, taskId));
      } else if (linking) {
        await db
          .insert(taskLinks)
          .values({ id: randomUUID(), organizationId: ctx.organizationId, taskId, entityType, entityId })
          .onConflictDoNothing();
      } else {
        await db
          .delete(taskLinks)
          .where(
            and(
              eq(taskLinks.organizationId, ctx.organizationId),
              eq(taskLinks.taskId, taskId),
              eq(taskLinks.entityType, entityType),
              eq(taskLinks.entityId, entityId),
            ),
          );
      }
      return { ok: true, taskId, entityType, entityId, linked: linking };
    }

    default:
      if (isRealtimeToolName(name)) {
        return await executeRealtimeTool(ctx.organizationId, name, args, ctx.turnId);
      }
      return { error: `Unknown tool: ${name}` };
  }
}
