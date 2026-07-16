/**
 * Clean up contacts whose names mirror raw bank-transaction descriptions —
 * the junk pattern produced by the old findOrCreateContact path and by
 * occasional AI regressions before the multi-layer prompt+regex+similarity
 * guards in resolve-contact-ai.ts.
 *
 * Junk-name patterns (any one match):
 *   - Contains "Recurring Payment authorized on" (Wells Fargo card-recurring prefix)
 *   - Contains "Wire Trans Svc Charge" (bank fee)
 *   - Contains "Card ####" (raw 4-digit card refs)
 *   - Contains "Online Banking transfer" / "TRANSFER FROM ACCT" / "TRANSFER TO ACCT"
 *   - Contains auth codes: "Conf#", "Trn#", "Srf#", " ID:"
 *   - Contains a 12+ digit S-code (Wells Fargo card auth codes)
 *   - Contains newlines / multi-line raw text
 *   - Longer than 60 chars
 *
 * For each matching contact:
 *   1. Null out transactions.contact_id (so the row goes back to review)
 *   2. Attempt DELETE on the contact. If FK constraints from
 *      general_ledger / journal_entry_lines block the delete (because old
 *      JEs still reference it), log and skip — the contact stays in the
 *      contacts table but no longer hangs off any active transactions.
 *
 * Defaults to DRY-RUN. Pass --apply to commit.
 *
 * Usage:
 *   tsx scripts/cleanup-description-named-contacts.ts            # all orgs, dry-run
 *   tsx scripts/cleanup-description-named-contacts.ts "656"      # single org by name pattern
 *   tsx scripts/cleanup-description-named-contacts.ts "656" --apply
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

interface ContactRow {
  id: string;
  contact_name: string;
  organization_id: string;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const positional = args.filter((a) => !a.startsWith('--'));
  const orgFilter = positional[0] ?? null;

  const sql = postgres(process.env.POSTGRES_URL_NON_POOLING!, { prepare: false, max: 1 });

  let orgIds: string[] | null = null;
  let orgName: string | null = null;
  if (orgFilter) {
    const orgs = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM organizations WHERE name ILIKE ${'%' + orgFilter + '%'}
      ORDER BY created_at DESC LIMIT 5
    `;
    if (orgs.length === 0) {
      console.error(`No org matched "${orgFilter}".`);
      await sql.end();
      process.exit(1);
    }
    if (orgs.length > 1) {
      console.error(`Multiple orgs matched "${orgFilter}":`);
      for (const o of orgs) console.error(`  ${o.id}  ${o.name}`);
      console.error('Re-run with the exact name.');
      await sql.end();
      process.exit(1);
    }
    orgIds = [orgs[0].id];
    orgName = orgs[0].name;
  }

  console.log(`Mode  : ${apply ? 'APPLY (will mutate)' : 'DRY-RUN (no changes)'}`);
  console.log(`Scope : ${orgIds ? `org "${orgName}" (${orgIds[0]})` : 'all organizations'}\n`);

  // ──────────────────────────────────────────────────────────────────────
  // Find junk-named contacts using a single SQL filter. Each predicate is
  // ORed; a contact is considered junk if any one match.
  // ──────────────────────────────────────────────────────────────────────
  const junkContacts = orgIds
    ? await sql<ContactRow[]>`
        SELECT id, contact_name, organization_id FROM contacts
        WHERE organization_id = ${orgIds[0]}
          AND is_active = true
          AND (
            length(contact_name) > 60
            OR contact_name ILIKE '%Recurring Payment authorized on%'
            OR contact_name ILIKE '%Wire Trans Svc Charge%'
            OR contact_name ILIKE '%Online Banking transfer%'
            OR contact_name ILIKE 'TRANSFER FROM ACCT%'
            OR contact_name ILIKE 'TRANSFER TO ACCT%'
            OR contact_name ~ '\\sCard\\s+\\d{4,}'
            OR contact_name ~ 'Conf#|Trn#|Srf#|\\sID:'
            OR contact_name ~ '\\sS\\d{12,}'
            OR contact_name ~ E'[\\n\\r]'
          )
        ORDER BY contact_name
      `
    : await sql<ContactRow[]>`
        SELECT id, contact_name, organization_id FROM contacts
        WHERE is_active = true
          AND (
            length(contact_name) > 60
            OR contact_name ILIKE '%Recurring Payment authorized on%'
            OR contact_name ILIKE '%Wire Trans Svc Charge%'
            OR contact_name ILIKE '%Online Banking transfer%'
            OR contact_name ILIKE 'TRANSFER FROM ACCT%'
            OR contact_name ILIKE 'TRANSFER TO ACCT%'
            OR contact_name ~ '\\sCard\\s+\\d{4,}'
            OR contact_name ~ 'Conf#|Trn#|Srf#|\\sID:'
            OR contact_name ~ '\\sS\\d{12,}'
            OR contact_name ~ E'[\\n\\r]'
          )
        ORDER BY contact_name
      `;
  console.log(`=== Junk-named contacts found: ${junkContacts.length} ===\n`);
  if (junkContacts.length === 0) {
    console.log('Nothing to clean up.');
    await sql.end();
    return;
  }

  // Per-contact reference counts so we know what we're about to disconnect.
  const idsArr = junkContacts.map((c) => c.id);
  const refs = idsArr.length === 0
    ? []
    : await sql<{ contact_id: string; n: number }[]>`
        SELECT contact_id, COUNT(*)::int AS n
        FROM transactions WHERE contact_id IN ${sql(idsArr)}
        GROUP BY contact_id
      `;
  const refMap = new Map(refs.map((r) => [r.contact_id, r.n]));

  // Show plan: top 30, then summary.
  console.log('Plan (first 30):');
  for (const c of junkContacts.slice(0, 30)) {
    const n = refMap.get(c.id) ?? 0;
    const preview = c.contact_name.replace(/\s+/g, ' ').slice(0, 70);
    console.log(`  ${n.toString().padStart(4)} txns  → "${preview}…"`);
  }
  if (junkContacts.length > 30) console.log(`  ... and ${junkContacts.length - 30} more`);

  const totalRefs = Array.from(refMap.values()).reduce((s, n) => s + n, 0);
  console.log(`\nWill null out contact_id on ${totalRefs} transactions across ${junkContacts.length} contacts.`);

  if (!apply) {
    console.log('\nDRY-RUN — no rows changed. Re-run with --apply to commit.');
    await sql.end();
    return;
  }

  // ─── Apply ──────────────────────────────────────────────────────────
  console.log('\n=== Applying ===');
  let nulled = 0;
  let deleted = 0;
  let kept = 0;

  // 1. Null out contact_id on every txn pointing at a junk contact. One
  //    UPDATE statement is fine — bounded by junk contact count.
  if (idsArr.length > 0) {
    const updated = await sql`
      UPDATE transactions SET contact_id = NULL
      WHERE contact_id IN ${sql(idsArr)}
    `;
    nulled = updated.count ?? 0;
    console.log(`  nulled contact_id on ${nulled} transactions`);
  }

  // 2. Attempt to delete each junk contact independently. FK errors from
  //    general_ledger / journal_entry_lines / etc. are caught and logged.
  for (const c of junkContacts) {
    try {
      await sql`DELETE FROM contacts WHERE id = ${c.id}`;
      deleted++;
    } catch (err) {
      kept++;
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      const short = msg.length > 140 ? msg.slice(0, 140) + '…' : msg;
      const preview = c.contact_name.replace(/\s+/g, ' ').slice(0, 50);
      console.log(`    ✗ keep "${preview}…": ${short}`);
    }
  }

  console.log(`\nApplied:`);
  console.log(`  transactions nulled : ${nulled}`);
  console.log(`  contacts deleted    : ${deleted}`);
  console.log(`  contacts kept (FK)  : ${kept} (still referenced from general_ledger / journal_entry_lines)`);
  console.log('\nNote: rows whose contact_id was nulled are now in the to_review queue. Re-run');
  console.log('      auto-categorize to let the AI reassign clean contacts using the fixed prompt.');
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
