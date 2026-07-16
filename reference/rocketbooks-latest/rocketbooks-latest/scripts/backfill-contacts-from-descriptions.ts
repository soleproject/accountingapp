/**
 * Backfill contact_id on transactions that don't have one yet.
 *
 * For each transaction in the target org with contact_id IS NULL:
 *   1. Determine a candidate contact name. Order of preference:
 *        a. Plaid raw_json.merchant_name (already normalized by Plaid)
 *        b. raw_json.counterparties[*].name when merchant is null (Plaid often
 *           fills this for Zelle/Venmo/ACH counterparties)
 *        c. Heuristic extraction from description for "DES:" billers (ACH)
 *        d. None — transfers, fees, interest are intentionally left alone.
 *   2. Look for an existing contact in the same org by case-insensitive name
 *      match. If found, reuse its id.
 *   3. Otherwise create a new contact (createdByAi=true, needsReview=true so
 *      a human can sanity-check the auto-created entries later).
 *   4. Update transactions.contact_id.
 *
 * Defaults to DRY-RUN. Pass --apply to commit.
 *
 * Usage:
 *   tsx scripts/backfill-contacts-from-descriptions.ts "1021"           # dry-run
 *   tsx scripts/backfill-contacts-from-descriptions.ts "1021" --apply   # apply
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

config({ path: '.env.local' });

interface TxnRow {
  id: string;
  description: string | null;
  amount: number | null;
  date: string | null;
  reference: string | null;
  raw_json: unknown;
}

interface RawJson {
  merchant_name?: string | null;
  name?: string | null;
  counterparties?: Array<{ name?: string | null; type?: string | null }>;
  payment_channel?: string | null;
  personal_finance_category?: { primary?: string | null; detailed?: string | null } | null;
}

/** Normalize a name for case-insensitive matching across the contacts table.
 * Strips common business suffixes, single-letter middle initials, and
 * punctuation so "PayPal" matches "PayPal Inc.", "Romeo Ugali" matches
 * "Romeo G Ugali", "Capital One" matches "Capital One, NA", etc. */
function normName(s: string): string {
  let n = s.trim().toLowerCase().replace(/\s+/g, ' ');
  // Remove common entity suffixes when they appear as separate tokens.
  n = n.replace(/\b(inc|llc|l\.l\.c\.|corp|corporation|company|co|ltd|limited|n\.a\.|na|inc\.|plc|holdings|the)\b\.?/g, ' ');
  // Strip single-letter middle initials ("Romeo G Ugali" → "Romeo Ugali").
  n = n.replace(/\s[a-z]\.?\s/g, ' ');
  n = n.replace(/[.,&]/g, ' ');
  n = n.replace(/\s+/g, ' ').trim();
  return n;
}

/** Decide whether a description represents something that shouldn't get a contact
 * (transfers between the user's own accounts, bank fees, interest, etc.). Note:
 * `WIRE TYPE:` is NOT a blanket skip — many wires have a real ORIG:<counterparty>. */
function isNonContactDescription(desc: string | null, pfcPrimary: string | null): boolean {
  if (pfcPrimary === 'BANK_FEES') return true;
  if (!desc) return false;
  const d = desc.toLowerCase();
  if (d.includes('online banking transfer')) return true;
  if (d.startsWith('transfer from acct') || d.startsWith('transfer to acct')) return true;
  if (d.includes('wire transfer fee')) return true;
  // "WELLS FARGO IFI ... DDA TO DDA" is BofA's tag for transfers between the user's own
  // Wells Fargo + BofA accounts via FedNow/RTP. Skip — no external counterparty.
  if (d.includes('ach credit wells fargo ifi dda to dda') || d.includes('wells fargo ifi des:dda to dda')) return true;
  if (d.includes('monthly maintenance fee')) return true;
  if (d.includes('interest earned')) return true;
  // Pure "Venmo" with no further detail — let it through as a Venmo counterparty.
  // PFC TRANSFER_IN/OUT alone is NOT a skip — Plaid uses that for Zelle and other
  // P2P payments which DO have a real counterparty in the description.
  return false;
}

const BRAND_NORMALIZATION: Array<{ pattern: RegExp; brand: string }> = [
  { pattern: /^paypal\b/i,                  brand: 'PayPal' },
  { pattern: /^venmo\b/i,                   brand: 'Venmo' },
  { pattern: /^citi card\b/i,               brand: 'Citi Card' },
  { pattern: /^capital one\b/i,             brand: 'Capital One' },
  { pattern: /^credit one bank\b/i,         brand: 'Credit One Bank' },
  { pattern: /^healthy paws( pet)?\b/i,     brand: 'Healthy Paws Pet' },
  { pattern: /^chase\b/i,                   brand: 'Chase' },
  { pattern: /^american express\b|^amex\b/i, brand: 'American Express' },
  { pattern: /^discover\b/i,                brand: 'Discover' },
  { pattern: /^bank of america\b|^bofa\b/i, brand: 'Bank of America' },
  { pattern: /^wells fargo\b/i,             brand: 'Wells Fargo' },
];

/** Apply known-brand normalization to a raw extracted name (e.g.
 *  "PayPal MstrCRD" → "PayPal", "CITI CARD ONLINE" → "Citi Card"). */
function normalizeBrand(name: string): string {
  for (const { pattern, brand } of BRAND_NORMALIZATION) {
    if (pattern.test(name)) return brand;
  }
  return name;
}

/** Extract a counterparty from the description. Returns null when there's no
 * recognizable name (script will then skip the row, leaving contact_id null). */
function extractFromDescription(desc: string | null): string | null {
  if (!desc) return null;

  // "Zelle payment from <NAME> Conf# ..." or "Zelle payment to <NAME> [For "<memo>"] Conf# ..."
  // Capture up to either " For " or " Conf#" — whichever comes first — so the
  // memo never bleeds into the contact name regardless of how it's quoted/punctuated.
  const zelle = desc.match(/^Zelle payment (?:from|to) (.+?)(?:\s+For\s+|\s+Conf#)/i);
  if (zelle) return normalizeBrand(titleCase(zelle[1].trim()));

  // "WIRE TYPE:... ORIG:<NAME> ID:<id>"  or  "... ORIG CO NAME:<NAME> ..."
  const wireOrig = desc.match(/\bORIG:\s*([^/]+?)\s+ID:/i);
  if (wireOrig) {
    const name = wireOrig[1].replace(/^\d+\/\s*/, '').trim(); // strip leading "1/" prefix
    if (name.length >= 2) return normalizeBrand(titleCase(name));
  }
  const wireOrigName = desc.match(/\bORIG CO NAME:\s*([^/]+?)\s{2,}/i);
  if (wireOrigName) return normalizeBrand(titleCase(wireOrigName[1].trim()));

  // "<BILLER> DES:<purpose> ID:..." — biller is everything before " DES:"
  const desIdx = desc.indexOf(' DES:');
  if (desIdx > 0) {
    const biller = desc.slice(0, desIdx).trim();
    if (biller.length >= 3 && biller.length <= 80) return normalizeBrand(titleCase(biller));
  }

  // Plain brand mentions when the description starts with a known brand.
  for (const { pattern, brand } of BRAND_NORMALIZATION) {
    if (pattern.test(desc.trim())) return brand;
  }

  return null;
}

/** Title-case a name, preserving acronyms (all-caps tokens stay all-caps). */
function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => {
      if (w.length === 0) return w;
      if (/^[A-Z0-9.&]+$/.test(w) && w.length <= 4) return w; // acronym/short codes
      return w[0].toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

interface CandidateGroup {
  candidateName: string;
  source: 'merchant_name' | 'counterparty' | 'description_heuristic';
  txnIds: string[];
  // First example txn for display.
  sampleDescription: string | null;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const positional = args.filter((a) => !a.startsWith('--'));
  const target = positional[0];
  if (!target) {
    console.error('Usage: tsx scripts/backfill-contacts-from-descriptions.ts <org-name-or-id> [--apply]');
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

  // Pull transactions without a contact, joined to the raw plaid row for merchant info.
  const rows = await sql<TxnRow[]>`
    SELECT
      t.id,
      t.description,
      t.amount,
      t.date::text       AS date,
      t.reference,
      prt.raw_json       AS raw_json
    FROM transactions t
    LEFT JOIN plaid_raw_transactions prt
      ON prt.plaid_transaction_id = substring(t.reference FROM 7)
      AND t.reference LIKE 'plaid:%'
    WHERE t.organization_id = ${org.id}
      AND t.contact_id IS NULL
    ORDER BY t.date DESC NULLS LAST, t.id DESC
  `;
  console.log(`Transactions without a contact: ${rows.length}\n`);
  if (rows.length === 0) { await sql.end(); return; }

  // Existing contacts for matching.
  const existing = await sql<{ id: string; contact_name: string }[]>`
    SELECT id, contact_name FROM contacts WHERE organization_id = ${org.id} AND is_active = true
  `;
  const contactByNorm = new Map<string, { id: string; name: string }>(
    existing.map((c) => [normName(c.contact_name), { id: c.id, name: c.contact_name }]),
  );
  console.log(`Existing active contacts in org: ${existing.length}\n`);

  // Bucket each transaction into a candidate group (or skip).
  const groups = new Map<string, CandidateGroup>();
  const skipped: { id: string; description: string | null; reason: string }[] = [];

  for (const r of rows) {
    const raw = (r.raw_json ?? {}) as RawJson;
    const pfcPrimary = raw.personal_finance_category?.primary ?? null;

    if (isNonContactDescription(r.description, pfcPrimary)) {
      skipped.push({ id: r.id, description: r.description, reason: `non-contact (pfc=${pfcPrimary ?? '?'})` });
      continue;
    }

    let candidate: string | null = null;
    let source: CandidateGroup['source'] = 'merchant_name';

    // Priority order:
    //   1. Plaid merchant_name (normalized real merchant — best when present).
    //   2. Description heuristic — extracts the *specific* counterparty for
    //      Zelle/Venmo (recipient name), DES billers, wire ORIG fields. Beats
    //      Plaid's counterparties[] for these because counterparties[].name on
    //      payment-app rows is just the app ("Zelle"), losing the recipient.
    //   3. counterparties[].name — last-resort fallback.
    if (raw.merchant_name && raw.merchant_name.trim()) {
      candidate = raw.merchant_name.trim();
      source = 'merchant_name';
    }
    if (!candidate) {
      const ex = extractFromDescription(r.description);
      if (ex) {
        candidate = ex;
        source = 'description_heuristic';
      }
    }
    if (!candidate && raw.counterparties?.length) {
      const cp = raw.counterparties.find((c) => c.name && c.name.trim());
      if (cp?.name) {
        candidate = cp.name.trim();
        source = 'counterparty';
      }
    }

    if (!candidate) {
      skipped.push({ id: r.id, description: r.description, reason: 'no candidate name' });
      continue;
    }

    const key = normName(candidate);
    let g = groups.get(key);
    if (!g) {
      g = { candidateName: candidate, source, txnIds: [], sampleDescription: r.description };
      groups.set(key, g);
    }
    g.txnIds.push(r.id);
  }

  // Plan output.
  console.log('=== Plan ===\n');
  console.log(`${groups.size} unique candidate contact name(s) for ${rows.length - skipped.length} transactions\n`);

  const sorted = Array.from(groups.values()).sort((a, b) => b.txnIds.length - a.txnIds.length);
  let willReuse = 0, willCreate = 0;
  for (const g of sorted) {
    const norm = normName(g.candidateName);
    const match = contactByNorm.get(norm);
    if (match) {
      console.log(`  ↻ reuse "${match.name}" (${match.id.slice(0, 8)}…) ← ${g.txnIds.length} txn(s) [src=${g.source}]`);
      willReuse += g.txnIds.length;
    } else {
      console.log(`  + create "${g.candidateName}" ← ${g.txnIds.length} txn(s) [src=${g.source}]`);
      willCreate += g.txnIds.length;
    }
  }
  const reuseGroups = sorted.filter((g) => contactByNorm.has(normName(g.candidateName))).length;
  const createGroups = sorted.length - reuseGroups;

  console.log(`\nSummary:`);
  console.log(`  ${reuseGroups} groups reuse existing contacts (${willReuse} txns)`);
  console.log(`  ${createGroups} groups need new contacts (${willCreate} txns)`);
  console.log(`  ${skipped.length} transactions skipped (transfers/fees/no-candidate)`);

  if (skipped.length > 0 && skipped.length <= 30) {
    console.log(`\nSkipped (${skipped.length}):`);
    for (const s of skipped) {
      const desc = (s.description ?? '').slice(0, 60);
      console.log(`  · ${desc}  [${s.reason}]`);
    }
  } else if (skipped.length > 30) {
    console.log(`\nSkipped sample (${Math.min(skipped.length, 15)}/${skipped.length}):`);
    for (const s of skipped.slice(0, 15)) {
      const desc = (s.description ?? '').slice(0, 60);
      console.log(`  · ${desc}  [${s.reason}]`);
    }
  }

  if (!apply) {
    console.log('\nDRY-RUN — no rows changed. Re-run with --apply to commit.');
    await sql.end();
    return;
  }

  // Apply.
  console.log('\n=== Applying ===');
  let createdContacts = 0;
  let updatedTxns = 0;
  let failed = 0;

  for (const g of sorted) {
    const norm = normName(g.candidateName);
    let contactId = contactByNorm.get(norm)?.id ?? null;
    if (!contactId) {
      const newId = randomUUID();
      try {
        await sql`
          INSERT INTO contacts (id, organization_id, contact_name, type_tags, is_active, created_by_ai, system_generated, needs_review)
          VALUES (${newId}, ${org.id}, ${g.candidateName}, ${'[]'}::json, ${true}, ${true}, ${true}, ${true})
        `;
        contactId = newId;
        contactByNorm.set(norm, { id: newId, name: g.candidateName });
        createdContacts++;
        console.log(`  + created contact "${g.candidateName}" (${newId.slice(0, 8)}…)`);
      } catch (err) {
        console.log(`  ✗ failed to create contact "${g.candidateName}": ${err instanceof Error ? err.message : String(err)}`);
        failed += g.txnIds.length;
        continue;
      }
    }
    try {
      await sql`UPDATE transactions SET contact_id = ${contactId} WHERE id IN ${sql(g.txnIds)} AND organization_id = ${org.id}`;
      updatedTxns += g.txnIds.length;
    } catch (err) {
      console.log(`  ✗ failed to update ${g.txnIds.length} txn(s) for "${g.candidateName}": ${err instanceof Error ? err.message : String(err)}`);
      failed += g.txnIds.length;
    }
  }

  console.log(`\nApplied:`);
  console.log(`  contacts created : ${createdContacts}`);
  console.log(`  transactions set : ${updatedTxns}`);
  console.log(`  failed           : ${failed}`);
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
