/**
 * Clean up auto-created contacts that came from transactions with no
 * Plaid merchant_name (transfers, Zelle, ACH billers without normalization,
 * fees, interest). Those are typically junk contact entries like "Online
 * Banking Transfer To Chk 6084" or "Wire Type Book In Date".
 *
 * Steps:
 *   1. Find transactions whose linked plaid_raw_transactions.raw_json
 *      has a null/empty merchant_name.
 *   2. Group by contact_id. For each contact, also count transactions
 *      referencing it that DO have a merchant_name (those would still
 *      need it). Contacts referenced by mixed or merchant-only rows are
 *      preserved.
 *   3. NULL out contact_id on the no-merchant transactions.
 *   4. Try to delete contacts that have zero remaining `transactions`
 *      refs. If FK constraint fails (other tables still reference it),
 *      report and skip — the contact stays in the contacts table but
 *      no longer hangs off the cleaned-up transactions.
 *
 * Defaults to DRY-RUN. Pass --apply to commit.
 *
 * Usage:
 *   tsx scripts/cleanup-no-merchant-contacts.ts "1021"
 *   tsx scripts/cleanup-no-merchant-contacts.ts "1021" --apply
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

interface NoMerchantTxn {
  txn_id: string;
  contact_id: string;
  description: string | null;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const positional = args.filter((a) => !a.startsWith('--'));
  const target = positional[0];
  if (!target) {
    console.error('Usage: tsx scripts/cleanup-no-merchant-contacts.ts <org-name-or-id> [--apply]');
    process.exit(2);
  }

  const sql = postgres(process.env.POSTGRES_URL_NON_POOLING!, { prepare: false, max: 1 });

  const isUuid = /^[0-9a-f-]{36}$/i.test(target);
  const orgs = isUuid
    ? await sql<{ id: string; name: string }[]>`SELECT id, name FROM organizations WHERE id = ${target}`
    : await sql<{ id: string; name: string }[]>`
        SELECT id, name FROM organizations WHERE name ILIKE ${'%' + target + '%'}
        ORDER BY created_at DESC LIMIT 5
      `;
  if (orgs.length === 0) { console.error(`No org matched "${target}"`); await sql.end(); process.exit(1); }
  if (orgs.length > 1) {
    console.error(`Multiple orgs matched: ${orgs.map((o) => `${o.id} ${o.name}`).join(' | ')}`);
    await sql.end(); process.exit(1);
  }
  const org = orgs[0];
  console.log(`Org: ${org.id}  ${org.name}`);
  console.log(`Mode: ${apply ? 'APPLY (will mutate)' : 'DRY-RUN (no changes)'}\n`);

  // 1. Find transactions in this org with a contact_id whose linked
  //    plaid raw row has null/empty merchant_name.
  const noMerchant = await sql<NoMerchantTxn[]>`
    SELECT
      t.id           AS txn_id,
      t.contact_id   AS contact_id,
      t.description  AS description
    FROM transactions t
    JOIN plaid_raw_transactions prt
      ON prt.plaid_transaction_id = substring(t.reference FROM 7)
      AND t.reference LIKE 'plaid:%'
    WHERE t.organization_id = ${org.id}
      AND t.contact_id IS NOT NULL
      AND (prt.raw_json->>'merchant_name' IS NULL OR prt.raw_json->>'merchant_name' = '')
  `;
  console.log(`No-merchant transactions with a contact: ${noMerchant.length}`);
  if (noMerchant.length === 0) { await sql.end(); return; }

  // 2. Per contact: count of bad refs (no-merchant) vs good refs (has-merchant)
  //    so we don't delete contacts that real-merchant transactions also use.
  const contactIds = Array.from(new Set(noMerchant.map((r) => r.contact_id)));
  const contactInfo = await sql<
    { id: string; contact_name: string; bad_refs: number; good_refs: number; other_refs: number }[]
  >`
    SELECT
      c.id,
      c.contact_name,
      COUNT(*) FILTER (
        WHERE t.organization_id = ${org.id}
          AND t.reference LIKE 'plaid:%'
          AND (prt.raw_json->>'merchant_name' IS NULL OR prt.raw_json->>'merchant_name' = '')
      )::int AS bad_refs,
      COUNT(*) FILTER (
        WHERE t.organization_id = ${org.id}
          AND t.reference LIKE 'plaid:%'
          AND prt.raw_json->>'merchant_name' IS NOT NULL
          AND prt.raw_json->>'merchant_name' <> ''
      )::int AS good_refs,
      COUNT(*) FILTER (
        WHERE t.organization_id = ${org.id}
          AND (t.reference IS NULL OR t.reference NOT LIKE 'plaid:%')
      )::int AS other_refs
    FROM contacts c
    LEFT JOIN transactions t ON t.contact_id = c.id
    LEFT JOIN plaid_raw_transactions prt
      ON prt.plaid_transaction_id = substring(t.reference FROM 7)
      AND t.reference LIKE 'plaid:%'
    WHERE c.id IN ${sql(contactIds)}
    GROUP BY c.id, c.contact_name
    ORDER BY bad_refs DESC
  `;

  // 3. Decide per contact whether it's safe to delete (no good_refs and no
  //    other_refs in transactions table) or whether we just null out the bad refs.
  type ContactRow = (typeof contactInfo)[number];
  const deletable: ContactRow[] = [];
  const preserveOnly: ContactRow[] = [];
  for (const c of contactInfo) {
    if (c.good_refs === 0 && c.other_refs === 0) deletable.push(c);
    else preserveOnly.push(c);
  }

  console.log('\n=== Plan ===\n');
  console.log(`Will null out contact_id on ${noMerchant.length} no-merchant transactions.\n`);
  console.log(`Contacts to DELETE (no remaining transaction refs): ${deletable.length}`);
  for (const c of deletable.slice(0, 50)) {
    console.log(`  − "${c.contact_name}" (${c.id.slice(0, 8)}…)  bad=${c.bad_refs} good=${c.good_refs} other=${c.other_refs}`);
  }
  if (deletable.length > 50) console.log(`  … and ${deletable.length - 50} more`);

  console.log(`\nContacts to PRESERVE (still referenced by other transactions): ${preserveOnly.length}`);
  for (const c of preserveOnly.slice(0, 30)) {
    console.log(`  · "${c.contact_name}" (${c.id.slice(0, 8)}…)  bad=${c.bad_refs} good=${c.good_refs} other=${c.other_refs}`);
  }
  if (preserveOnly.length > 30) console.log(`  … and ${preserveOnly.length - 30} more`);

  if (!apply) {
    console.log('\nDRY-RUN — no rows changed. Re-run with --apply to commit.');
    await sql.end();
    return;
  }

  // 4. Apply. The UPDATE is one atomic statement. Each DELETE is run on its
  //    own — wrapping all deletes in a single transaction would abort on the
  //    first FK error (general_ledger / line_items / etc. may still reference
  //    a contact), and subsequent queries would fail with "current transaction
  //    is aborted." Running them independently isolates each FK failure.
  console.log('\n=== Applying ===');
  const txnIds = noMerchant.map((r) => r.txn_id);
  let nulled = 0;
  let deleted = 0;
  let deleteFailed = 0;

  // 4a. Null out contact_id on bad transactions.
  const updated = await sql`
    UPDATE transactions SET contact_id = NULL
    WHERE organization_id = ${org.id} AND id IN ${sql(txnIds)}
  `;
  nulled = updated.count ?? txnIds.length;
  console.log(`  nulled contact_id on ${nulled} transactions`);

  // 4b. Attempt to delete each contact independently.
  for (const c of deletable) {
    try {
      await sql`DELETE FROM contacts WHERE id = ${c.id} AND organization_id = ${org.id}`;
      deleted++;
    } catch (err) {
      deleteFailed++;
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      // Trim the verbose detail; the table name is enough to know which FK held it.
      const short = msg.length > 140 ? msg.slice(0, 140) + '…' : msg;
      console.log(`    ✗ skip "${c.contact_name.slice(0, 50)}…" (${c.id.slice(0, 8)}…): ${short}`);
    }
  }

  console.log(`\nApplied:`);
  console.log(`  transactions nulled  : ${nulled}`);
  console.log(`  contacts deleted     : ${deleted}`);
  console.log(`  contacts kept (FK)   : ${deleteFailed} (referenced by other tables)`);
  console.log(`  contacts preserved   : ${preserveOnly.length} (still in use by good transactions)`);
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
