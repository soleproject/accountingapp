/**
 * Add invoices, bills, and payments to the demo workspace so the /invoices,
 * /bills, and /payments pages render with real-looking data. Layered on top
 * of the chart-of-accounts + contacts + transactions seeded by
 * seed-demo-fixtures.ts — run that first.
 *
 *   npx tsx scripts/seed-demo-billing.ts            # seed only if empty
 *   npx tsx scripts/seed-demo-billing.ts --force    # wipe demo billing first
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

// Helper to compute an ISO date a given number of days ago.
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

interface InvoiceSpec {
  number: string;
  customer: string;
  daysAgo: number;
  dueInDays: number;
  status: 'paid' | 'sent' | 'overdue';
  lines: { description: string; quantity: number; unitPrice: number; account?: 'Service Revenue' | 'Product Revenue' }[];
}
interface BillSpec {
  number: string;
  vendor: string;
  daysAgo: number;
  dueInDays: number;
  /**
   * Logical status used by this script — translates to the DB column:
   *   'posted'  → unpaid bill ('posted' is the app's status for in-the-books unpaid)
   *   'paid'    → fully paid (status='paid' + bill_payment + application)
   * The /bills page derives the visible "overdue / partial / paid" label
   * from due_date and payment applications, not from a literal status string.
   */
  status: 'paid' | 'posted';
  lines: { description: string; quantity: number; unitPrice: number; account: string }[];
}

const INVOICES: InvoiceSpec[] = [
  {
    number: 'INV-2026-101',
    customer: 'Acme Corporation',
    daysAgo: 4,
    dueInDays: 30,
    status: 'sent',
    lines: [
      { description: 'March advisory retainer',  quantity: 1, unitPrice: 8500, account: 'Service Revenue' },
      { description: 'Workshop facilitation',    quantity: 4, unitPrice: 600,  account: 'Service Revenue' },
    ],
  },
  {
    number: 'INV-2026-100',
    customer: 'Tech Innovations LLC',
    daysAgo: 12,
    dueInDays: 30,
    status: 'paid',
    lines: [
      { description: 'API integration sprint',   quantity: 1, unitPrice: 6200, account: 'Service Revenue' },
    ],
  },
  {
    number: 'INV-2026-099',
    customer: 'Sunrise Retail Co',
    daysAgo: 18,
    dueInDays: 30,
    status: 'overdue',
    lines: [
      { description: 'Hardware kits (12 units)', quantity: 12, unitPrice: 240, account: 'Product Revenue' },
      { description: 'Setup & training',         quantity: 1,  unitPrice: 900, account: 'Service Revenue' },
    ],
  },
  {
    number: 'INV-2026-098',
    customer: 'Brookfield Industries',
    daysAgo: 26,
    dueInDays: 45,
    status: 'paid',
    lines: [
      { description: 'Q1 integration project',   quantity: 1,  unitPrice: 14000, account: 'Service Revenue' },
    ],
  },
  {
    number: 'INV-2026-097',
    customer: 'Greenfield Consulting',
    daysAgo: 33,
    dueInDays: 30,
    status: 'sent',
    lines: [
      { description: 'Sprint 4 — strategy',      quantity: 1,  unitPrice: 5600, account: 'Service Revenue' },
    ],
  },
];

const BILLS: BillSpec[] = [
  {
    number: 'WW-2026-03',
    vendor: 'WeWork',
    daysAgo: 1,
    dueInDays: 15,
    status: 'posted',
    lines: [{ description: 'March office lease',        quantity: 1, unitPrice: 3500, account: 'Rent Expense' }],
  },
  {
    number: 'HIGH-Q1-2',
    vendor: 'Highland Marketing',
    daysAgo: 6,
    dueInDays: 30,
    status: 'posted',
    lines: [{ description: 'Q1 brand campaign — wave 2',quantity: 1, unitPrice: 4200, account: 'Marketing' }],
  },
  {
    number: 'DELTA-114',
    vendor: 'Delta Air Lines',
    daysAgo: 14,
    dueInDays: 14,
    status: 'paid',
    lines: [{ description: 'NYC client visit — round trip', quantity: 1, unitPrice: 612, account: 'Travel' }],
  },
  {
    number: 'OD-44219',
    vendor: 'Office Depot',
    daysAgo: 21,
    dueInDays: 30,
    status: 'paid',
    lines: [{ description: 'Ergonomic chairs (4)',     quantity: 4, unitPrice: 310, account: 'Office Supplies' }],
  },
  {
    // Past-due bill — kept as 'posted' since the /bills page computes the
    // visible "overdue" pill from due_date + outstanding, not the status column.
    number: 'HIGH-Q1-1',
    vendor: 'Highland Marketing',
    daysAgo: 32,
    dueInDays: 30,
    status: 'posted',
    lines: [{ description: 'Q1 brand campaign — wave 1', quantity: 1, unitPrice: 4500, account: 'Marketing' }],
  },
  {
    number: 'WW-2026-02',
    vendor: 'WeWork',
    daysAgo: 31,
    dueInDays: 15,
    status: 'paid',
    lines: [{ description: 'February office lease',    quantity: 1, unitPrice: 3500, account: 'Rent Expense' }],
  },
];

async function ensureNotSeeded(): Promise<boolean> {
  const existing = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM invoices WHERE organization_id = ${DEMO_ORG_ID}
  `;
  return (existing[0]?.n ?? 0) === 0;
}

async function wipe(): Promise<void> {
  console.log('Wiping existing demo billing…');
  await sql`DELETE FROM invoice_payment_applications WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = ${DEMO_ORG_ID})`;
  await sql`DELETE FROM bill_payment_applications    WHERE bill_id    IN (SELECT id FROM bills    WHERE organization_id = ${DEMO_ORG_ID})`;
  await sql`DELETE FROM invoice_payments WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM bill_payments    WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM payments         WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM invoice_lines    WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = ${DEMO_ORG_ID})`;
  await sql`DELETE FROM bill_lines       WHERE bill_id    IN (SELECT id FROM bills    WHERE organization_id = ${DEMO_ORG_ID})`;
  await sql`DELETE FROM invoices         WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM bills            WHERE organization_id = ${DEMO_ORG_ID}`;
}

async function main() {
  if (!(await ensureNotSeeded())) {
    if (!force) {
      console.log('Demo workspace already has invoices. Re-run with --force to wipe and re-seed billing.');
      await sql.end();
      return;
    }
    await wipe();
  }

  // Look up CoA accounts + contacts by name so we don't hardcode IDs.
  const coa = await sql<{ id: string; name: string }[]>`
    SELECT id, account_name AS name FROM chart_of_accounts WHERE organization_id = ${DEMO_ORG_ID}
  `;
  const coaByName = new Map(coa.map((r) => [r.name, r.id]));
  const contacts = await sql<{ id: string; name: string }[]>`
    SELECT id, contact_name AS name FROM contacts WHERE organization_id = ${DEMO_ORG_ID}
  `;
  const contactByName = new Map(contacts.map((r) => [r.name, r.id]));

  const arId   = coaByName.get('Accounts Receivable');
  const apId   = coaByName.get('Accounts Payable');
  const cashId = coaByName.get('Operating Cash');
  if (!arId || !apId || !cashId) {
    throw new Error('Demo chart of accounts is missing AR/AP/Cash — run seed-demo-fixtures.ts first.');
  }

  // ----- Invoices -----
  console.log(`Seeding ${INVOICES.length} invoices…`);
  for (const inv of INVOICES) {
    const contactId = contactByName.get(inv.customer);
    if (!contactId) {
      console.warn(`skip invoice ${inv.number} — missing customer ${inv.customer}`);
      continue;
    }
    const id = randomUUID();
    const invDate = daysAgo(inv.daysAgo);
    const dueDate = daysAgo(inv.daysAgo - inv.dueInDays);
    const total = inv.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);

    await sql`
      INSERT INTO invoices (
        id, organization_id, contact_id, invoice_number, invoice_date, due_date,
        status, posted, posted_at, ar_account_id, memo, created_at, updated_at
      ) VALUES (
        ${id}, ${DEMO_ORG_ID}, ${contactId}, ${inv.number}, ${invDate}, ${dueDate},
        ${inv.status}, true, NOW(), ${arId}, NULL, NOW(), NOW()
      )
    `;
    for (const line of inv.lines) {
      await sql`
        INSERT INTO invoice_lines (id, invoice_id, description, quantity, unit_price, amount)
        VALUES (${randomUUID()}, ${id}, ${line.description}, ${line.quantity}, ${line.unitPrice}, ${line.quantity * line.unitPrice})
      `;
    }

    if (inv.status === 'paid') {
      // Invoice payment + application + a generic payments row.
      const payId = randomUUID();
      const payDate = daysAgo(Math.max(0, inv.daysAgo - 7));
      await sql`
        INSERT INTO invoice_payments (id, organization_id, contact_id, payment_date, amount, memo, created_at, updated_at)
        VALUES (${payId}, ${DEMO_ORG_ID}, ${contactId}, ${payDate}, ${total}, ${'Payment for ' + inv.number}, NOW(), NOW())
      `;
      await sql`
        INSERT INTO invoice_payment_applications (id, invoice_payment_id, invoice_id, amount_applied)
        VALUES (${randomUUID()}, ${payId}, ${id}, ${total})
      `;
      await sql`
        INSERT INTO payments (
          id, organization_id, type, customer_id, invoice_id, payment_date,
          amount, ar_account_id, bank_account_id, created_at
        ) VALUES (
          ${randomUUID()}, ${DEMO_ORG_ID}, 'customer', ${contactId}, ${id}, ${payDate},
          ${total}, ${arId}, ${cashId}, NOW()::text
        )
      `;
    }
  }

  // ----- Bills -----
  console.log(`Seeding ${BILLS.length} bills…`);
  for (const b of BILLS) {
    const contactId = contactByName.get(b.vendor);
    if (!contactId) {
      console.warn(`skip bill ${b.number} — missing vendor ${b.vendor}`);
      continue;
    }
    const id = randomUUID();
    const billDate = daysAgo(b.daysAgo);
    const dueDate = daysAgo(b.daysAgo - b.dueInDays);
    const total = b.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);

    await sql`
      INSERT INTO bills (
        id, organization_id, contact_id, bill_number, bill_date, due_date,
        status, memo, created_at, updated_at
      ) VALUES (
        ${id}, ${DEMO_ORG_ID}, ${contactId}, ${b.number}, ${billDate}, ${dueDate},
        ${b.status}, NULL, NOW(), NOW()
      )
    `;
    for (const line of b.lines) {
      await sql`
        INSERT INTO bill_lines (id, bill_id, description, quantity, unit_price, amount)
        VALUES (${randomUUID()}, ${id}, ${line.description}, ${line.quantity}, ${line.unitPrice}, ${line.quantity * line.unitPrice})
      `;
    }

    if (b.status === 'paid') {
      const payId = randomUUID();
      const payDate = daysAgo(Math.max(0, b.daysAgo - 5));
      await sql`
        INSERT INTO bill_payments (id, organization_id, contact_id, payment_date, amount, memo, created_at, updated_at)
        VALUES (${payId}, ${DEMO_ORG_ID}, ${contactId}, ${payDate}, ${total}, ${'Payment for ' + b.number}, NOW(), NOW())
      `;
      await sql`
        INSERT INTO bill_payment_applications (id, bill_payment_id, bill_id, amount_applied)
        VALUES (${randomUUID()}, ${payId}, ${id}, ${total})
      `;
      await sql`
        INSERT INTO payments (
          id, organization_id, type, vendor_id, bill_id, payment_date,
          amount, ap_account_id, bank_account_id, created_at
        ) VALUES (
          ${randomUUID()}, ${DEMO_ORG_ID}, 'vendor', ${contactId}, ${id}, ${payDate},
          ${total}, ${apId}, ${cashId}, NOW()::text
        )
      `;
    }
  }

  await sql.end();
  console.log(`\nDone — demo workspace seeded with ${INVOICES.length} invoices and ${BILLS.length} bills (plus matching payments).`);
}

main().catch(async (e) => {
  console.error('seed-demo-billing failed:', e);
  try { await sql.end(); } catch { /* noop */ }
  process.exit(1);
});
