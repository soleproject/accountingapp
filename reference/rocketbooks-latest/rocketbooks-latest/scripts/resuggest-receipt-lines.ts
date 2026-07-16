/**
 * Re-run AI suggest for a receipt's lines + populate suggested_account_id.
 * Run: npx tsx scripts/resuggest-receipt-lines.ts <receiptId> [--apply]
 */
import { config } from 'dotenv';
import { eq, asc } from 'drizzle-orm';
config({ path: '.env.local' });
async function main() {
  const apply = process.argv.includes('--apply');
  const id = process.argv.find((a) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(a));
  if (!id) { console.log('Usage: npx tsx scripts/resuggest-receipt-lines.ts <receiptId> [--apply]'); process.exit(1); }

  const { db } = await import('../db/client');
  const { receipts, receiptLines, contacts } = await import('../db/schema/schema');
  const { suggestLineAccounts } = await import('../lib/receipts/suggest-line-accounts');

  const [r] = await db
    .select({ id: receipts.id, orgId: receipts.organizationId, contactId: receipts.contactId, vendor: contacts.contactName })
    .from(receipts)
    .leftJoin(contacts, eq(receipts.contactId, contacts.id))
    .where(eq(receipts.id, id))
    .limit(1);
  if (!r) { console.log('Receipt not found'); process.exit(0); }
  console.log(`Receipt ${r.id.slice(0,8)} | vendor=${r.vendor ?? '—'}`);

  const lines = await db
    .select({ id: receiptLines.id, desc: receiptLines.description, amt: receiptLines.amount })
    .from(receiptLines)
    .where(eq(receiptLines.receiptId, r.id))
    .orderBy(asc(receiptLines.id));
  if (lines.length === 0) { console.log('No lines'); process.exit(0); }

  const suggestions = await suggestLineAccounts(
    r.orgId,
    r.vendor,
    lines.map((l) => ({ description: l.desc, amount: Number(l.amt) })),
  );
  console.log(`\nSuggestions for ${lines.length} lines:`);
  for (let i = 0; i < lines.length; i++) {
    const s = suggestions[i];
    console.log(`  ${lines[i].desc?.slice(0,20).padEnd(20)} → ${s.accountId?.slice(0,8) ?? 'NULL'}`);
  }
  const got = suggestions.filter((s) => s.accountId).length;
  console.log(`\n${got} / ${lines.length} suggested`);

  if (apply && got > 0) {
    for (let i = 0; i < lines.length; i++) {
      const s = suggestions[i];
      if (!s.accountId) continue;
      await db.update(receiptLines).set({ suggestedAccountId: s.accountId }).where(eq(receiptLines.id, lines[i].id));
    }
    console.log('✓ applied');
  } else if (got > 0) {
    console.log('Pass --apply to commit.');
  }
  process.exit(0);
}
main().catch(console.error);
