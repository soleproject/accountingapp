/**
 * The set of in-app pages the AI assistant is allowed to send a user to. Pure
 * module (no db/server-only) so both the server tool executors and the client
 * dispatch can validate against it — a hallucinated path (e.g. /bank_connections)
 * is rejected instead of causing a 404. Query strings are allowed; only the
 * pathname is checked.
 */
export const ALLOWED_APP_PATHS = new Set<string>([
  '/dashboard',
  '/pulse',
  '/transactions',
  '/invoices',
  '/invoices/new',
  '/invoices/follow-up',
  '/bills',
  '/payments',
  '/payments/new',
  '/receipts',
  '/receipts/new',
  '/receipts/upload',
  '/reports',
  '/reports/balance-sheet',
  '/reports/income-statement',
  '/reports/cash-flow',
  '/reports/trial-balance',
  '/reports/general-ledger',
  '/reports/form-1099',
  '/reports/sales-tax',
  '/substantiation',
  '/year-end-close',
  '/contacts',
  '/contacts/new',
  '/imports',
  '/imports/new',
  '/integrations/plaid',
  '/integrations/qbo',
  '/plaid-feed',
  '/connections/communications',
  '/reconciliation',
  '/period-close',
  '/book-review',
  '/general-ledger',
  '/assets',
  '/assets/new',
  '/loans',
  '/loans/new',
  '/inventory',
  '/tags',
  '/rental-properties',
  '/rental-properties/new',
  '/chart-of-accounts',
  '/journal-entries',
  '/journal-entries/new',
  '/businesses',
  '/personal',
  '/taxes',
  '/tasks',
  '/activity',
  '/settings',
  '/ai-chat',
  // Enterprise (firm) area — the AI staff-accountant surface.
  '/enterprise/dashboard',
  '/enterprise/clients',
  '/enterprise/clients/new',
  '/enterprise/clients/import',
  '/enterprise/clients/add-company',
  '/enterprise/businesses',
  '/enterprise/work',
  '/enterprise/review-accountability',
  '/enterprise/billing',
  '/enterprise/communications',
  '/enterprise/share',
  '/enterprise/staff',
  '/enterprise/activity',
  '/enterprise/settings',
  '/enterprise/onboarding',
]);

export function isAllowedAppPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  const pathname = path.split('?')[0].split('#')[0];
  if (ALLOWED_APP_PATHS.has(pathname)) return true;
  // Transaction detail page (e.g. open_transaction split mode →
  // /transactions/<id>?mode=split). One id segment only; the open_transaction
  // tool already org-scopes the id before handing us this path.
  if (/^\/transactions\/[^/]+$/.test(pathname)) return true;
  // Enterprise dynamic detail pages: client [id] (+ bookkeeping/edit), business
  // [orgId]/edit, per-client billing [id]. Pages access-check org-scope themselves.
  if (/^\/enterprise\/clients\/[^/]+(\/(bookkeeping|edit))?$/.test(pathname)) return true;
  if (/^\/enterprise\/businesses\/[^/]+\/edit$/.test(pathname)) return true;
  if (/^\/enterprise\/billing\/[^/]+$/.test(pathname)) return true;
  return false;
}
