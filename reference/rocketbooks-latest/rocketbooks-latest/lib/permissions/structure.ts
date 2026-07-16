/**
 * Product-aligned permission catalog used by the SuperAdmin permission-set editor.
 * Sections mirror the products' left sidebars. Keys are stable namespaced strings
 * stored in the `permissions` table; descriptions live in the catalog, not in DB.
 *
 * Ported from ai_platform with bug fixes (deduped Documents/Tasks key, split
 * Transactions-by-contact key) and adjustments to point at rocketsuite paths.
 *
 * NOTE: any key referencing Plaid/QBO/Veryfi here only gates *page visibility*.
 * It does not touch the ingest/categorization pipeline — that path is owned by
 * the app code and is intentionally outside this catalog's reach.
 */

export type PermissionItem = {
  key: string;
  label: string;
  path?: string | null;
};

export type PermissionGroup = {
  id: string;
  label: string;
  items: PermissionItem[];
};

export type ProductSection = {
  id:
    | 'accounting'
    | 'onboarding'
    | 'ai'
    | 'payroll'
    | 'taxes'
    | 'documents'
    | 'organizer'
    | 'personal'
    | 'enterprise'
    | 'superadmin';
  label: string;
  groups: PermissionGroup[];
  unpublished: PermissionItem[];
};

export const PERMISSION_SECTIONS: ProductSection[] = [
  {
    id: 'accounting',
    label: 'Accounting',
    groups: [
      {
        id: 'accounting-access',
        label: 'Product Access',
        items: [
          { key: 'accounting.access', label: 'Show Accounting in product switcher' },
        ],
      },
      {
        id: 'accounting-dashboard',
        label: 'Dashboard',
        items: [
          { key: 'accounting.dashboard.view', label: 'Dashboard', path: '/dashboard' },
          { key: 'accounting.pulse.view', label: 'Pulse', path: '/pulse' },
        ],
      },
      {
        id: 'accounting-ai-tasks',
        label: 'AI & Tasks',
        items: [
          { key: 'accounting.ai_chat.view', label: 'AI Assistant', path: '/ai-chat' },
          { key: 'accounting.tasks.view', label: 'Tasks', path: '/tasks' },
        ],
      },
      {
        id: 'accounting-transactions',
        label: 'Transactions',
        items: [
          { key: 'accounting.transactions.view', label: 'Transactions', path: '/transactions' },
          { key: 'accounting.transactions.accountant_review', label: 'Accountant review lens (AI confidence + evidence)' },
          { key: 'accounting.reconciliation.view', label: 'Reconciliation', path: '/reconciliation' },
        ],
      },
      {
        id: 'accounting-receipts',
        label: 'Receipts',
        items: [
          { key: 'accounting.receipts.view', label: 'Receipts', path: '/receipts' },
          { key: 'accounting.receipts.ai_button', label: 'Receipt AI Button' },
        ],
      },
      {
        id: 'accounting-invoices-bills',
        label: 'Invoices & Bills',
        items: [
          { key: 'accounting.invoices.view', label: 'Invoices', path: '/invoices' },
          { key: 'accounting.bills.view', label: 'Bills', path: '/bills' },
          { key: 'accounting.payments.view', label: 'Payments', path: '/payments' },
        ],
      },
      {
        id: 'accounting-contacts',
        label: 'Contacts',
        items: [
          { key: 'accounting.contacts.view', label: 'Contacts', path: '/contacts' },
        ],
      },
      {
        id: 'accounting-ledger',
        label: 'Ledger & COA',
        items: [
          { key: 'accounting.chart_of_accounts.view', label: 'Chart of Accounts', path: '/chart-of-accounts' },
          { key: 'accounting.journal_entries.view', label: 'Journal Entries', path: '/journal-entries' },
          { key: 'accounting.general_ledger.view', label: 'General Ledger', path: '/general-ledger' },
        ],
      },
      {
        id: 'accounting-inventory',
        label: 'Inventory',
        items: [
          // Pro-tier only (lib/accounting/tiers.ts). Net-new product — the page
          // is a gated stub for now and the full module ships later. Keeping the
          // key here lets the Pro permission set + sidebar gate it from day one.
          { key: 'accounting.inventory.view', label: 'Inventory', path: '/inventory' },
        ],
      },
      {
        id: 'accounting-reports',
        label: 'Reports',
        items: [
          { key: 'accounting.reports.view', label: 'Reports', path: '/reports' },
        ],
      },
      {
        id: 'accounting-tools',
        label: 'Tools & Connections',
        items: [
          { key: 'accounting.imports.view', label: 'Imports', path: '/imports' },
          { key: 'accounting.connect_plaid.view', label: 'Bank Connections (Plaid)', path: '/integrations/plaid' },
          { key: 'accounting.plaid_feed.view', label: 'Plaid Feed', path: '/plaid-feed' },
        ],
      },
      {
        id: 'accounting-setup',
        label: 'Setup & Workspace',
        items: [
          { key: 'accounting.businesses.view', label: 'Businesses', path: '/businesses' },
          { key: 'accounting.activity.view', label: 'Activity', path: '/activity' },
          { key: 'accounting.settings.view', label: 'Settings', path: '/settings' },
        ],
      },
    ],
    unpublished: [
      { key: 'accounting.transactions.by_contact.view', label: 'Transactions by Contact', path: '/transactions/by-contact' },
    ],
  },
  {
    id: 'onboarding',
    label: 'Onboarding',
    groups: [
      {
        id: 'onboarding-steps',
        label: 'Onboarding Steps',
        items: [
          { key: 'onboarding.business_basics', label: 'Business Basics' },
          { key: 'onboarding.connect_bank', label: 'Connect Bank' },
          { key: 'onboarding.upload_docs', label: 'Upload Documents' },
          { key: 'onboarding.upload_receipts', label: 'Upload Receipts' },
          { key: 'onboarding.upload_bills', label: 'Upload Bills' },
          { key: 'onboarding.review', label: 'Review' },
        ],
      },
    ],
    unpublished: [],
  },
  {
    id: 'ai',
    label: 'AI',
    groups: [
      {
        id: 'ai-modes',
        label: 'AI Modes',
        items: [
          { key: 'ai.realtime_voice', label: 'Realtime Voice Mode' },
        ],
      },
    ],
    unpublished: [],
  },
  {
    id: 'payroll',
    label: 'Payroll',
    groups: [
      {
        id: 'payroll-main',
        label: 'Payroll',
        items: [
          { key: 'payroll.employees.view', label: 'Employees' },
          { key: 'payroll.payruns.view', label: 'Pay Runs' },
          { key: 'payroll.reports.view', label: 'Payroll Reports' },
        ],
      },
    ],
    unpublished: [
      { key: 'payroll.tax_filings.view', label: 'Tax Filings' },
    ],
  },
  {
    id: 'taxes',
    label: 'Taxes',
    groups: [
      {
        id: 'taxes-main',
        label: 'Taxes',
        items: [
          { key: 'tax.organizer.view', label: 'Tax Organizer', path: '/taxes' },
        ],
      },
    ],
    unpublished: [
      { key: 'tax.documents.view', label: 'Tax Documents' },
      { key: 'tax.filing_status.view', label: 'Filing Status' },
      { key: 'tax.estimated_payments.view', label: 'Estimated Payments' },
    ],
  },
  {
    id: 'documents',
    label: 'Documents',
    groups: [
      {
        id: 'documents-main',
        label: 'Documents',
        items: [
          { key: 'documents.workspace.view', label: 'Workspace' },
          { key: 'documents.tasks.view', label: 'Tasks' },
        ],
      },
    ],
    unpublished: [],
  },
  {
    id: 'organizer',
    label: 'Organizer',
    groups: [
      {
        id: 'organizer-access',
        label: 'Product Access',
        items: [
          { key: 'organizer.access', label: 'Show Organizer in product switcher' },
        ],
      },
      {
        id: 'organizer-main',
        label: 'Organizer',
        items: [
          { key: 'organizer.document_requests.view', label: 'Document Requests' },
        ],
      },
    ],
    unpublished: [
      { key: 'organizer.file_uploads.view', label: 'File Uploads' },
      { key: 'organizer.client_tasks.view', label: 'Client Tasks' },
    ],
  },
  {
    id: 'personal',
    label: 'Personal',
    groups: [
      {
        id: 'personal-main',
        label: 'Personal',
        items: [
          { key: 'personal.dashboard.view', label: 'Personal Dashboard', path: '/personal' },
          { key: 'personal.budgeting.view', label: 'Budgeting' },
          { key: 'personal.goals.view', label: 'Goals' },
        ],
      },
    ],
    unpublished: [],
  },
  {
    id: 'enterprise',
    label: 'Enterprise',
    groups: [
      {
        id: 'enterprise-dashboard',
        label: 'Dashboard',
        items: [
          { key: 'enterprise.dashboard.view', label: 'Enterprise Dashboard', path: '/enterprise/dashboard' },
        ],
      },
      {
        id: 'enterprise-clients',
        label: 'Clients & Staff',
        items: [
          { key: 'enterprise.clients.view', label: 'Clients', path: '/enterprise/clients' },
          { key: 'enterprise.staff.view', label: 'Staff', path: '/enterprise/staff' },
        ],
      },
      {
        id: 'enterprise-activity',
        label: 'Activity',
        items: [
          { key: 'enterprise.activity.view', label: 'Activity', path: '/enterprise/activity' },
        ],
      },
      {
        id: 'enterprise-settings',
        label: 'Settings',
        items: [
          { key: 'enterprise.settings.view', label: 'Settings', path: '/enterprise/settings' },
        ],
      },
    ],
    unpublished: [],
  },
  {
    id: 'superadmin',
    label: 'Super Admin',
    groups: [
      {
        id: 'superadmin-dashboard',
        label: 'Dashboard',
        items: [
          { key: 'superadmin.dashboard.view', label: 'Global Dashboard', path: '/super-admin/dashboard' },
        ],
      },
      {
        id: 'superadmin-users',
        label: 'Users',
        items: [
          { key: 'superadmin.users.view', label: 'All Users', path: '/super-admin/all-users' },
          { key: 'superadmin.admin.view', label: 'Admin', path: '/super-admin/admin' },
          { key: 'superadmin.enterprise_users.view', label: 'Enterprise Users', path: '/super-admin/enterprise-users' },
        ],
      },
      {
        id: 'superadmin-enterprises',
        label: 'Enterprises',
        items: [
          { key: 'superadmin.enterprises.view', label: 'Enterprises', path: '/super-admin/enterprises' },
        ],
      },
      {
        id: 'superadmin-permissions',
        label: 'Permission Sets',
        items: [
          { key: 'superadmin.permission_sets.view', label: 'Permission Sets', path: '/super-admin/permission-sets' },
          { key: 'superadmin.permission_sets.manage', label: 'Manage Permission Sets' },
        ],
      },
      {
        id: 'superadmin-health',
        label: 'System Health',
        items: [
          { key: 'superadmin.logos_report.view', label: 'Logos Report', path: '/super-admin/logos-report' },
        ],
      },
      {
        id: 'superadmin-audit',
        label: 'Audit Logs',
        items: [
          { key: 'superadmin.activity_log.view', label: 'Activity Log', path: '/super-admin/activity-log' },
        ],
      },
      {
        id: 'superadmin-settings',
        label: 'Settings',
        items: [
          { key: 'superadmin.settings.view', label: 'Settings', path: '/super-admin/settings' },
        ],
      },
    ],
    unpublished: [],
  },
];

/**
 * Map of route path → required permission key. Built from the catalog at module
 * load. Used by the sidebar filter and per-page guards.
 */
const PATH_TO_KEY = (() => {
  const m = new Map<string, string>();
  for (const section of PERMISSION_SECTIONS) {
    for (const group of section.groups) {
      for (const item of group.items) {
        if (item.path && !m.has(item.path)) m.set(item.path, item.key);
      }
    }
  }
  return m;
})();

/**
 * Return the permission key required to view a given pathname, or null if no
 * catalog entry covers it (in which case the route is treated as not gated).
 * Matches the longest catalog path that is a prefix of pathname.
 */
export function permissionKeyForPath(pathname: string): string | null {
  if (PATH_TO_KEY.has(pathname)) return PATH_TO_KEY.get(pathname)!;
  let best: { len: number; key: string } | null = null;
  for (const [path, key] of PATH_TO_KEY) {
    if (pathname === path || pathname.startsWith(path + '/')) {
      if (!best || path.length > best.len) best = { len: path.length, key };
    }
  }
  return best?.key ?? null;
}

/**
 * Map of product → permission keys for that product. The workspace/product
 * switcher shows a product if the user holds AT LEAST ONE of these keys
 * (or is in allow_all mode). Keep the values broad — gating the dropdown
 * entry is meant to mirror "can the user do anything in this product",
 * not "can they see every page within it".
 *
 * Add a new entry here when you add a new top-level product to the dropdown.
 * The mechanism does not care whether the WorkspaceKey type knows about it
 * yet — but you'll also want to extend WorkspaceKey in workspace-types.ts.
 */
export const PRODUCT_PERMISSIONS: Record<string, string[]> = {
  // 'main' is the Accounting workspace. Its dropdown entry is gated solely by the
  // dedicated access key so toggling the "Show Accounting…" checkbox in a
  // permission set actually shows/hides the product.
  main: ['accounting.access'],
  accounting: ['accounting.access'],
  payroll: ['payroll.employees.view', 'payroll.payruns.view', 'payroll.reports.view'],
  taxes: ['tax.organizer.view'],
  documents: ['documents.workspace.view', 'documents.tasks.view'],
  organizer: ['organizer.access'],
  personal: ['personal.dashboard.view', 'personal.budgeting.view', 'personal.goals.view'],
  enterprise: [
    'enterprise.dashboard.view',
    'enterprise.clients.view',
    'enterprise.staff.view',
    'enterprise.activity.view',
    'enterprise.settings.view',
  ],
  'super-admin': [
    'superadmin.dashboard.view',
    'superadmin.users.view',
    'superadmin.enterprises.view',
    'superadmin.permission_sets.view',
    'superadmin.logos_report.view',
    'superadmin.activity_log.view',
    'superadmin.settings.view',
  ],
};

/** Permission keys whose presence reveals a product in the workspace dropdown. */
export function permissionsForProduct(productKey: string): string[] {
  return PRODUCT_PERMISSIONS[productKey] ?? [];
}

/** Flat list of every well-known key in the catalog. */
export function allPermissionKeys(): { key: string; description: string }[] {
  const out: { key: string; description: string }[] = [];
  const seen = new Set<string>();
  for (const section of PERMISSION_SECTIONS) {
    for (const group of section.groups) {
      for (const item of group.items) {
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        out.push({ key: item.key, description: `${section.label} › ${group.label} › ${item.label}` });
      }
    }
    for (const item of section.unpublished) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      out.push({ key: item.key, description: `${section.label} › Unpublished › ${item.label}` });
    }
  }
  return out;
}
