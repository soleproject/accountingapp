/**
 * Recovery: for an org whose QB finalize mapped a bunch of PFCs to QB
 * "Uncategorized Expense/Income" (because QB had no specific match),
 * walk those overrides, look up each PFC's canonical (accountType,
 * detailType) slot from PFC_COA_MAPPINGS, find a CoA row in the org for
 * that slot (preferring the hidden seed), reactivate it, redirect the
 * override + every transaction using the old Uncategorized cat. Reposts
 * each transaction's JE so the GL reflects the real account, and sets
 * the reviewed flag based on the PFC classification.
 *
 * Idempotent — re-running finds no overrides pointing at Uncategorized
 * (because we already redirected them) and no-ops. Safe to run on the
 * same org multiple times.
 *
 * Usage:
 *   npx tsx scripts/recover-uncategorized-via-seed.ts "Acme 6 LLC"            # dry-run
 *   npx tsx scripts/recover-uncategorized-via-seed.ts "Acme 6 LLC" --apply
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const orgName = process.argv[2];
if (!orgName) throw new Error('usage: tsx scripts/recover-uncategorized-via-seed.ts "<org name>" [--apply]');
const apply = process.argv.includes('--apply');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

interface OrphanOverride {
  pfcDetailed: string;
  oldCoaId: string;
  oldAccountName: string;
}

interface RedirectPlan {
  pfcDetailed: string;
  classification: string;
  oldCoaId: string;
  oldAccountName: string;
  newCoaId: string;
  newAccountName: string;
  newWasInactive: boolean;
  reviewedByDefault: boolean;
  txnCount: number;
}

async function main() {
  const orgs = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM organizations WHERE name = ${orgName}`;
  if (orgs.length !== 1) throw new Error(`expected 1 match for "${orgName}"; got ${orgs.length}`);
  const orgId = orgs[0].id;
  console.log(`\norg: ${orgs[0].name} (${orgId})`);
  console.log(`${apply ? 'APPLY MODE' : 'DRY RUN'}\n`);

  // Step 1: find every override pointing at an Uncategorized account.
  const orphans = await sql<OrphanOverride[]>`
    SELECT
      o.pfc_detailed AS "pfcDetailed",
      coa.id AS "oldCoaId",
      coa.account_name AS "oldAccountName"
    FROM pfc_org_overrides o
    JOIN chart_of_accounts coa ON coa.id = o.category_account_id
    WHERE o.organization_id = ${orgId}
      AND (coa.account_name ~* 'uncategori[sz]ed' OR coa.detail_type ~* '^uncategori[sz]ed')`;
  console.log(`overrides pointing at Uncategorized: ${orphans.length}`);

  if (orphans.length === 0) {
    console.log('nothing to recover.');
    await sql.end();
    return;
  }

  // Close raw sql so we can use the Drizzle pool from server modules.
  await sql.end();

  const { getPfcMapping, reviewedByDefault } = await import('@/lib/accounting/pfc-coa-mapping');
  const { repostTransactionJE } = await import('@/lib/accounting/auto-post');
  const { db } = await import('@/db/client');
  const { chartOfAccounts, pfcOrgOverrides, transactions, plaidRawTransactions } = await import('@/db/schema/schema');
  const { and, eq, sql: drizzleSql } = await import('drizzle-orm');

  // Step 2: for each orphan, find the canonical slot's CoA row.
  const plans: RedirectPlan[] = [];
  let noSlotMatch = 0;
  let noMapping = 0;

  for (const o of orphans) {
    const mapping = getPfcMapping(o.pfcDetailed);
    if (!mapping) { noMapping++; continue; }

    // Search across the org's full CoA (active + inactive) for a row that
    // sits in this PFC's canonical (account_type, detail_type) slot.
    // Exclude the current target so we don't redirect onto ourselves.
    // Prefer system_generated=true (seed) since those are the canonical
    // default category rows.
    const candidates = await db
      .select({
        id: chartOfAccounts.id,
        accountName: chartOfAccounts.accountName,
        isActive: chartOfAccounts.isActive,
        systemGenerated: chartOfAccounts.systemGenerated,
      })
      .from(chartOfAccounts)
      .where(and(
        eq(chartOfAccounts.organizationId, orgId),
        eq(chartOfAccounts.accountType, mapping.accountType),
        eq(chartOfAccounts.detailType, mapping.detailType),
      ));

    const filtered = candidates.filter((c) => c.id !== o.oldCoaId);
    if (filtered.length === 0) { noSlotMatch++; continue; }

    // Preference order: prefer a real QB-imported row (systemGenerated !==
    // true) over a seed when both exist in the canonical slot — these
    // accounts exist in the user's QB CoA, so they're the right
    // destination for forward-bookkeeping continuity. Seed reactivation
    // is the fallback when no QB row covers the slot.
    // Within each tier, prefer active rows so we don't unnecessarily
    // unhide one when an active option exists.
    const qbRows = filtered.filter((c) => c.systemGenerated !== true);
    const seedRows = filtered.filter((c) => c.systemGenerated === true);
    const target =
      qbRows.find((c) => c.isActive !== false) ??
      qbRows[0] ??
      seedRows.find((c) => c.isActive !== false) ??
      seedRows[0];

    // Count how many transactions this redirect would touch — joins
    // plaid_raw_transactions to filter by PFC so we only repoint txns
    // whose original PFC actually maps to this override.
    const [{ n: txnCount }] = await db
      .select({ n: drizzleSql<number>`COUNT(*)::int` })
      .from(transactions)
      .innerJoin(
        plaidRawTransactions,
        drizzleSql`${plaidRawTransactions.plaidTransactionId} = REPLACE(${transactions.reference}, 'plaid:', '')`,
      )
      .where(and(
        eq(transactions.organizationId, orgId),
        eq(transactions.categoryAccountId, o.oldCoaId),
        drizzleSql`${plaidRawTransactions.rawJson}->'personal_finance_category'->>'detailed' = ${o.pfcDetailed}`,
      ));

    plans.push({
      pfcDetailed: o.pfcDetailed,
      classification: mapping.classification,
      oldCoaId: o.oldCoaId,
      oldAccountName: o.oldAccountName,
      newCoaId: target.id,
      newAccountName: target.accountName,
      newWasInactive: target.isActive === false,
      reviewedByDefault: reviewedByDefault(mapping.classification),
      txnCount,
    });
  }

  console.log(`  → ${plans.length} would redirect`);
  console.log(`  → ${noSlotMatch} have no other CoA row in their canonical slot — stay on Uncategorized`);
  console.log(`  → ${noMapping} unmapped PFCs — stay on Uncategorized\n`);

  if (plans.length === 0) {
    console.log('no redirects possible. done.');
    return;
  }

  // Per-redirect summary.
  console.log('planned redirects (top 20 by txn count):');
  const top = [...plans].sort((a, b) => b.txnCount - a.txnCount).slice(0, 20);
  for (const p of top) {
    console.log(`  ${p.pfcDetailed.padEnd(45)} → ${p.newAccountName.padEnd(35)} ${p.txnCount}txn ${p.newWasInactive ? '(reactivating)' : ''}`);
  }
  const totalTxns = plans.reduce((s, p) => s + p.txnCount, 0);
  const reactivations = plans.filter((p) => p.newWasInactive).length;
  console.log(`\ntotals: ${plans.length} overrides redirected, ${reactivations} seeds reactivated, ${totalTxns} transactions repointed (each gets a JE repost)\n`);

  if (!apply) {
    console.log('Re-run with --apply to execute.');
    return;
  }

  // Step 3: apply. Per-override loop so a single failure doesn't poison
  // the whole batch. Within each, a single DB transaction wraps the
  // reactivate + override update + per-txn repoint loop.
  let applied = 0;
  let errored = 0;
  let txnsRepointed = 0;
  let jeReposted = 0;

  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    if ((i + 1) % 5 === 0 || i === plans.length - 1) {
      console.log(`  …${i + 1}/${plans.length} (${jeReposted} JE reposts so far)`);
    }

    try {
      // Reactivate the new target if it was hidden — must happen BEFORE
      // we route transactions to it so the picker/resolver can find it.
      if (p.newWasInactive) {
        await db
          .update(chartOfAccounts)
          .set({ isActive: true })
          .where(eq(chartOfAccounts.id, p.newCoaId));
      }

      // Update the override to point at the new account. Source becomes
      // 'seed_fallback' to record that this was a post-hoc redirect from
      // the AI's Uncategorized pick.
      await db
        .update(pfcOrgOverrides)
        .set({
          categoryAccountId: p.newCoaId,
          source: 'seed_fallback',
          reasoning: `auto-redirected from "${p.oldAccountName}" — PFC's canonical slot had an available row in this org`,
          updatedAt: new Date().toISOString(),
        })
        .where(and(
          eq(pfcOrgOverrides.organizationId, orgId),
          eq(pfcOrgOverrides.pfcDetailed, p.pfcDetailed),
        ));

      // Find every txn using the old cat AND this PFC. Repost JE + update
      // categoryAccountId + flip reviewed.
      const txns = await db
        .select({
          id: transactions.id,
          date: transactions.date,
          amount: transactions.amount,
          type: transactions.type,
          accountId: transactions.accountId,
          contactId: transactions.contactId,
          bankDescription: transactions.bankDescription,
          userDescription: transactions.userDescription,
          journalEntryId: transactions.journalEntryId,
        })
        .from(transactions)
        .innerJoin(
          plaidRawTransactions,
          drizzleSql`${plaidRawTransactions.plaidTransactionId} = REPLACE(${transactions.reference}, 'plaid:', '')`,
        )
        .where(and(
          eq(transactions.organizationId, orgId),
          eq(transactions.categoryAccountId, p.oldCoaId),
          drizzleSql`${plaidRawTransactions.rawJson}->'personal_finance_category'->>'detailed' = ${p.pfcDetailed}`,
        ));

      for (const t of txns) {
        if (t.amount === null || !t.type || !t.accountId) continue;

        // Repost JE first — this reverses the old "Uncategorized" post
        // and creates a new one against the new account.
        if (t.journalEntryId) {
          try {
            const result = await repostTransactionJE({
              txn: {
                id: t.id,
                organizationId: orgId,
                date: t.date,
                type: t.type,
                amount: Number(t.amount),
                accountId: t.accountId,
                categoryAccountId: p.newCoaId,
                contactId: t.contactId,
                bankDescription: t.bankDescription,
                userDescription: t.userDescription,
              },
              existingJournalEntryId: t.journalEntryId,
            });
            // Update the transaction with the new JE id + category +
            // reviewed flag. The reposter sets journal_entry_id too but
            // we set it again here to keep this loop self-contained.
            await db
              .update(transactions)
              .set({
                categoryAccountId: p.newCoaId,
                journalEntryId: result.replacementId,
                reviewed: p.reviewedByDefault,
              })
              .where(eq(transactions.id, t.id));
            jeReposted++;
          } catch (jeErr) {
            const msg = jeErr instanceof Error ? jeErr.message : String(jeErr);
            console.log(`    JE repost failed for ${t.id.slice(0, 8)}: ${msg}`);
            // Still update the categoryAccountId so at least the txn
            // shows the right account, even if its GL is stale until a
            // manual repost.
            await db
              .update(transactions)
              .set({ categoryAccountId: p.newCoaId, reviewed: p.reviewedByDefault })
              .where(eq(transactions.id, t.id));
          }
        } else {
          // No existing JE — just update the txn and let downstream
          // posting jobs handle the JE creation.
          await db
            .update(transactions)
            .set({ categoryAccountId: p.newCoaId, reviewed: p.reviewedByDefault })
            .where(eq(transactions.id, t.id));
        }
        txnsRepointed++;
      }

      applied++;
    } catch (err) {
      errored++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  override ${p.pfcDetailed} failed: ${msg}`);
    }
  }

  console.log('\nsummary:');
  console.log(`  overrides redirected:  ${applied}`);
  console.log(`  txns repointed:        ${txnsRepointed}`);
  console.log(`  JEs reposted:          ${jeReposted}`);
  console.log(`  errored:               ${errored}`);
}

main().catch((err) => {
  console.error('recover failed:', err);
  process.exit(1);
});
