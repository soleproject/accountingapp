/**
 * Full wipe of test data from an org. Keeps the seed chart of accounts
 * (anything whose account_number doesn't start with 'qbo:'); deletes
 * everything else book-related so the org is back to ready-to-use.
 *
 * Run:
 *   npx tsx scripts/wipe-org-books.ts <orgName>
 *   npx tsx scripts/wipe-org-books.ts <orgName> --apply
 *
 * Default is dry-run (just counts). Pass --apply to actually delete.
 */
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
config({ path: '.env.local' });

async function main() {
  const apply = process.argv.includes('--apply');
  const orgName = process.argv.find((a) => !a.startsWith('-') && !a.endsWith('.ts') && !a.endsWith('node.exe') && a !== process.argv[0] && a !== process.argv[1]);
  if (!orgName) {
    console.log('Usage: npx tsx scripts/wipe-org-books.ts <orgName> [--apply]');
    process.exit(1);
  }

  const { db } = await import('../db/client');
  const {
    organizations,
    receiptMatchApplications,
    receiptMatchSuggestions,
    receiptLines,
    receipts,
    transactionSplits,
    transactions,
    payments,
    billPaymentApplications,
    billLines,
    billPayments,
    bills,
    invoicePaymentApplications,
    invoiceLines,
    invoices,
    generalLedger,
    journalEntryLines,
    journalEntries,
    qboAccountStaging,
    qboBillPaymentStaging,
    qboBillStaging,
    qboCustomerStaging,
    qboDepositStaging,
    qboInvoiceStaging,
    qboJournalEntryStaging,
    qboPaymentStaging,
    qboPurchaseStaging,
    qboTransferStaging,
    qboVendorStaging,
    qboMigrationJobs,
    qboConnections,
    qboConflicts,
    contacts,
    chartOfAccounts,
  } = await import('../db/schema/schema');

  const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, orgName)).limit(1);
  if (!org) { console.log(`Org "${orgName}" not found`); process.exit(0); }
  console.log(`Org: ${orgName} (${org.id})\n`);

  // Order matters where there are FKs / soft-FKs. Cascading through
  // children → parents.
  const passes: Array<{ label: string; run: (dryRun: boolean) => Promise<number> }> = [
    {
      label: 'receipt_match_applications',
      run: async (dry) => {
        const rows = await db.select({ id: receiptMatchApplications.id }).from(receiptMatchApplications).where(eq(receiptMatchApplications.organizationId, org.id));
        if (!dry && rows.length > 0) await db.delete(receiptMatchApplications).where(eq(receiptMatchApplications.organizationId, org.id));
        return rows.length;
      },
    },
    {
      label: 'receipt_match_suggestions',
      run: async (dry) => {
        const rows = await db.select({ id: receiptMatchSuggestions.id }).from(receiptMatchSuggestions).where(eq(receiptMatchSuggestions.organizationId, org.id));
        if (!dry && rows.length > 0) await db.delete(receiptMatchSuggestions).where(eq(receiptMatchSuggestions.organizationId, org.id));
        return rows.length;
      },
    },
    {
      label: 'receipt_lines',
      run: async (dry) => {
        const n = (await db.execute(sql`SELECT COUNT(*) AS n FROM receipt_lines WHERE receipt_id IN (SELECT id FROM receipts WHERE organization_id = ${org.id})`)).rows?.[0]?.n ?? 0;
        if (!dry) await db.execute(sql`DELETE FROM receipt_lines WHERE receipt_id IN (SELECT id FROM receipts WHERE organization_id = ${org.id})`);
        return Number(n);
      },
    },
    {
      label: 'receipts',
      run: async (dry) => {
        const rows = await db.select({ id: receipts.id }).from(receipts).where(eq(receipts.organizationId, org.id));
        if (!dry && rows.length > 0) await db.delete(receipts).where(eq(receipts.organizationId, org.id));
        return rows.length;
      },
    },
    {
      label: 'transaction_splits',
      run: async (dry) => {
        const rows = await db.select({ id: transactionSplits.id }).from(transactionSplits).where(eq(transactionSplits.organizationId, org.id));
        if (!dry && rows.length > 0) await db.delete(transactionSplits).where(eq(transactionSplits.organizationId, org.id));
        return rows.length;
      },
    },
    {
      label: 'payments',
      run: async (dry) => {
        const rows = await db.select({ id: payments.id }).from(payments).where(eq(payments.organizationId, org.id));
        if (!dry && rows.length > 0) await db.delete(payments).where(eq(payments.organizationId, org.id));
        return rows.length;
      },
    },
    {
      label: 'bill_payment_applications',
      run: async (dry) => {
        const n = (await db.execute(sql`SELECT COUNT(*) AS n FROM bill_payment_applications WHERE bill_id IN (SELECT id FROM bills WHERE organization_id = ${org.id})`)).rows?.[0]?.n ?? 0;
        if (!dry) await db.execute(sql`DELETE FROM bill_payment_applications WHERE bill_id IN (SELECT id FROM bills WHERE organization_id = ${org.id})`);
        return Number(n);
      },
    },
    {
      label: 'bill_lines',
      run: async (dry) => {
        const n = (await db.execute(sql`SELECT COUNT(*) AS n FROM bill_lines WHERE bill_id IN (SELECT id FROM bills WHERE organization_id = ${org.id})`)).rows?.[0]?.n ?? 0;
        if (!dry) await db.execute(sql`DELETE FROM bill_lines WHERE bill_id IN (SELECT id FROM bills WHERE organization_id = ${org.id})`);
        return Number(n);
      },
    },
    {
      label: 'bill_payments',
      run: async (dry) => {
        const rows = await db.select({ id: billPayments.id }).from(billPayments).where(eq(billPayments.organizationId, org.id));
        if (!dry && rows.length > 0) await db.delete(billPayments).where(eq(billPayments.organizationId, org.id));
        return rows.length;
      },
    },
    {
      label: 'bills',
      run: async (dry) => {
        const rows = await db.select({ id: bills.id }).from(bills).where(eq(bills.organizationId, org.id));
        if (!dry && rows.length > 0) await db.delete(bills).where(eq(bills.organizationId, org.id));
        return rows.length;
      },
    },
    {
      label: 'invoice_payment_applications',
      run: async (dry) => {
        const n = (await db.execute(sql`SELECT COUNT(*) AS n FROM invoice_payment_applications WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = ${org.id})`)).rows?.[0]?.n ?? 0;
        if (!dry) await db.execute(sql`DELETE FROM invoice_payment_applications WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = ${org.id})`);
        return Number(n);
      },
    },
    {
      label: 'invoice_lines',
      run: async (dry) => {
        const n = (await db.execute(sql`SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = ${org.id})`)).rows?.[0]?.n ?? 0;
        if (!dry) await db.execute(sql`DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = ${org.id})`);
        return Number(n);
      },
    },
    {
      label: 'invoices',
      run: async (dry) => {
        const rows = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.organizationId, org.id));
        if (!dry && rows.length > 0) await db.delete(invoices).where(eq(invoices.organizationId, org.id));
        return rows.length;
      },
    },
    {
      label: 'transactions',
      run: async (dry) => {
        const rows = await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.organizationId, org.id));
        if (!dry && rows.length > 0) await db.delete(transactions).where(eq(transactions.organizationId, org.id));
        return rows.length;
      },
    },
    {
      label: 'general_ledger',
      run: async (dry) => {
        const n = (await db.execute(sql`SELECT COUNT(*) AS n FROM general_ledger WHERE organization_id = ${org.id}`)).rows?.[0]?.n ?? 0;
        if (!dry) await db.execute(sql`DELETE FROM general_ledger WHERE organization_id = ${org.id}`);
        return Number(n);
      },
    },
    {
      label: 'journal_entry_lines',
      run: async (dry) => {
        const n = (await db.execute(sql`SELECT COUNT(*) AS n FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id = ${org.id})`)).rows?.[0]?.n ?? 0;
        if (!dry) await db.execute(sql`DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id = ${org.id})`);
        return Number(n);
      },
    },
    {
      label: 'journal_entries',
      run: async (dry) => {
        const rows = await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.organizationId, org.id));
        if (!dry && rows.length > 0) await db.delete(journalEntries).where(eq(journalEntries.organizationId, org.id));
        return rows.length;
      },
    },
    {
      label: 'qbo_account_staging',
      run: async (dry) => {
        const rows = await db.select({ id: qboAccountStaging.id }).from(qboAccountStaging).where(eq(qboAccountStaging.orgId, org.id));
        if (!dry && rows.length > 0) await db.delete(qboAccountStaging).where(eq(qboAccountStaging.orgId, org.id));
        return rows.length;
      },
    },
    {
      label: 'qbo_customer_staging',
      run: async (dry) => {
        const rows = await db.select({ id: qboCustomerStaging.id }).from(qboCustomerStaging).where(eq(qboCustomerStaging.orgId, org.id));
        if (!dry && rows.length > 0) await db.delete(qboCustomerStaging).where(eq(qboCustomerStaging.orgId, org.id));
        return rows.length;
      },
    },
    {
      label: 'qbo_vendor_staging',
      run: async (dry) => {
        const rows = await db.select({ id: qboVendorStaging.id }).from(qboVendorStaging).where(eq(qboVendorStaging.orgId, org.id));
        if (!dry && rows.length > 0) await db.delete(qboVendorStaging).where(eq(qboVendorStaging.orgId, org.id));
        return rows.length;
      },
    },
    {
      label: 'qbo_invoice_staging',
      run: async (dry) => {
        const rows = await db.select({ id: qboInvoiceStaging.id }).from(qboInvoiceStaging).where(eq(qboInvoiceStaging.orgId, org.id));
        if (!dry && rows.length > 0) await db.delete(qboInvoiceStaging).where(eq(qboInvoiceStaging.orgId, org.id));
        return rows.length;
      },
    },
    {
      label: 'qbo_bill_staging',
      run: async (dry) => {
        const rows = await db.select({ id: qboBillStaging.id }).from(qboBillStaging).where(eq(qboBillStaging.orgId, org.id));
        if (!dry && rows.length > 0) await db.delete(qboBillStaging).where(eq(qboBillStaging.orgId, org.id));
        return rows.length;
      },
    },
    {
      label: 'qbo_payment_staging',
      run: async (dry) => {
        const rows = await db.select({ id: qboPaymentStaging.id }).from(qboPaymentStaging).where(eq(qboPaymentStaging.orgId, org.id));
        if (!dry && rows.length > 0) await db.delete(qboPaymentStaging).where(eq(qboPaymentStaging.orgId, org.id));
        return rows.length;
      },
    },
    {
      label: 'qbo_bill_payment_staging',
      run: async (dry) => {
        const rows = await db.select({ id: qboBillPaymentStaging.id }).from(qboBillPaymentStaging).where(eq(qboBillPaymentStaging.orgId, org.id));
        if (!dry && rows.length > 0) await db.delete(qboBillPaymentStaging).where(eq(qboBillPaymentStaging.orgId, org.id));
        return rows.length;
      },
    },
    {
      label: 'qbo_purchase_staging',
      run: async (dry) => {
        const rows = await db.select({ id: qboPurchaseStaging.id }).from(qboPurchaseStaging).where(eq(qboPurchaseStaging.orgId, org.id));
        if (!dry && rows.length > 0) await db.delete(qboPurchaseStaging).where(eq(qboPurchaseStaging.orgId, org.id));
        return rows.length;
      },
    },
    {
      label: 'qbo_deposit_staging',
      run: async (dry) => {
        const rows = await db.select({ id: qboDepositStaging.id }).from(qboDepositStaging).where(eq(qboDepositStaging.orgId, org.id));
        if (!dry && rows.length > 0) await db.delete(qboDepositStaging).where(eq(qboDepositStaging.orgId, org.id));
        return rows.length;
      },
    },
    {
      label: 'qbo_transfer_staging',
      run: async (dry) => {
        const rows = await db.select({ id: qboTransferStaging.id }).from(qboTransferStaging).where(eq(qboTransferStaging.orgId, org.id));
        if (!dry && rows.length > 0) await db.delete(qboTransferStaging).where(eq(qboTransferStaging.orgId, org.id));
        return rows.length;
      },
    },
    {
      label: 'qbo_journal_entry_staging',
      run: async (dry) => {
        const rows = await db.select({ id: qboJournalEntryStaging.id }).from(qboJournalEntryStaging).where(eq(qboJournalEntryStaging.orgId, org.id));
        if (!dry && rows.length > 0) await db.delete(qboJournalEntryStaging).where(eq(qboJournalEntryStaging.orgId, org.id));
        return rows.length;
      },
    },
    {
      label: 'qbo_conflicts',
      run: async (dry) => {
        const rows = await db.select({ id: qboConflicts.id }).from(qboConflicts).where(eq(qboConflicts.orgId, org.id));
        if (!dry && rows.length > 0) await db.delete(qboConflicts).where(eq(qboConflicts.orgId, org.id));
        return rows.length;
      },
    },
    {
      label: 'qbo_migration_jobs',
      run: async (dry) => {
        const rows = await db.select({ id: qboMigrationJobs.id }).from(qboMigrationJobs).where(eq(qboMigrationJobs.orgId, org.id));
        if (!dry && rows.length > 0) await db.delete(qboMigrationJobs).where(eq(qboMigrationJobs.orgId, org.id));
        return rows.length;
      },
    },
    {
      label: 'qbo_connections',
      run: async (dry) => {
        const rows = await db.select({ realmId: qboConnections.realmId }).from(qboConnections).where(eq(qboConnections.orgId, org.id));
        if (!dry && rows.length > 0) await db.delete(qboConnections).where(eq(qboConnections.orgId, org.id));
        return rows.length;
      },
    },
    {
      label: 'contacts (all)',
      run: async (dry) => {
        const rows = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.organizationId, org.id));
        if (!dry && rows.length > 0) await db.delete(contacts).where(eq(contacts.organizationId, org.id));
        return rows.length;
      },
    },
    {
      label: 'chart_of_accounts (qbo:%)',
      run: async (dry) => {
        const n = (await db.execute(sql`SELECT COUNT(*) AS n FROM chart_of_accounts WHERE organization_id = ${org.id} AND account_number LIKE 'qbo:%'`)).rows?.[0]?.n ?? 0;
        if (!dry) await db.execute(sql`DELETE FROM chart_of_accounts WHERE organization_id = ${org.id} AND account_number LIKE 'qbo:%'`);
        return Number(n);
      },
    },
  ];

  console.log(`${apply ? 'APPLYING' : 'DRY-RUN'}:\n`);
  let total = 0;
  for (const p of passes) {
    try {
      const n = await p.run(!apply);
      total += n;
      if (n > 0) console.log(`  ${p.label.padEnd(40)} ${n} row(s) ${apply ? 'deleted' : 'would delete'}`);
    } catch (err) {
      console.log(`  ${p.label.padEnd(40)} ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\nTotal: ${total} row(s) ${apply ? 'deleted' : 'would delete'}`);
  if (!apply) console.log('\nPass --apply to commit.');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
