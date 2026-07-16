/**
 * Backfill: process every Plaid-originated transaction in an org that's
 * stuck unreviewed because plaid-promote pre-fix didn't honor the
 * override path. Two cases:
 *
 *   A. categoryAccountId IS NULL — re-resolve PFC, set category +
 *      reviewed flag, post a JE. Equivalent to what plaid-promote
 *      *should* have done at insert time.
 *
 *   B. categoryAccountId IS NOT NULL but reviewed=false — the auto-
 *      categorize Inngest job set the category but never updated the
 *      reviewed flag. Just flip reviewed based on the PFC's
 *      classification; leave category and JE alone.
 *
 * Bypasses the running server, so it works even when the dev server
 * still has the pre-fix code in memory. Restart the dev server before
 * the next Plaid sync or the bug recurs for any new txns.
 *
 * Usage:
 *   npx tsx scripts/backfill-plaid-categorization.ts "Acme 2 LLC"            # dry-run
 *   npx tsx scripts/backfill-plaid-categorization.ts "Acme 2 LLC" --apply    # actually update
 *
 * Idempotent — only touches reviewed=false rows.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const orgName = process.argv[2];
if (!orgName) throw new Error('usage: tsx scripts/backfill-plaid-categorization.ts "<org name>" [--apply]');
const apply = process.argv.includes('--apply');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

interface Candidate {
  id: string;
  date: string;
  amount: string;
  type: string;
  accountId: string;
  contactId: string | null;
  description: string | null;
  categoryAccountId: string | null;
  pfcDetailed: string | null;
}

async function main() {
  const orgs = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM organizations WHERE name = ${orgName}`;
  if (orgs.length !== 1) throw new Error(`expected 1 match; got ${orgs.length}`);
  const orgId = orgs[0].id;
  console.log(`\norg: ${orgs[0].name} (${orgId})`);
  console.log(`${apply ? 'APPLY MODE' : 'DRY RUN'}\n`);

  const candidates = await sql<Candidate[]>`
    SELECT
      t.id, t.date::text AS date, t.amount::text AS amount, t.type,
      t.account_id AS "accountId", t.contact_id AS "contactId",
      t.description, t.category_account_id AS "categoryAccountId",
      (prt.raw_json -> 'personal_finance_category' ->> 'detailed') AS "pfcDetailed"
    FROM transactions t
    JOIN plaid_raw_transactions prt
      ON prt.plaid_transaction_id = REPLACE(t.reference, 'plaid:', '')
    WHERE t.organization_id = ${orgId}
      AND t.reference LIKE 'plaid:%'
      AND (t.reviewed = false OR t.reviewed IS NULL)`;

  console.log(`candidates: ${candidates.length}`);
  const nullCat = candidates.filter((c) => c.categoryAccountId === null).length;
  const setCat = candidates.length - nullCat;
  console.log(`  with categoryAccountId IS NULL:  ${nullCat}  (case A — needs full categorize + JE)`);
  console.log(`  with categoryAccountId set:      ${setCat}  (case B — just flip reviewed)`);

  if (candidates.length === 0) {
    await sql.end();
    return;
  }

  await sql.end();

  const { resolvePfcCoa } = await import('@/lib/accounting/resolve-pfc-coa');
  const { createJournalEntryFromTransaction } = await import('@/lib/accounting/auto-post');
  const { db } = await import('@/db/client');
  const { transactions } = await import('@/db/schema/schema');
  const { eq } = await import('drizzle-orm');

  let plannedFlipOnly = 0;     // case B
  let plannedCategorize = 0;   // case A → reviewed=false (transfers etc.)
  let plannedCategorizeAndPost = 0; // case A → reviewed=true (needs JE)
  let unresolvable = 0;
  let errored = 0;

  // Per-row updates so a single bad row doesn't poison the batch. CoA is
  // small and the resolver is in-memory after first call, so this is fast
  // enough on 1.7k rows (~30-60s).
  let i = 0;
  for (const c of candidates) {
    i++;
    if (i % 100 === 0) console.log(`  …${i}/${candidates.length}`);
    if (!c.pfcDetailed) { unresolvable++; continue; }

    try {
      const pfc = await resolvePfcCoa({ organizationId: orgId, pfcDetailed: c.pfcDetailed });
      if (!pfc) { unresolvable++; continue; }

      // CASE B — already categorized, just align reviewed flag.
      if (c.categoryAccountId !== null) {
        plannedFlipOnly++;
        if (!apply) continue;
        await db
          .update(transactions)
          .set({ reviewed: pfc.reviewedByDefault })
          .where(eq(transactions.id, c.id));
        continue;
      }

      // CASE A — no category yet. Need override or primary to act.
      if (pfc.categoryAccountId === null) { unresolvable++; continue; }
      if (pfc.source !== 'primary' && pfc.source !== 'override') { unresolvable++; continue; }

      if (pfc.reviewedByDefault) plannedCategorizeAndPost++;
      else plannedCategorize++;

      if (!apply) continue;

      await db
        .update(transactions)
        .set({
          categoryAccountId: pfc.categoryAccountId,
          reviewed: pfc.reviewedByDefault,
        })
        .where(eq(transactions.id, c.id));

      // Post JE only for confidently-classified rows. Review-queue items
      // (transfers, uncategorized) wait until the user clears them.
      if (pfc.reviewedByDefault) {
        try {
          const jeId = await createJournalEntryFromTransaction({
            id: c.id,
            organizationId: orgId,
            date: c.date,
            type: c.type as 'deposit' | 'withdrawal',
            amount: Number(c.amount),
            accountId: c.accountId,
            categoryAccountId: pfc.categoryAccountId,
            contactId: c.contactId,
            bankDescription: c.description,
            userDescription: null,
          });
          await db
            .update(transactions)
            .set({ journalEntryId: jeId })
            .where(eq(transactions.id, c.id));
        } catch (jeErr) {
          const msg = jeErr instanceof Error ? jeErr.message : String(jeErr);
          console.log(`  JE failed for ${c.id.slice(0, 8)}: ${msg}`);
        }
      }
    } catch (err) {
      errored++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  resolve failed for ${c.id.slice(0, 8)} (pfc=${c.pfcDetailed}): ${msg}`);
    }
  }

  console.log('\nsummary:');
  console.log(`  candidates:                                       ${candidates.length}`);
  console.log(`  case A — categorize + post JE (reviewed=true):    ${plannedCategorizeAndPost}`);
  console.log(`  case A — categorize, leave unreviewed (transfers):${plannedCategorize}`);
  console.log(`  case B — just flip reviewed flag:                 ${plannedFlipOnly}`);
  console.log(`  unresolvable (no PFC / no mapping):               ${unresolvable}`);
  console.log(`  errored:                                          ${errored}`);
  console.log(apply ? '\ndone.' : '\nRe-run with --apply to update.');
}

main().catch((err) => { console.error('backfill failed:', err); process.exit(1); });
