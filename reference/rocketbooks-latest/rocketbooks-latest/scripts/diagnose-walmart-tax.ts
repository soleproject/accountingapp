import { config } from 'dotenv';
import { sql, desc, eq } from 'drizzle-orm';
config({ path: '.env.local' });
async function main() {
  const { db } = await import('../db/client');
  const { receipts, contacts, organizations } = await import('../db/schema/schema');
  const rows = await db
    .select({ id: receipts.id, total: receipts.totalAmount, raw: receipts.veryfiRawJson, vendor: contacts.contactName, org: organizations.name })
    .from(receipts)
    .leftJoin(contacts, eq(receipts.contactId, contacts.id))
    .leftJoin(organizations, eq(receipts.organizationId, organizations.id))
    .where(sql`${organizations.name} = 'Acme Corp' AND ${contacts.contactName} = 'Walmart'`)
    .orderBy(desc(receipts.id))
    .limit(1);
  if (!rows.length) { console.log('no rows'); process.exit(0); }
  const r = rows[0];
  console.log(`Receipt id=${r.id} total=$${r.total} vendor=${r.vendor} org=${r.org}`);
  if (!r.raw) { console.log('no raw json'); process.exit(0); }
  const p = JSON.parse(r.raw);
  console.log('parsed totals:');
  for (const k of Object.keys(p).filter((k) => /tax|tip|subtotal|total/i.test(k))) {
    console.log(`  ${k} =`, JSON.stringify(p[k]));
  }
  console.log('line_items sum:', (p.line_items ?? []).reduce((s: number, li: { total?: number }) => s + (li.total ?? 0), 0).toFixed(2));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
