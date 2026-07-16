/**
 * Backfill contacts.logo_url from Plaid raw-transaction data we already store.
 *
 * Plaid sends a CDN `logo_url` on every transaction it can match to a known
 * merchant (Walmart, Starbucks, etc.). We persist the full payload in
 * plaid_raw_transactions.raw_json on every sync, so the URLs are already
 * sitting in the DB — no API calls needed. This script joins contacts to
 * those raw rows by merchant_name and copies the most recent non-empty
 * logo_url onto the contact.
 *
 * Match rule: case-insensitive equality between contacts.contact_name and
 * raw_json->>'merchant_name'. We deliberately do NOT try fuzzy matches here —
 * if Plaid's merchant_name doesn't exactly match the contact (e.g. a contact
 * created from a Zelle description), there's no Plaid logo for it anyway.
 *
 * Defaults to DRY-RUN. Pass --apply to commit.
 *
 * Usage:
 *   tsx scripts/backfill-contact-logos-from-plaid.ts "1021"           # dry-run
 *   tsx scripts/backfill-contact-logos-from-plaid.ts "1021" --apply   # apply
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

interface MappingRow {
  contact_id: string;
  contact_name: string;
  logo_url: string;
  merchant_name: string;
  supporting_count: number;
  sample_at: string;
}

interface UncoveredRow {
  contact_id: string;
  contact_name: string;
  txn_count: number;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const positional = args.filter((a) => !a.startsWith('--'));
  const target = positional[0];
  if (!target) {
    console.error('Usage: tsx scripts/backfill-contact-logos-from-plaid.ts <org-name-or-id> [--apply]');
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
    await sql.end();
    process.exit(1);
  }
  const org = orgs[0];
  console.log(`Org: ${org.id}  ${org.name}`);
  console.log(`Mode: ${apply ? 'APPLY (will mutate)' : 'DRY-RUN (no changes)'}\n`);

  // Baseline counts so the user can eyeball coverage.
  const [{ total_contacts, with_logo, without_logo }] = await sql<
    { total_contacts: number; with_logo: number; without_logo: number }[]
  >`
    SELECT
      COUNT(*)::int                                             AS total_contacts,
      COUNT(*) FILTER (WHERE logo_url IS NOT NULL)::int         AS with_logo,
      COUNT(*) FILTER (WHERE logo_url IS NULL)::int             AS without_logo
    FROM contacts
    WHERE organization_id = ${org.id}
      AND is_active = true
  `;
  console.log(`Active contacts in org   : ${total_contacts}`);
  console.log(`  already have a logo    : ${with_logo}`);
  console.log(`  missing a logo         : ${without_logo}\n`);

  if (without_logo === 0) {
    console.log('Nothing to do — every active contact already has a logo_url.');
    await sql.end();
    return;
  }

  // For every contact missing a logo, find the most recent matching plaid
  // raw row (by merchant_name, case-insensitive) that carried a non-empty
  // logo_url. DISTINCT ON picks one row per contact deterministically.
  const mappings = await sql<MappingRow[]>`
    SELECT DISTINCT ON (c.id)
      c.id                                AS contact_id,
      c.contact_name                      AS contact_name,
      prt.raw_json->>'logo_url'           AS logo_url,
      prt.raw_json->>'merchant_name'      AS merchant_name,
      COUNT(*) OVER (PARTITION BY c.id)::int AS supporting_count,
      prt.created_at::text                AS sample_at
    FROM contacts c
    JOIN plaid_accounts pa
      ON pa.linked_organization_id = c.organization_id
    JOIN plaid_raw_transactions prt
      ON prt.plaid_account_id = pa.id
    WHERE c.organization_id = ${org.id}
      AND c.is_active = true
      AND c.logo_url IS NULL
      AND LOWER(prt.raw_json->>'merchant_name') = LOWER(c.contact_name)
      AND COALESCE(prt.raw_json->>'logo_url', '') <> ''
    ORDER BY c.id, prt.created_at DESC
  `;

  console.log(`=== Plan ===\n`);
  console.log(`Will set logo_url on ${mappings.length} contact(s).\n`);

  const sample = mappings.slice(0, 25);
  for (const m of sample) {
    const url = m.logo_url.length > 70 ? m.logo_url.slice(0, 67) + '...' : m.logo_url;
    console.log(`  + ${m.contact_name.padEnd(32).slice(0, 32)}  ←  ${url}  [${m.supporting_count} txn(s)]`);
  }
  if (mappings.length > sample.length) {
    console.log(`  … and ${mappings.length - sample.length} more`);
  }

  // Coverage check: for the contacts we still can't fill, show the top ones
  // by transaction count so the user can see what Plaid didn't recognize.
  const stillUncovered = without_logo - mappings.length;
  if (stillUncovered > 0) {
    // Build the exclusion set of ids that the mapping query covered, then
    // ANY/array-compare against it — handles the empty-mappings case cleanly
    // (postgres.js can't render `IN ()` from an empty array).
    const coveredIds = mappings.map((m) => m.contact_id);
    const uncovered = await sql<UncoveredRow[]>`
      SELECT
        c.id                AS contact_id,
        c.contact_name      AS contact_name,
        COUNT(t.id)::int    AS txn_count
      FROM contacts c
      LEFT JOIN transactions t
        ON t.contact_id = c.id
       AND t.organization_id = c.organization_id
      WHERE c.organization_id = ${org.id}
        AND c.is_active = true
        AND c.logo_url IS NULL
        AND c.id <> ALL(${coveredIds}::varchar[])
      GROUP BY c.id, c.contact_name
      ORDER BY COUNT(t.id) DESC, c.contact_name ASC
      LIMIT 15
    `;
    console.log(`\n${stillUncovered} contact(s) will remain without a logo (no Plaid match).`);
    console.log(`Top uncovered contacts by transaction volume:`);
    for (const u of uncovered) {
      console.log(`  · ${u.contact_name.padEnd(32).slice(0, 32)}  (${u.txn_count} txn(s))`);
    }
  }

  console.log(`\nSummary:`);
  console.log(`  contacts to update : ${mappings.length}`);
  console.log(`  remaining without  : ${stillUncovered}`);
  console.log(`  projected coverage : ${total_contacts === 0 ? '—' : Math.round(((with_logo + mappings.length) / total_contacts) * 100) + '%'}`);

  if (!apply) {
    console.log('\nDRY-RUN — no rows changed. Re-run with --apply to commit.');
    await sql.end();
    return;
  }

  console.log('\n=== Applying ===');
  let updated = 0;
  let failed = 0;
  for (const m of mappings) {
    try {
      await sql`
        UPDATE contacts
           SET logo_url = ${m.logo_url},
               updated_at = NOW()
         WHERE id = ${m.contact_id}
           AND organization_id = ${org.id}
           AND logo_url IS NULL
      `;
      updated++;
    } catch (err) {
      console.log(`  ✗ failed for "${m.contact_name}": ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\nApplied:`);
  console.log(`  contacts updated : ${updated}`);
  console.log(`  failed           : ${failed}`);
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
