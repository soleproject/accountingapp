/**
 * For Acme Corp receipts: show whether each one is linked to a real
 * contact row (receipts.contact_id) or just has a vendor name in the
 * Veryfi payload with no contact behind it.
 *
 * Run: npx tsx scripts/diagnose-receipt-contacts.ts
 */
import { config } from 'dotenv';
import { desc, eq } from 'drizzle-orm';
config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const { receipts, contacts, organizations } = await import('../db/schema/schema');

  const [acme] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, 'Acme Corp'))
    .limit(1);
  if (!acme) { console.log('Acme Corp not found'); process.exit(0); }

  const rows = await db
    .select({
      receiptId: receipts.id,
      contactId: receipts.contactId,
      contactName: contacts.contactName,
      receiptDate: receipts.receiptDate,
      total: receipts.totalAmount,
      vendorMetadata: receipts.vendorMetadata,
      raw: receipts.veryfiRawJson,
    })
    .from(receipts)
    .leftJoin(contacts, eq(receipts.contactId, contacts.id))
    .where(eq(receipts.organizationId, acme.id))
    .orderBy(desc(receipts.id));

  for (const r of rows) {
    let veryfiVendor: string | null = null;
    if (r.raw) {
      try {
        const p = JSON.parse(r.raw) as { vendor?: { name?: string } };
        veryfiVendor = p.vendor?.name ?? null;
      } catch {}
    }
    console.log(`\nReceipt ${r.receiptId.slice(0, 8)} | $${r.total} | ${r.receiptDate}`);
    console.log(`  Veryfi vendor.name: ${veryfiVendor ?? '(none)'}`);
    console.log(`  contacts row: ${r.contactId ? `id=${r.contactId.slice(0, 8)} name="${r.contactName}"` : 'NULL — no contact linked'}`);
    if (r.vendorMetadata) {
      console.log(`  vendor_metadata: ${r.vendorMetadata.slice(0, 80)}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
