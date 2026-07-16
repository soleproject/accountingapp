import { config } from 'dotenv';
import { eq, desc } from 'drizzle-orm';
config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const { journalEntries, journalEntryLines, organizations, chartOfAccounts, contacts } = await import('../db/schema/schema');

  const [acme] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, 'Acme Corp'))
    .limit(1);
  if (!acme) { console.log('Acme Corp not found'); process.exit(0); }
  console.log(`Acme Corp orgId: ${acme.id}`);

  const jes = await db
    .select({
      id: journalEntries.id,
      date: journalEntries.date,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      reversalOfId: journalEntries.reversalOfId,
      memo: journalEntries.memo,
    })
    .from(journalEntries)
    .where(eq(journalEntries.organizationId, acme.id))
    .orderBy(desc(journalEntries.date), desc(journalEntries.createdAt));

  // Find reversers so we can mark each as active/reversed/reversal.
  const reversedBy = new Map<string, string>();
  for (const j of jes) if (j.reversalOfId) reversedBy.set(j.reversalOfId, j.id);

  console.log(`\nAll JEs in Acme Corp (${jes.length}):`);
  for (const j of jes) {
    const state = j.reversalOfId ? 'REVERSAL' : reversedBy.has(j.id) ? 'REVERSED' : 'ACTIVE';
    console.log(`  ${j.id.slice(0, 8)} | ${j.date} | ${state.padEnd(8)} | source=${j.sourceType ?? 'manual'}/${j.sourceId?.slice(0, 8) ?? '-'} | "${j.memo}"`);
  }

  console.log(`\nActive (not reversed, not a reversal): ${jes.filter((j) => !j.reversalOfId && !reversedBy.has(j.id)).length}`);

  // Show lines on each active JE to confirm they're all org-scoped contacts.
  console.log(`\nActive JE lines + contacts:`);
  for (const j of jes) {
    if (j.reversalOfId || reversedBy.has(j.id)) continue;
    const lines = await db
      .select({
        debit: journalEntryLines.debit,
        credit: journalEntryLines.credit,
        accountName: chartOfAccounts.accountName,
        accountNumber: chartOfAccounts.accountNumber,
        contactName: contacts.contactName,
      })
      .from(journalEntryLines)
      .leftJoin(chartOfAccounts, eq(journalEntryLines.accountId, chartOfAccounts.id))
      .leftJoin(contacts, eq(journalEntryLines.contactId, contacts.id))
      .where(eq(journalEntryLines.journalEntryId, j.id));
    console.log(`  JE ${j.id.slice(0, 8)} (${lines.length}):`);
    for (const l of lines) {
      console.log(`    ${l.accountNumber ?? '?'} ${l.accountName ?? '?'} | D=${l.debit} C=${l.credit} | contact=${l.contactName ?? '—'}`);
    }
  }

  process.exit(0);
}
main().catch(console.error);
