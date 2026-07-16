/**
 * Dump Veryfi's date fields for the Acme Corp Walmart receipt.
 * Run: npx tsx scripts/diagnose-veryfi-date.ts
 */
import { config } from 'dotenv';
import { desc, eq } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const { receipts, contacts, organizations } = await import('../db/schema/schema');

  const rows = await db
    .select({
      id: receipts.id,
      orgName: organizations.name,
      storedDate: receipts.receiptDate,
      total: receipts.totalAmount,
      contactName: contacts.contactName,
      raw: receipts.veryfiRawJson,
    })
    .from(receipts)
    .leftJoin(organizations, eq(receipts.organizationId, organizations.id))
    .leftJoin(contacts, eq(receipts.contactId, contacts.id))
    .orderBy(desc(receipts.id))
    .limit(8);

  for (const r of rows) {
    console.log(`\n${r.id.slice(0, 8)} | org=${r.orgName} | vendor=${r.contactName ?? '—'} | total=$${r.total} | storedDate=${r.storedDate}`);
    if (!r.raw) {
      console.log('  (no veryfi raw json)');
      continue;
    }
    try {
      const parsed = JSON.parse(r.raw);
      // Veryfi commonly returns these date fields:
      console.log('  veryfi.date          =', parsed.date);
      console.log('  veryfi.created_date  =', parsed.created_date);
      console.log('  veryfi.document_date =', parsed.document_date);
      console.log('  veryfi.invoice_date  =', parsed.invoice_date);
      console.log('  veryfi.tracking_number=', parsed.tracking_number);
      // Vendor block (some date info can live there).
      if (parsed.vendor) {
        console.log('  veryfi.vendor.name   =', parsed.vendor.name);
        console.log('  veryfi.vendor.raw_name=', parsed.vendor.raw_name);
      }
      // Show any other field that looks like a date for sanity.
      const dateLikeKeys = Object.keys(parsed).filter((k) => /date/i.test(k));
      if (dateLikeKeys.length) {
        console.log('  all date-like keys:', dateLikeKeys.map((k) => `${k}=${JSON.stringify(parsed[k])}`).join('  '));
      }
    } catch (e) {
      console.log('  (could not parse raw json:', e instanceof Error ? e.message : e, ')');
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
