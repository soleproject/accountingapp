/**
 * One-off: manually trigger auto-apply for the pending Acme Corp
 * Walmart suggestion. Useful for testing phase 3 without re-uploading.
 *
 * Run: npx tsx scripts/apply-acme-walmart-match.ts
 */
import { config } from 'dotenv';
import { and, eq } from 'drizzle-orm';
config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const { receiptMatchSuggestions, receipts, contacts, organizations } = await import('../db/schema/schema');
  const { applyReceiptMatch, ApplyMatchError } = await import('../lib/receipts/apply-match');

  const rows = await db
    .select({
      id: receiptMatchSuggestions.id,
      orgId: receiptMatchSuggestions.organizationId,
      confidence: receiptMatchSuggestions.confidence,
      receiptId: receiptMatchSuggestions.receiptId,
      vendor: contacts.contactName,
      orgName: organizations.name,
      status: receiptMatchSuggestions.status,
    })
    .from(receiptMatchSuggestions)
    .innerJoin(receipts, eq(receiptMatchSuggestions.receiptId, receipts.id))
    .leftJoin(contacts, eq(receipts.contactId, contacts.id))
    .leftJoin(organizations, eq(receiptMatchSuggestions.organizationId, organizations.id))
    .where(and(eq(receiptMatchSuggestions.status, 'pending'), eq(organizations.name, 'Acme Corp')));

  console.log(`Found ${rows.length} pending Acme suggestion(s).`);
  for (const r of rows) {
    console.log(`\nApplying ${r.id.slice(0, 8)} (${r.vendor} receipt, conf=${r.confidence})…`);
    try {
      const result = await applyReceiptMatch({ organizationId: r.orgId, suggestionId: r.id });
      console.log(`✓ applied. applicationId=${result.applicationId} newJE=${result.newJournalEntryId}`);
    } catch (err) {
      if (err instanceof ApplyMatchError) console.log(`✗ ApplyMatchError: ${err.message}`);
      else console.error(`✗ unexpected:`, err);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
