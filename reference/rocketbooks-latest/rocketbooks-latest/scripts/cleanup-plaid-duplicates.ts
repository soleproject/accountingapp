/**
 * One-shot cleanup script for the plaid-sync cross-account fanout duplicates.
 *
 * Background:
 *   plaid-sync pre-fix wrote each Plaid txn to every account in the linked
 *   item, regardless of which sub-account it actually belonged to. The
 *   plaid-promote function then ran for each affected account in parallel,
 *   racing on a snapshot dedup that produced N transactions rows per
 *   plaid_transaction_id (where N varies by race timing). Many of those
 *   rows have an attached journal_entry_id — auto-categorize ran on each.
 *
 *   Migration 0004 (commit b of the dedup-fix branch) cleaned raw. This
 *   script cleans transactions + journal_entries + journal_entry_lines +
 *   general_ledger to match.
 *
 * Cleanup strategy:
 *   - Per-org classification: any in_scope=true account → IN-BOOKS (B2 reversal,
 *     preserves audit trail via reversal_of_id). All EXCLUDED → B1 hard delete
 *     (these JEs were never user-visible).
 *   - Per dup group: pick survivor whose account_id matches the row's
 *     "correct" bank-COA (resolved via plaid_raw_transactions.raw_json.
 *     account_id → plaid_accounts.plaid_account_id → chart_of_account_id).
 *     If no row is on the correct COA, fix the oldest row in place (Option 1:
 *     UPDATE transactions.account_id + the bank-side journal_entry_lines row +
 *     the bank-side general_ledger row, all in one transaction).
 *   - Reversing JEs are back-dated to the original JE's date (error-correction
 *     accounting: both rows fall in the same period and net to zero).
 *
 * Safety harness:
 *   --dry-run               Print every action, write nothing. Always safe.
 *   --i-have-a-backup       Required for non-dry-run.
 *   --confirm-prod          Required for non-dry-run against production.
 *   --org=<uuid-prefix>     Restrict to one org. Useful for incremental rollout.
 *   --max-groups=<n>        Stop after N groups. Useful for testing subsets.
 *
 * Logging: per-group transaction with continue-on-error. Each action goes
 * to stdout AND _smoke/cleanup-plaid-duplicates-<ISO_TIMESTAMP>.log.
 *
 * Idempotent: re-running on a clean dataset finds 0 dup groups → no-op.
 *
 * Usage:
 *   npx tsx scripts/cleanup-plaid-duplicates.ts --dry-run
 *   npx tsx scripts/cleanup-plaid-duplicates.ts --i-have-a-backup --confirm-prod
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

config({ path: '.env.local' });

const REVERSAL_MEMO =
  'Reversing duplicate transaction created by sync race condition on 2026-05-05 — see docs/security-fixes-2026-05-04.md';

// -----------------------------------------------------------------------------
// CLI flags
// -----------------------------------------------------------------------------
interface CliFlags {
  dryRun: boolean;
  iHaveBackup: boolean;
  confirmProd: boolean;
  orgFilter: string | null;
  maxGroups: number | null;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    dryRun: false,
    iHaveBackup: false,
    confirmProd: false,
    orgFilter: null,
    maxGroups: null,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--i-have-a-backup') flags.iHaveBackup = true;
    else if (arg === '--confirm-prod') flags.confirmProd = true;
    else if (arg.startsWith('--org=')) flags.orgFilter = arg.slice(6);
    else if (arg.startsWith('--max-groups=')) flags.maxGroups = parseInt(arg.slice(13), 10);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return flags;
}

function isProductionDb(url: string): boolean {
  // Supabase production hosts; extend if other prod targets emerge
  return /supabase\.com|amazonaws\.com/.test(url);
}

// -----------------------------------------------------------------------------
// Org classification
// -----------------------------------------------------------------------------
interface OrgInfo {
  id: string;
  name: string;
  isInBooks: boolean;
  scopedAccountCount: number;
  totalAccountCount: number;
}

async function classifyOrgs(
  sql: postgres.Sql,
  orgFilter: string | null,
): Promise<OrgInfo[]> {
  // Find every org that has at least one transactions row matching plaid:%
  // OR has plaid_accounts (so we cover the EXCLUDED orgs whose accounts
  // never promoted). Restrict to orgFilter if provided.
  const rows = (await sql`
    SELECT
      o.id,
      o.name,
      COUNT(*) FILTER (WHERE pa.in_scope = true)::int AS in_scope_count,
      COUNT(*)::int AS total_count
    FROM organizations o
    JOIN plaid_accounts pa ON pa.linked_organization_id = o.id
    ${orgFilter ? sql`WHERE o.id LIKE ${orgFilter + '%'}` : sql``}
    GROUP BY o.id, o.name
    ORDER BY o.name
  `) as Array<{ id: string; name: string; in_scope_count: number; total_count: number }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isInBooks: r.in_scope_count > 0,
    scopedAccountCount: r.in_scope_count,
    totalAccountCount: r.total_count,
  }));
}

// -----------------------------------------------------------------------------
// Dup group discovery
// -----------------------------------------------------------------------------
interface DupRow {
  id: string;
  account_id: string | null;
  journal_entry_id: string | null;
  reviewed: boolean | null;
  category_account_id: string | null;
  user_description: string | null;
  amount: number | null;
  date: string;
  created_at: string;
}

interface DupGroup {
  organizationId: string;
  reference: string;
  shape: 'cross-coa' | 'within-coa';
  rows: DupRow[];
  correctCoa: string | null; // resolved from raw_json.account_id
}

async function findDupGroups(
  sql: postgres.Sql,
  orgFilter: string | null,
  maxGroups: number | null,
): Promise<DupGroup[]> {
  // First: find all (org, ref) pairs with COUNT > 1
  const dupKeys = (await sql`
    SELECT t.organization_id, t.reference,
           COUNT(*)::int AS dup_count,
           COUNT(DISTINCT t.account_id)::int AS distinct_accounts
    FROM transactions t
    WHERE t.reference LIKE 'plaid:%'
      ${orgFilter ? sql`AND t.organization_id LIKE ${orgFilter + '%'}` : sql``}
    GROUP BY t.organization_id, t.reference
    HAVING COUNT(*) > 1
    ORDER BY t.organization_id, t.reference
    ${maxGroups != null ? sql`LIMIT ${maxGroups}` : sql``}
  `) as Array<{
    organization_id: string;
    reference: string;
    dup_count: number;
    distinct_accounts: number;
  }>;

  const groups: DupGroup[] = [];
  for (const k of dupKeys) {
    // Fetch all rows for this group
    const rows = (await sql`
      SELECT id, account_id, journal_entry_id, reviewed, category_account_id,
             user_description, amount, date, created_at
      FROM transactions
      WHERE organization_id = ${k.organization_id} AND reference = ${k.reference}
      ORDER BY created_at ASC, id ASC
    `) as DupRow[];

    // Resolve correct COA via raw_json.account_id
    const pid = k.reference.startsWith('plaid:') ? k.reference.slice(6) : null;
    let correctCoa: string | null = null;
    if (pid) {
      const [r] = (await sql`
        SELECT pa.chart_of_account_id
        FROM plaid_raw_transactions prt
        JOIN plaid_accounts pa
          ON pa.plaid_account_id = ((prt.raw_json::jsonb) ->> 'account_id')
         AND pa.linked_organization_id = ${k.organization_id}
        WHERE prt.plaid_transaction_id = ${pid}
        LIMIT 1
      `) as Array<{ chart_of_account_id: string | null }>;
      correctCoa = r?.chart_of_account_id ?? null;
    }

    groups.push({
      organizationId: k.organization_id,
      reference: k.reference,
      shape: k.distinct_accounts > 1 ? 'cross-coa' : 'within-coa',
      rows,
      correctCoa,
    });
  }
  return groups;
}

// -----------------------------------------------------------------------------
// Pre-flight counts
// -----------------------------------------------------------------------------
interface Counts {
  crossCoaGroups: number;
  withinCoaGroups: number;
  totalDupRows: number;
  txnRowsToDelete: number;
  jeHardDelete: number;
  jeReverse: number;
  reversingJesToInsert: number;
  glDelete: number;
  glInsert: number;
  survivorCoaFixesNeeded: number;
}

function computeCounts(orgs: OrgInfo[], groups: DupGroup[]): Counts {
  const orgById = new Map(orgs.map((o) => [o.id, o]));
  let crossCoa = 0;
  let withinCoa = 0;
  let totalDupRows = 0;
  let txnRowsToDelete = 0;
  let jeHardDelete = 0;
  let jeReverse = 0;
  let glDelete = 0;
  let glInsert = 0;
  let survivorCoaFixesNeeded = 0;

  for (const g of groups) {
    const org = orgById.get(g.organizationId);
    if (!org) continue;

    if (g.shape === 'cross-coa') crossCoa++;
    else withinCoa++;
    totalDupRows += g.rows.length;
    txnRowsToDelete += g.rows.length - 1;

    // Survivor identification
    let survivorIdx: number;
    if (g.correctCoa && g.shape === 'cross-coa') {
      const found = g.rows.findIndex((r) => r.account_id === g.correctCoa);
      survivorIdx = found >= 0 ? found : 0;
      if (found < 0) survivorCoaFixesNeeded++;
    } else {
      survivorIdx = 0; // oldest by created_at
    }

    // Losers: count je actions
    for (let i = 0; i < g.rows.length; i++) {
      if (i === survivorIdx) continue;
      if (g.rows[i].journal_entry_id == null) continue;
      if (org.isInBooks) {
        jeReverse++;
        glInsert += 2; // typically 2 lines per JE (bank + category) → 2 GL rows
      } else {
        jeHardDelete++;
        glDelete += 2;
      }
    }
  }

  return {
    crossCoaGroups: crossCoa,
    withinCoaGroups: withinCoa,
    totalDupRows,
    txnRowsToDelete,
    jeHardDelete,
    jeReverse,
    reversingJesToInsert: jeReverse,
    glDelete,
    glInsert,
    survivorCoaFixesNeeded,
  };
}

// -----------------------------------------------------------------------------
// Pre-flight printout
// -----------------------------------------------------------------------------
function printPreflight(
  flags: CliFlags,
  isProd: boolean,
  dbUrl: string,
  orgs: OrgInfo[],
  counts: Counts,
  orgGroupCounts: Map<string, number>,
): void {
  console.log('='.repeat(90));
  console.log('PLAID-DUP CLEANUP — pre-flight scope summary');
  console.log('='.repeat(90));
  console.log(`Connection:   ${dbUrl.replace(/:\/\/[^:]+:[^@]+@/, '://<redacted>@')}`);
  console.log(`Environment:  ${isProd ? 'PRODUCTION (detected via hostname)' : 'non-production'}`);
  console.log(`Mode:         ${flags.dryRun ? 'DRY-RUN' : 'EXECUTE'}`);
  if (flags.orgFilter) console.log(`Org filter:   ${flags.orgFilter}`);
  if (flags.maxGroups != null) console.log(`Max groups:   ${flags.maxGroups}`);
  console.log('');
  const orgsWithWork = orgs.filter((o) => (orgGroupCounts.get(o.id) ?? 0) > 0).length;
  console.log(`Orgs that will be touched: ${orgsWithWork} of ${orgs.length} listed below`);
  for (const o of orgs) {
    const gc = orgGroupCounts.get(o.id) ?? 0;
    const workNote = gc === 0 ? 'no dup groups — UNTOUCHED' : `${gc} dup groups`;
    console.log(
      `   ${o.name.padEnd(20)} (${o.id.slice(0, 8)})  ${o.isInBooks ? 'IN-BOOKS  → B2 reversal' : 'EXCLUDED  → B1 hard delete'}  (${o.scopedAccountCount}/${o.totalAccountCount} accts in scope)  ·  ${workNote}`,
    );
  }
  console.log('');
  console.log('Counts to be processed:');
  console.log(`   Cross-COA duplicate groups:                 ${String(counts.crossCoaGroups).padStart(6)}`);
  console.log(`   Within-COA duplicate groups:                ${String(counts.withinCoaGroups).padStart(6)}`);
  console.log(`   Total transaction rows in dup groups:       ${String(counts.totalDupRows).padStart(6)}`);
  console.log(`   Transactions rows to delete:                ${String(counts.txnRowsToDelete).padStart(6)}`);
  console.log(`   JEs to hard-delete (B1, EXCLUDED orgs):     ${String(counts.jeHardDelete).padStart(6)}`);
  console.log(`   JEs to reverse (B2, IN-BOOKS orgs):         ${String(counts.jeReverse).padStart(6)}`);
  console.log(`   Reversing JEs to be inserted (new):         ${String(counts.reversingJesToInsert).padStart(6)}`);
  console.log(`   GL rows to delete (B1):                    ~${String(counts.glDelete).padStart(6)}`);
  console.log(`   GL rows to insert (B2 reversals):          ~${String(counts.glInsert).padStart(6)}`);
  console.log(`   Survivors needing wrong-COA fix:            ${String(counts.survivorCoaFixesNeeded).padStart(6)}`);
  console.log('');
}

// -----------------------------------------------------------------------------
// Sample selection + printout
// -----------------------------------------------------------------------------
async function pickSamples(
  sql: postgres.Sql,
  groups: DupGroup[],
  orgs: OrgInfo[],
): Promise<DupGroup[]> {
  const orgById = new Map(orgs.map((o) => [o.id, o]));
  const samples: DupGroup[] = [];

  // 1: cross-coa from IN-BOOKS
  const inBooksCrossCoa = groups.find((g) => {
    const o = orgById.get(g.organizationId);
    return g.shape === 'cross-coa' && o?.isInBooks;
  });
  if (inBooksCrossCoa) samples.push(inBooksCrossCoa);

  // 2: cross-coa from EXCLUDED
  const excludedCrossCoa = groups.find((g) => {
    const o = orgById.get(g.organizationId);
    return g.shape === 'cross-coa' && o && !o.isInBooks;
  });
  if (excludedCrossCoa) samples.push(excludedCrossCoa);

  // 3: within-coa (any org), or fallback to another excluded cross-coa if none
  const withinCoa = groups.find((g) => g.shape === 'within-coa');
  if (withinCoa) samples.push(withinCoa);
  else {
    const fallback = groups.find(
      (g) => g.shape === 'cross-coa' && !samples.includes(g) && orgById.get(g.organizationId),
    );
    if (fallback) samples.push(fallback);
  }

  return samples;
}

interface AccountResolver {
  byCoaId: (coaId: string | null) => string;
}
async function buildResolver(sql: postgres.Sql): Promise<AccountResolver> {
  const accts = (await sql`
    SELECT id, account_name FROM chart_of_accounts
  `) as Array<{ id: string; account_name: string }>;
  const map = new Map(accts.map((a) => [a.id, a.account_name]));
  return {
    byCoaId: (id) => (id ? (map.get(id) ?? id.slice(0, 8)) : '(none)'),
  };
}

function printSamples(
  samples: DupGroup[],
  orgs: OrgInfo[],
  resolver: AccountResolver,
): void {
  console.log('='.repeat(90));
  console.log(`SAMPLE GROUPS — ${samples.length} representative case(s) before confirmation`);
  console.log('='.repeat(90));
  const orgById = new Map(orgs.map((o) => [o.id, o]));
  let i = 0;
  for (const g of samples) {
    i++;
    const org = orgById.get(g.organizationId);
    const path = !org ? '?' : org.isInBooks ? 'B2 reversal' : 'B1 hard delete';
    let survivorIdx: number;
    if (g.correctCoa && g.shape === 'cross-coa') {
      const found = g.rows.findIndex((r) => r.account_id === g.correctCoa);
      survivorIdx = found >= 0 ? found : 0;
    } else {
      survivorIdx = 0;
    }
    console.log('');
    console.log(`Sample ${i} of ${samples.length} — ${g.shape} (${path}):`);
    console.log(`  reference: ${g.reference}`);
    console.log(`  org:       ${org?.name ?? '?'} (${g.organizationId.slice(0, 8)}…)`);
    console.log(`  correct_coa: ${resolver.byCoaId(g.correctCoa)}${g.correctCoa ? '' : '  ⚠ unresolvable'}`);
    console.log('');
    console.log(`  Duplicate rows (${g.rows.length} total):`);
    for (let j = 0; j < g.rows.length; j++) {
      const r = g.rows[j];
      const label = j === survivorIdx ? '[SURVIVOR]' : '[DELETE]  ';
      const acctName = resolver.byCoaId(r.account_id);
      const acctNote =
        g.correctCoa && r.account_id === g.correctCoa ? ' (correct)' : g.correctCoa ? ' (wrong)' : '';
      const cat = r.category_account_id ? resolver.byCoaId(r.category_account_id) : 'none';
      const created = typeof r.created_at === 'string' ? r.created_at.slice(0, 19).replace('T', ' ') : '';
      console.log(
        `    ${label} id=${r.id.slice(0, 8)}…  account=${acctName}${acctNote}  amt=${r.amount ?? '?'}  JE=${r.journal_entry_id?.slice(0, 8) ?? 'none'}  reviewed=${r.reviewed ?? 'null'}  category=${cat}  created=${created}`,
      );
    }
    console.log('');
    console.log(`  Actions for this group:`);
    if (survivorIdx === 0 && g.correctCoa && g.rows[0].account_id !== g.correctCoa) {
      console.log(
        `    UPDATE survivor (id=${g.rows[0].id.slice(0, 8)}…) account_id from ${resolver.byCoaId(g.rows[0].account_id)} → ${resolver.byCoaId(g.correctCoa)} (Option 1: also updates JE bank-line + GL bank-row in same transaction)`,
      );
    }
    for (let j = 0; j < g.rows.length; j++) {
      if (j === survivorIdx) continue;
      const r = g.rows[j];
      if (r.journal_entry_id == null) {
        console.log(`    DELETE transactions ${r.id.slice(0, 8)}… (no JE)`);
      } else if (org?.isInBooks) {
        console.log(
          `    DELETE transactions ${r.id.slice(0, 8)}… + REVERSE JE ${r.journal_entry_id.slice(0, 8)}… (back-dated to JE's date, contra-entries on GL)`,
        );
      } else {
        console.log(
          `    DELETE transactions ${r.id.slice(0, 8)}… + hard-delete JE ${r.journal_entry_id.slice(0, 8)}… (org excluded)`,
        );
      }
    }
  }
  console.log('');
}

// -----------------------------------------------------------------------------
// Typed confirmation
// -----------------------------------------------------------------------------
async function typedConfirmation(orgCount: number): Promise<boolean> {
  const expected = `CLEANUP ${orgCount} ORGS`;
  console.log('='.repeat(90));
  console.log(`Type exactly: ${expected}`);
  console.log('(or anything else to abort, including blank line)');
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question('> ');
  rl.close();
  return answer.trim() === expected;
}

// -----------------------------------------------------------------------------
// Per-group processing
// -----------------------------------------------------------------------------
type LogFn = (msg: string) => void;

async function processGroup(
  sql: postgres.Sql,
  group: DupGroup,
  org: OrgInfo,
  log: LogFn,
): Promise<{ success: boolean; error?: string }> {
  // Identify survivor + losers
  let survivorIdx: number;
  let needsCoaFix = false;
  if (group.correctCoa && group.shape === 'cross-coa') {
    const found = group.rows.findIndex((r) => r.account_id === group.correctCoa);
    if (found >= 0) {
      survivorIdx = found;
    } else {
      survivorIdx = 0;
      needsCoaFix = true;
    }
  } else {
    survivorIdx = 0;
  }

  const survivor = group.rows[survivorIdx];
  const losers = group.rows.filter((_, i) => i !== survivorIdx);

  try {
    await sql.begin(async (tx) => {
      // Step 1: wrong-COA survivor fix (Option 1)
      if (needsCoaFix && group.correctCoa) {
        const originalCoa = survivor.account_id;
        log(
          `  [survivor-fix] org=${org.name} ref=${group.reference} survivor=${survivor.id.slice(0, 8)}… moving account_id ${originalCoa?.slice(0, 8) ?? '?'}…→${group.correctCoa.slice(0, 8)}…`,
        );
        await tx`UPDATE transactions SET account_id = ${group.correctCoa} WHERE id = ${survivor.id}`;
        if (survivor.journal_entry_id && originalCoa) {
          await tx`
            UPDATE journal_entry_lines
            SET account_id = ${group.correctCoa}
            WHERE journal_entry_id = ${survivor.journal_entry_id} AND account_id = ${originalCoa}
          `;
          await tx`
            UPDATE general_ledger
            SET account_id = ${group.correctCoa}
            WHERE journal_entry_id = ${survivor.journal_entry_id} AND account_id = ${originalCoa}
          `;
        }
      }

      // Step 2: process each loser
      for (const loser of losers) {
        if (loser.journal_entry_id == null) {
          log(`  [delete-no-je] org=${org.name} ref=${group.reference} loser=${loser.id.slice(0, 8)}…`);
          await tx`DELETE FROM transactions WHERE id = ${loser.id}`;
          continue;
        }

        if (org.isInBooks) {
          // B2: reverse the JE
          const newJeId = randomUUID();
          log(
            `  [reverse-je] org=${org.name} ref=${group.reference} loser=${loser.id.slice(0, 8)}… reversing JE ${loser.journal_entry_id.slice(0, 8)}… → new JE ${newJeId.slice(0, 8)}…`,
          );

          // Build reversing JE (back-dated to original date, posted=true)
          await tx`
            INSERT INTO journal_entries (id, organization_id, date, memo, posted, reversal_of_id, created_at, posted_at)
            SELECT ${newJeId}, organization_id, date, ${REVERSAL_MEMO}, true, id, NOW(), NOW()
            FROM journal_entries WHERE id = ${loser.journal_entry_id}
          `;

          // Mirror JE-lines with debit/credit swapped, minting new ids JS-side so
          // we can map original line id → new line id when we mirror the GL rows
          // below. Posting code always sets gl.journal_entry_line_id; preserving
          // that linkage on the reversal keeps reversal rows consistent with the
          // rest of the system (reports/relations that traverse GL → JE-line
          // would otherwise skip our reversals).
          const origLines = (await tx`
            SELECT id, account_id, debit, credit, memo, contact_id
            FROM journal_entry_lines
            WHERE journal_entry_id = ${loser.journal_entry_id}
          `) as Array<{
            id: string;
            account_id: string;
            debit: string;
            credit: string;
            memo: string | null;
            contact_id: string | null;
          }>;
          const lineIdMap = new Map<string, string>();
          for (const l of origLines) {
            const newLineId = randomUUID();
            lineIdMap.set(l.id, newLineId);
            await tx`
              INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, memo, contact_id, created_at)
              VALUES (${newLineId}, ${newJeId}, ${l.account_id}, ${l.credit}, ${l.debit}, ${l.memo}, ${l.contact_id}, NOW())
            `;
          }

          // Mirror GL rows with debit/credit swapped, date copied from original,
          // and journal_entry_line_id remapped via the line id map above so the
          // reversal preserves the GL-row → JE-line linkage.
          const origGl = (await tx`
            SELECT id, organization_id, account_id, journal_entry_line_id, contact_id, date, memo, debit, credit
            FROM general_ledger
            WHERE journal_entry_id = ${loser.journal_entry_id}
          `) as Array<{
            id: string;
            organization_id: string | null;
            account_id: string | null;
            journal_entry_line_id: string | null;
            contact_id: string | null;
            date: string | null;
            memo: string | null;
            debit: number | null;
            credit: number | null;
          }>;
          for (const g of origGl) {
            const newLineId = g.journal_entry_line_id
              ? (lineIdMap.get(g.journal_entry_line_id) ?? null)
              : null;
            await tx`
              INSERT INTO general_ledger (id, organization_id, account_id, journal_entry_id, journal_entry_line_id, contact_id, date, memo, debit, credit, balance, created_at)
              VALUES (${randomUUID()}, ${g.organization_id}, ${g.account_id}, ${newJeId}, ${newLineId}, ${g.contact_id}, ${g.date}, ${g.memo}, ${g.credit}, ${g.debit}, NULL, NOW())
            `;
          }

          // Detach the loser txn from its (still-existing) original JE, then delete the txn
          await tx`UPDATE transactions SET journal_entry_id = NULL WHERE id = ${loser.id}`;
          await tx`DELETE FROM transactions WHERE id = ${loser.id}`;
        } else {
          // B1: hard delete (EXCLUDED org — these JEs were never user-visible)
          log(
            `  [hard-delete-je] org=${org.name} ref=${group.reference} loser=${loser.id.slice(0, 8)}… deleting JE ${loser.journal_entry_id.slice(0, 8)}…`,
          );
          await tx`DELETE FROM general_ledger WHERE journal_entry_id = ${loser.journal_entry_id}`;
          await tx`DELETE FROM journal_entry_lines WHERE journal_entry_id = ${loser.journal_entry_id}`;
          await tx`DELETE FROM transactions WHERE id = ${loser.id}`;
          await tx`DELETE FROM journal_entries WHERE id = ${loser.journal_entry_id}`;
        }
      }
    });
    return { success: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`  [ERROR] org=${org.name} ref=${group.reference} — ${msg}`);
    return { success: false, error: msg };
  }
}

// -----------------------------------------------------------------------------
// Post-flight verification
// -----------------------------------------------------------------------------
async function postflightVerify(
  sql: postgres.Sql,
  orgFilter: string | null,
  log: LogFn,
): Promise<{ ok: boolean; failures: string[] }> {
  const failures: string[] = [];

  // 1: no remaining (org, reference) duplicates
  const dups = (await sql`
    SELECT organization_id, reference, COUNT(*)::int AS n
    FROM transactions
    WHERE reference LIKE 'plaid:%'
      ${orgFilter ? sql`AND organization_id LIKE ${orgFilter + '%'}` : sql``}
    GROUP BY organization_id, reference
    HAVING COUNT(*) > 1
    LIMIT 20
  `) as Array<{ organization_id: string; reference: string; n: number }>;
  if (dups.length > 0) {
    failures.push(`Remaining duplicate (org, ref) groups: ${dups.length} (showing first 20). First: org=${dups[0].organization_id.slice(0, 8)} ref=${dups[0].reference} count=${dups[0].n}`);
  }
  log(`  remaining_dup_groups: ${dups.length}`);

  // 2: no orphan JEs (JE with no transactions row pointing at it AND no reversal)
  // We only flag JEs that should still have a source row. A reversing JE
  // (reversal_of_id IS NOT NULL) is allowed to have no transactions row.
  const orphans = (await sql`
    SELECT je.id
    FROM journal_entries je
    LEFT JOIN transactions t ON t.journal_entry_id = je.id
    WHERE t.id IS NULL
      AND je.reversal_of_id IS NULL
      AND EXISTS (
        SELECT 1 FROM journal_entry_lines l WHERE l.journal_entry_id = je.id
      )
    LIMIT 20
  `) as Array<{ id: string }>;
  if (orphans.length > 0) {
    failures.push(`Orphan non-reversing JEs (no transactions row): ${orphans.length} (showing first 20). First: ${orphans[0].id.slice(0, 8)}…`);
  }
  log(`  orphan_jes: ${orphans.length}`);

  // 3: GL net to zero per JE (sanity check on accounting integrity)
  const unbalanced = (await sql`
    SELECT journal_entry_id, SUM(debit) - SUM(credit) AS imbalance
    FROM general_ledger
    WHERE journal_entry_id IS NOT NULL
    GROUP BY journal_entry_id
    HAVING ABS(SUM(debit) - SUM(credit)) > 0.001
    LIMIT 20
  `) as Array<{ journal_entry_id: string; imbalance: string }>;
  if (unbalanced.length > 0) {
    failures.push(`Unbalanced JEs (debit ≠ credit): ${unbalanced.length} (showing first 20). First: ${unbalanced[0].journal_entry_id.slice(0, 8)} imbalance=${unbalanced[0].imbalance}`);
  }
  log(`  unbalanced_jes: ${unbalanced.length}`);

  return { ok: failures.length === 0, failures };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const dbUrl = process.env.POSTGRES_URL_NON_POOLING;
  if (!dbUrl) throw new Error('POSTGRES_URL_NON_POOLING not set');
  const isProd = isProductionDb(dbUrl);

  // Mode validation
  if (!flags.dryRun) {
    if (!flags.iHaveBackup) {
      console.error('ERROR: --i-have-a-backup is required for non-dry-run execution.');
      console.error('Either pass --dry-run, or take a backup and pass --i-have-a-backup.');
      process.exit(1);
    }
    if (isProd && !flags.confirmProd) {
      console.error('ERROR: --confirm-prod is required when connecting to production.');
      console.error(`Detected production hostname in connection URL.`);
      process.exit(1);
    }
  }

  const sql = postgres(dbUrl, { max: 1, ssl: 'require' });

  try {
    const orgs = await classifyOrgs(sql, flags.orgFilter);
    if (orgs.length === 0) {
      console.log('No orgs with plaid_accounts found. Nothing to do.');
      return;
    }
    const groups = await findDupGroups(sql, flags.orgFilter, flags.maxGroups);

    const counts = computeCounts(orgs, groups);
    const orgGroupCounts = new Map<string, number>();
    for (const g of groups) {
      orgGroupCounts.set(g.organizationId, (orgGroupCounts.get(g.organizationId) ?? 0) + 1);
    }
    printPreflight(flags, isProd, dbUrl, orgs, counts, orgGroupCounts);

    if (groups.length === 0) {
      console.log('No duplicate groups found. Nothing to clean up. (Idempotent — re-run is safe.)');
      return;
    }

    const resolver = await buildResolver(sql);
    const samples = await pickSamples(sql, groups, orgs);
    if (samples.length > 0) printSamples(samples, orgs, resolver);

    if (!flags.dryRun) {
      // Confirmation count = orgs that actually have work, not all orgs with plaid_accounts.
      const orgsWithWork = orgGroupCounts.size;
      const confirmed = await typedConfirmation(orgsWithWork);
      if (!confirmed) {
        console.log('Aborted by user.');
        return;
      }
    }

    // Open log
    const startedAt = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir = '_smoke';
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const logPath = `${logDir}/cleanup-plaid-duplicates-${startedAt}.log`;
    if (!flags.dryRun) writeFileSync(logPath, `mode=EXECUTE started at ${new Date().toISOString()}\n`);
    const log: LogFn = (msg) => {
      console.log(msg);
      if (!flags.dryRun) appendFileSync(logPath, msg + '\n');
    };

    log('');
    log(`Processing ${groups.length} dup groups...`);
    log('');
    const orgById = new Map(orgs.map((o) => [o.id, o]));
    let success = 0;
    let errors = 0;

    for (const group of groups) {
      const org = orgById.get(group.organizationId);
      if (!org) {
        log(`  [skip] no org for ${group.organizationId} ref=${group.reference}`);
        continue;
      }

      if (flags.dryRun) {
        log(`  [DRY] would process org=${org.name} ref=${group.reference} shape=${group.shape} ${group.rows.length} rows`);
        success++;
        continue;
      }

      const result = await processGroup(sql, group, org, log);
      if (result.success) success++;
      else errors++;
    }

    log('');
    log(`Processed: success=${success}  errors=${errors}`);

    // Post-flight verification (skip for dry-run since nothing changed)
    if (!flags.dryRun) {
      log('');
      log('--- Post-flight verification ---');
      const v = await postflightVerify(sql, flags.orgFilter, log);
      if (v.ok) {
        log('  ✓ All assertions passed');
      } else {
        log('  ✗ FAILURES:');
        for (const f of v.failures) log(`    ${f}`);
      }
    }

    if (!flags.dryRun) console.log(`\nLog written to: ${logPath}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e: unknown) => {
  console.error('FAIL:', e instanceof Error ? e.message : e);
  process.exit(1);
});
