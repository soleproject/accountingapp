/**
 * Populate the demo workspace with a coherent set of fixtures so every page
 * (Dashboard, Transactions, Contacts, COA, Reports) renders with real numbers
 * instead of empty states.
 *
 *   npx tsx scripts/seed-demo-fixtures.ts            # seed only if empty
 *   npx tsx scripts/seed-demo-fixtures.ts --force    # wipe demo data first
 *
 * IMPORTANT: writes go directly to the DB. The Plaid / Veryfi ingest paths
 * are deliberately bypassed — this is sample data, not real ingest.
 */
import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const DEMO_ORG_ID = '00000000-0000-4000-8000-000000000000';
const force = process.argv.includes('--force');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

// ---------------- Chart of Accounts ----------------
// gaap_type is one of: asset, liability, equity, revenue, expense, cogs.
// detail_type is included so the (org, gaap_type, detail_type) unique
// constraint is satisfied for accounts that share a gaap_type.
const COA = [
  { num: '1000', name: 'Operating Cash',         gaap: 'asset',     detail: 'cash_bank',          normal: 'debit'  },
  { num: '1100', name: 'Accounts Receivable',    gaap: 'asset',     detail: 'accounts_receivable',normal: 'debit'  },
  { num: '1500', name: 'Equipment',              gaap: 'asset',     detail: 'equipment',          normal: 'debit'  },
  { num: '2000', name: 'Accounts Payable',       gaap: 'liability', detail: 'accounts_payable',   normal: 'credit' },
  { num: '2100', name: 'Sales Tax Payable',      gaap: 'liability', detail: 'sales_tax_payable',  normal: 'credit' },
  { num: '3000', name: "Owner's Equity",         gaap: 'equity',    detail: 'owners_equity',      normal: 'credit' },
  { num: '3900', name: 'Retained Earnings',      gaap: 'equity',    detail: 'retained_earnings',  normal: 'credit' },
  { num: '4000', name: 'Service Revenue',        gaap: 'revenue',   detail: 'service_revenue',    normal: 'credit' },
  { num: '4100', name: 'Product Revenue',        gaap: 'revenue',   detail: 'product_revenue',    normal: 'credit' },
  { num: '5000', name: 'Cost of Goods Sold',     gaap: 'cogs',      detail: 'cogs',               normal: 'debit'  },
  { num: '6000', name: 'Rent Expense',           gaap: 'expense',   detail: 'rent',               normal: 'debit'  },
  { num: '6100', name: 'Software Subscriptions', gaap: 'expense',   detail: 'software',           normal: 'debit'  },
  { num: '6200', name: 'Marketing',              gaap: 'expense',   detail: 'marketing',          normal: 'debit'  },
  { num: '6300', name: 'Travel',                 gaap: 'expense',   detail: 'travel',             normal: 'debit'  },
  { num: '6400', name: 'Office Supplies',        gaap: 'expense',   detail: 'office_supplies',    normal: 'debit'  },
  { num: '6500', name: 'Professional Fees',      gaap: 'expense',   detail: 'professional_fees',  normal: 'debit'  },
] as const;

const CUSTOMERS = [
  { name: 'Acme Corporation',       email: 'ap@acme-corp.com',          phone: '+1-415-555-0101' },
  { name: 'Tech Innovations LLC',   email: 'billing@techinno.io',       phone: '+1-415-555-0102' },
  { name: 'Brookfield Industries',  email: 'finance@brookfield.com',    phone: '+1-415-555-0103' },
  { name: 'Sunrise Retail Co',      email: 'ap@sunriseretail.com',      phone: '+1-415-555-0104' },
  { name: 'Greenfield Consulting',  email: 'accounting@greenfield.io',  phone: '+1-415-555-0105' },
];

const VENDORS = [
  { name: 'WeWork',                 email: 'billing@wework.com',        phone: '+1-855-555-0001', expense: 'Rent Expense' },
  { name: 'Slack Technologies',     email: 'billing@slack.com',         phone: '',                expense: 'Software Subscriptions' },
  { name: 'Google Workspace',       email: 'billing@google.com',        phone: '',                expense: 'Software Subscriptions' },
  { name: 'Stripe',                 email: 'support@stripe.com',        phone: '',                expense: 'Professional Fees' },
  { name: 'Highland Marketing',     email: 'billing@highlandmkt.com',   phone: '+1-415-555-0201', expense: 'Marketing' },
  { name: 'Delta Air Lines',        email: 'corporate@delta.com',       phone: '',                expense: 'Travel' },
  { name: 'Office Depot',           email: 'billing@officedepot.com',   phone: '',                expense: 'Office Supplies' },
];

// Invoices/Bills sit on different tables than the bank-feed transactions
// above. They have header rows + line rows; "paid" status is signalled by a
// row in `payments` (type 'received' for invoices, 'sent' for bills).
interface DemoInvoiceLine { description: string; quantity: number; unitPrice: number }
interface DemoInvoice {
  invoiceNumber: string;
  contact: string;            // must match a CUSTOMER name
  daysAgo: number;            // invoice_date
  dueInDays: number;          // due_date = today + dueInDays
  status: 'open' | 'paid' | 'draft';
  lines: DemoInvoiceLine[];
  paidDaysAgo?: number;       // present iff status === 'paid'
}
interface DemoBillLine { description: string; quantity: number; unitPrice: number }
interface DemoBill {
  billNumber: string | null;
  contact: string;            // must match a VENDOR name
  daysAgo: number;
  dueInDays: number;
  status: 'open' | 'posted' | 'paid';
  lines: DemoBillLine[];
  paidDaysAgo?: number;
}

const INVOICES: DemoInvoice[] = [
  // Paid in full — closed retainer cycle.
  {
    invoiceNumber: 'INV-1041',
    contact: 'Acme Corporation',
    daysAgo: 67,
    dueInDays: -37,
    status: 'paid',
    paidDaysAgo: 40,
    lines: [{ description: 'January retainer — strategy + roadmap', quantity: 1, unitPrice: 12500 }],
  },
  // Outstanding, on-track (due in ~3 weeks).
  {
    invoiceNumber: 'INV-1042',
    contact: 'Brookfield Industries',
    daysAgo: 7,
    dueInDays: 23,
    status: 'open',
    lines: [
      { description: 'Q2 integration project — milestone 1', quantity: 1, unitPrice: 7500 },
      { description: 'Project management hours', quantity: 12, unitPrice: 175 },
    ],
  },
  // Outstanding, due in ~5 days (lands in the due30 tile).
  {
    invoiceNumber: 'INV-1043',
    contact: 'Tech Innovations LLC',
    daysAgo: 25,
    dueInDays: 5,
    status: 'open',
    lines: [{ description: 'Platform fee — April', quantity: 1, unitPrice: 4200 }],
  },
  // Overdue — past due date, still unpaid.
  {
    invoiceNumber: 'INV-1044',
    contact: 'Sunrise Retail Co',
    daysAgo: 45,
    dueInDays: -15,
    status: 'open',
    lines: [
      { description: 'Spring product order — fixtures', quantity: 4, unitPrice: 425 },
      { description: 'Spring product order — display kits', quantity: 2, unitPrice: 1150 },
    ],
  },
  // Draft (not yet sent).
  {
    invoiceNumber: 'INV-1045',
    contact: 'Greenfield Consulting',
    daysAgo: 1,
    dueInDays: 29,
    status: 'draft',
    lines: [{ description: 'Sprint 5 — discovery + design', quantity: 1, unitPrice: 5600 }],
  },
];

const BILLS: DemoBill[] = [
  // Paid bill (rent for last month, already settled).
  {
    billNumber: 'WW-2026-04',
    contact: 'WeWork',
    daysAgo: 35,
    dueInDays: -5,
    status: 'paid',
    paidDaysAgo: 8,
    lines: [{ description: 'April office membership', quantity: 1, unitPrice: 3500 }],
  },
  // Posted, due in ~12 days.
  {
    billNumber: 'HM-Q2-01',
    contact: 'Highland Marketing',
    daysAgo: 6,
    dueInDays: 24,
    status: 'posted',
    lines: [{ description: 'Q2 paid social retainer', quantity: 1, unitPrice: 4500 }],
  },
  // Posted, due in ~3 days (lands in due30 tile).
  {
    billNumber: 'DEP-INV-9912',
    contact: 'Office Depot',
    daysAgo: 27,
    dueInDays: 3,
    status: 'posted',
    lines: [
      { description: 'Ergonomic chairs', quantity: 4, unitPrice: 310 },
      { description: 'Standing desk converters', quantity: 2, unitPrice: 245 },
    ],
  },
  // Overdue posted bill — was due last week.
  {
    billNumber: 'DELTA-26-114',
    contact: 'Delta Air Lines',
    daysAgo: 22,
    dueInDays: -7,
    status: 'posted',
    lines: [{ description: 'Team offsite flights', quantity: 1, unitPrice: 1820 }],
  },
];

// Each entry creates a transaction + matching journal entry / lines / GL rows.
// type = 'credit' on the bank account → money in (revenue); 'debit' → money out (expense).
interface DemoTxn {
  daysAgo: number;
  description: string;
  amount: number;
  type: 'income' | 'expense';
  contact: string;
  category: string;
}

function buildTransactions(): DemoTxn[] {
  const txns: DemoTxn[] = [];

  // Recurring monthly expenses across 3 months.
  for (const monthsAgo of [0, 1, 2]) {
    const baseDay = monthsAgo * 30;
    txns.push({ daysAgo: baseDay + 1,  description: 'WeWork monthly rent',          amount: 3500, type: 'expense', contact: 'WeWork',             category: 'Rent Expense' });
    txns.push({ daysAgo: baseDay + 3,  description: 'Slack team plan',              amount: 168,  type: 'expense', contact: 'Slack Technologies', category: 'Software Subscriptions' });
    txns.push({ daysAgo: baseDay + 3,  description: 'Google Workspace Business',    amount: 120,  type: 'expense', contact: 'Google Workspace',   category: 'Software Subscriptions' });
    txns.push({ daysAgo: baseDay + 15, description: 'Stripe processing fees',       amount: 89,   type: 'expense', contact: 'Stripe',             category: 'Professional Fees' });
  }

  // Customer payments — recurring + one-offs.
  txns.push({ daysAgo: 5,  description: 'Acme Corp – March retainer',         amount: 12500, type: 'income',  contact: 'Acme Corporation',      category: 'Service Revenue' });
  txns.push({ daysAgo: 9,  description: 'Tech Innovations – platform fee',    amount: 4200,  type: 'income',  contact: 'Tech Innovations LLC',  category: 'Service Revenue' });
  txns.push({ daysAgo: 14, description: 'Sunrise Retail – product order',     amount: 2850,  type: 'income',  contact: 'Sunrise Retail Co',     category: 'Product Revenue' });
  txns.push({ daysAgo: 22, description: 'Brookfield – consulting (Q1)',       amount: 8750,  type: 'income',  contact: 'Brookfield Industries', category: 'Service Revenue' });
  txns.push({ daysAgo: 28, description: 'Greenfield Consulting – sprint 4',   amount: 5600,  type: 'income',  contact: 'Greenfield Consulting', category: 'Service Revenue' });
  txns.push({ daysAgo: 35, description: 'Acme Corp – Feb retainer',           amount: 12500, type: 'income',  contact: 'Acme Corporation',      category: 'Service Revenue' });
  txns.push({ daysAgo: 38, description: 'Tech Innovations – platform fee',    amount: 4200,  type: 'income',  contact: 'Tech Innovations LLC',  category: 'Service Revenue' });
  txns.push({ daysAgo: 44, description: 'Sunrise Retail – product order',     amount: 1925,  type: 'income',  contact: 'Sunrise Retail Co',     category: 'Product Revenue' });
  txns.push({ daysAgo: 52, description: 'Brookfield – integration project',   amount: 14000, type: 'income',  contact: 'Brookfield Industries', category: 'Service Revenue' });
  txns.push({ daysAgo: 58, description: 'Greenfield Consulting – sprint 3',   amount: 5600,  type: 'income',  contact: 'Greenfield Consulting', category: 'Service Revenue' });
  txns.push({ daysAgo: 67, description: 'Acme Corp – Jan retainer',           amount: 12500, type: 'income',  contact: 'Acme Corporation',      category: 'Service Revenue' });
  txns.push({ daysAgo: 72, description: 'Sunrise Retail – product order',     amount: 3175,  type: 'income',  contact: 'Sunrise Retail Co',     category: 'Product Revenue' });
  txns.push({ daysAgo: 80, description: 'Tech Innovations – platform fee',    amount: 4200,  type: 'income',  contact: 'Tech Innovations LLC',  category: 'Service Revenue' });

  // Marketing / travel / supplies one-offs.
  txns.push({ daysAgo: 11, description: 'Highland Q1 brand campaign',         amount: 4500,  type: 'expense', contact: 'Highland Marketing',  category: 'Marketing' });
  txns.push({ daysAgo: 27, description: 'Delta Air Lines – SFO→NYC',          amount: 612,   type: 'expense', contact: 'Delta Air Lines',     category: 'Travel' });
  txns.push({ daysAgo: 31, description: 'Office Depot – ergonomic chairs',    amount: 1240,  type: 'expense', contact: 'Office Depot',        category: 'Office Supplies' });
  txns.push({ daysAgo: 49, description: 'Highland — Feb retainer',            amount: 3000,  type: 'expense', contact: 'Highland Marketing',  category: 'Marketing' });
  txns.push({ daysAgo: 55, description: 'Delta Air Lines – team offsite',     amount: 1820,  type: 'expense', contact: 'Delta Air Lines',     category: 'Travel' });
  txns.push({ daysAgo: 76, description: 'Office Depot – printer + ink',       amount: 485,   type: 'expense', contact: 'Office Depot',        category: 'Office Supplies' });

  return txns;
}

async function ensureNotSeeded(): Promise<boolean> {
  const existing = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM chart_of_accounts WHERE organization_id = ${DEMO_ORG_ID}
  `;
  return (existing[0]?.n ?? 0) === 0;
}

async function wipeDemo(): Promise<void> {
  console.log('Wiping existing demo data…');
  // invoice_lines / bill_lines / *_payment_applications aren't org-scoped —
  // delete by joining on their parent's org.
  await sql`DELETE FROM invoice_payment_applications WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = ${DEMO_ORG_ID})`;
  await sql`DELETE FROM bill_payment_applications WHERE bill_id IN (SELECT id FROM bills WHERE organization_id = ${DEMO_ORG_ID})`;
  await sql`DELETE FROM invoice_payments WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM bill_payments WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM payments WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = ${DEMO_ORG_ID})`;
  await sql`DELETE FROM bill_lines WHERE bill_id IN (SELECT id FROM bills WHERE organization_id = ${DEMO_ORG_ID})`;
  await sql`DELETE FROM invoices WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM bills WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM general_ledger WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id = ${DEMO_ORG_ID})`;
  await sql`DELETE FROM journal_entries WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM transactions WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM contacts WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM chart_of_accounts WHERE organization_id = ${DEMO_ORG_ID}`;
}

async function main() {
  const empty = await ensureNotSeeded();
  if (!empty) {
    if (!force) {
      console.log('Demo workspace already has fixtures. Re-run with --force to wipe and re-seed.');
      await sql.end();
      return;
    }
    await wipeDemo();
  }

  // 1. Chart of Accounts
  const coaIds = new Map<string, string>(); // name → id
  console.log(`Seeding ${COA.length} accounts…`);
  for (const a of COA) {
    const id = randomUUID();
    coaIds.set(a.name, id);
    await sql`
      INSERT INTO chart_of_accounts (
        id, organization_id, account_number, account_name, gaap_type, detail_type,
        normal_balance, is_active, system_generated, passed_name_contact_check
      ) VALUES (
        ${id}, ${DEMO_ORG_ID}, ${a.num}, ${a.name}, ${a.gaap}, ${a.detail},
        ${a.normal}, true, false, true
      )
    `;
  }
  const cashId = coaIds.get('Operating Cash')!;

  // 2. Contacts (customers + vendors)
  const contactIds = new Map<string, string>(); // name → id
  console.log(`Seeding ${CUSTOMERS.length + VENDORS.length} contacts…`);
  for (const c of CUSTOMERS) {
    const id = randomUUID();
    contactIds.set(c.name, id);
    await sql`
      INSERT INTO contacts (
        id, organization_id, contact_name, company_name, email, phone,
        type_tags, is_active, created_at, updated_at
      ) VALUES (
        ${id}, ${DEMO_ORG_ID}, ${c.name}, ${c.name}, ${c.email}, ${c.phone},
        ${sql.json(['customer'])}, true, NOW(), NOW()
      )
    `;
  }
  for (const v of VENDORS) {
    const id = randomUUID();
    contactIds.set(v.name, id);
    await sql`
      INSERT INTO contacts (
        id, organization_id, contact_name, company_name, email, phone,
        type_tags, is_active, created_at, updated_at
      ) VALUES (
        ${id}, ${DEMO_ORG_ID}, ${v.name}, ${v.name}, ${v.email}, ${v.phone},
        ${sql.json(['vendor'])}, true, NOW(), NOW()
      )
    `;
  }

  // 3. Transactions with journal entries / lines / GL.
  const txns = buildTransactions();
  console.log(`Seeding ${txns.length} transactions + journal entries…`);

  let runningCashBalance = 0;
  // Sort oldest → newest so the GL balance column makes sense.
  const ordered = [...txns].sort((a, b) => b.daysAgo - a.daysAgo);

  for (const t of ordered) {
    const txDate = new Date(Date.now() - t.daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const categoryId = coaIds.get(t.category);
    const contactId = contactIds.get(t.contact);
    if (!categoryId || !contactId) {
      console.warn(`skip ${t.description} — missing CoA "${t.category}" or contact "${t.contact}"`);
      continue;
    }

    const txnId = randomUUID();
    const jeId = randomUUID();
    const debitLineId = randomUUID();
    const creditLineId = randomUUID();

    // Sign convention: transactions.amount is +money-in, -money-out on the bank account.
    const signedAmount = t.type === 'income' ? t.amount : -t.amount;
    runningCashBalance += signedAmount;

    // Bank-account leg: income increases cash (debit); expense decreases cash (credit).
    const cashDebit  = t.type === 'income'  ? t.amount : 0;
    const cashCredit = t.type === 'expense' ? t.amount : 0;
    // Counterpart leg on the revenue / expense account.
    const catDebit   = t.type === 'expense' ? t.amount : 0;
    const catCredit  = t.type === 'income'  ? t.amount : 0;

    // Journal entry
    await sql`
      INSERT INTO journal_entries (id, organization_id, date, memo, posted, posted_at, created_at, source_type, source_id)
      VALUES (${jeId}, ${DEMO_ORG_ID}, ${txDate}, ${t.description}, true, NOW(), NOW(), 'transaction', ${txnId})
    `;

    // Bank-account JE line
    await sql`
      INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, memo, contact_id, created_at)
      VALUES (${debitLineId}, ${jeId}, ${cashId}, ${cashDebit}, ${cashCredit}, ${t.description}, ${contactId}, NOW())
    `;
    // Category JE line
    await sql`
      INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, memo, contact_id, created_at)
      VALUES (${creditLineId}, ${jeId}, ${categoryId}, ${catDebit}, ${catCredit}, ${t.description}, ${contactId}, NOW())
    `;

    // GL rows — one per JE line
    await sql`
      INSERT INTO general_ledger (id, organization_id, account_id, journal_entry_id, journal_entry_line_id, contact_id, date, memo, debit, credit, balance, created_at)
      VALUES (${randomUUID()}, ${DEMO_ORG_ID}, ${cashId}, ${jeId}, ${debitLineId}, ${contactId}, ${txDate}, ${t.description}, ${cashDebit}, ${cashCredit}, ${runningCashBalance}, NOW())
    `;
    await sql`
      INSERT INTO general_ledger (id, organization_id, account_id, journal_entry_id, journal_entry_line_id, contact_id, date, memo, debit, credit, balance, created_at)
      VALUES (${randomUUID()}, ${DEMO_ORG_ID}, ${categoryId}, ${jeId}, ${creditLineId}, ${contactId}, ${txDate}, ${t.description}, ${catDebit}, ${catCredit}, ${catDebit - catCredit}, NOW())
    `;

    // Transactions row (the one shown in the Transactions list)
    await sql`
      INSERT INTO transactions (
        id, organization_id, date, description, amount, created_at,
        account_id, contact_id, type, bank_description, user_description,
        category_account_id, category_type, journal_entry_id, reviewed
      ) VALUES (
        ${txnId}, ${DEMO_ORG_ID}, ${txDate}, ${t.description}, ${signedAmount}, NOW(),
        ${cashId}, ${contactId}, ${t.type === 'income' ? 'deposit' : 'withdrawal'}, ${t.description}, ${t.description},
        ${categoryId}, ${t.type === 'income' ? 'revenue' : 'expense'}, ${jeId}, true
      )
    `;
  }

  // 4. Invoices + lines + (received) payments
  const arId = coaIds.get('Accounts Receivable')!;
  const apId = coaIds.get('Accounts Payable')!;

  function isoDaysFromNow(offsetDays: number): string {
    return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  console.log(`Seeding ${INVOICES.length} invoices…`);
  for (const inv of INVOICES) {
    const contactId = contactIds.get(inv.contact);
    if (!contactId) { console.warn(`skip invoice ${inv.invoiceNumber} — unknown contact "${inv.contact}"`); continue; }
    const invoiceId = randomUUID();
    const invoiceDate = isoDaysFromNow(-inv.daysAgo);
    const dueDate = isoDaysFromNow(inv.dueInDays);
    const posted = inv.status !== 'draft';
    const postedAt = posted ? new Date(Date.now() - inv.daysAgo * 24 * 60 * 60 * 1000).toISOString() : null;

    await sql`
      INSERT INTO invoices (
        id, organization_id, contact_id, invoice_number, invoice_date, due_date,
        status, posted, posted_at, ar_account_id, tax_amount, discount_amount,
        created_at, updated_at
      ) VALUES (
        ${invoiceId}, ${DEMO_ORG_ID}, ${contactId}, ${inv.invoiceNumber}, ${invoiceDate}, ${dueDate},
        ${inv.status}, ${posted}, ${postedAt}, ${arId}, 0, 0,
        NOW(), NOW()
      )
    `;
    for (const line of inv.lines) {
      await sql`
        INSERT INTO invoice_lines (id, invoice_id, description, quantity, unit_price, amount)
        VALUES (${randomUUID()}, ${invoiceId}, ${line.description}, ${line.quantity}, ${line.unitPrice}, ${line.quantity * line.unitPrice})
      `;
    }
    if (inv.status === 'paid' && inv.paidDaysAgo != null) {
      const total = inv.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
      const paymentId = randomUUID();
      const paymentDate = isoDaysFromNow(-inv.paidDaysAgo);
      await sql`
        INSERT INTO payments (
          id, organization_id, type, customer_id, invoice_id, payment_date, amount,
          ar_account_id, bank_account_id, created_at
        ) VALUES (
          ${paymentId}, ${DEMO_ORG_ID}, 'received', ${contactId}, ${invoiceId}, ${paymentDate}, ${total},
          ${arId}, ${cashId}, ${new Date().toISOString()}
        )
      `;
    }
  }

  console.log(`Seeding ${BILLS.length} bills…`);
  for (const bill of BILLS) {
    const contactId = contactIds.get(bill.contact);
    if (!contactId) { console.warn(`skip bill ${bill.billNumber} — unknown contact "${bill.contact}"`); continue; }
    const billId = randomUUID();
    const billDate = isoDaysFromNow(-bill.daysAgo);
    const dueDate = isoDaysFromNow(bill.dueInDays);

    await sql`
      INSERT INTO bills (
        id, organization_id, contact_id, bill_number, bill_date, due_date,
        status, tax_amount, discount_amount, created_at, updated_at
      ) VALUES (
        ${billId}, ${DEMO_ORG_ID}, ${contactId}, ${bill.billNumber}, ${billDate}, ${dueDate},
        ${bill.status}, 0, 0, NOW(), NOW()
      )
    `;
    for (const line of bill.lines) {
      await sql`
        INSERT INTO bill_lines (id, bill_id, description, quantity, unit_price, amount)
        VALUES (${randomUUID()}, ${billId}, ${line.description}, ${line.quantity}, ${line.unitPrice}, ${line.quantity * line.unitPrice})
      `;
    }
    if (bill.status === 'paid' && bill.paidDaysAgo != null) {
      const total = bill.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
      const paymentId = randomUUID();
      const paymentDate = isoDaysFromNow(-bill.paidDaysAgo);
      await sql`
        INSERT INTO payments (
          id, organization_id, type, vendor_id, bill_id, payment_date, amount,
          ap_account_id, bank_account_id, created_at
        ) VALUES (
          ${paymentId}, ${DEMO_ORG_ID}, 'sent', ${contactId}, ${billId}, ${paymentDate}, ${total},
          ${apId}, ${cashId}, ${new Date().toISOString()}
        )
      `;
    }
  }

  await sql.end();
  console.log(
    `\nDone — demo workspace seeded with ${COA.length} accounts, ${CUSTOMERS.length + VENDORS.length} contacts, ` +
      `${txns.length} transactions, ${INVOICES.length} invoices, ${BILLS.length} bills.`,
  );
}

main().catch(async (e) => {
  console.error('seed-demo-fixtures failed:', e);
  try { await sql.end(); } catch { /* noop */ }
  process.exit(1);
});
