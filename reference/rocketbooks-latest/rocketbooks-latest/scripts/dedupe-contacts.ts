/**
 * One-shot cleanup script for duplicate contacts in the contacts table.
 *
 * Background:
 *   resolve-contact-ai.ts (and ensure-contact.ts) used case-insensitive
 *   exact matching, then trusted the AI's match_existing_id verdict to
 *   decide whether to reuse an existing contact. The AI sometimes punted
 *   even when the strings were identical — every Veryfi import re-extracted
 *   the same vendor name and we INSERTed a fresh duplicate ("GitHub" three
 *   times in 400 LLC after three monthly statements).
 *
 *   The fix in lib/accounting/normalize-contact-name.ts + the resolver
 *   prevents new dupes; this script merges the existing ones.
 *
 * Cleanup strategy:
 *   - Group active contacts per org by normalizeContactNameForMatch.
 *   - Each group with N>1 picks the OLDEST as winner (deterministic; the
 *     oldest typically has the most accumulated FK references and the
 *     most stable id).
 *   - Discover every column named contact_id / *_contact_id in any table
 *     via information_schema.columns and rewrite winner←loser on each.
 *     contact_profiles has UNIQUE(contact_id) — handled specially: if the
 *     winner already has a profile row, the loser's profile is deleted;
 *     otherwise it's repointed.
 *   - Soft-delete losers (is_active=false). Keeps audit history; the
 *     active-only unique index added by 0009 doesn't see them.
 *
 * Safety harness:
 *   --dry-run               Print every action, write nothing. Always safe.
 *   --i-have-a-backup       Required for non-dry-run.
 *   --confirm-prod          Required for non-dry-run against production.
 *   --org=<uuid-prefix>     Restrict to one org. Useful for incremental rollout.
 *   --max-groups=<n>        Stop after N groups. Useful for testing subsets.
 *
 * Logging: per-group transaction with continue-on-error. Each action goes
 * to stdout AND _smoke/dedupe-contacts-<ISO_TIMESTAMP>.log.
 *
 * Idempotent: re-running on a clean dataset finds 0 dup groups → no-op.
 *
 * Usage:
 *   npx tsx scripts/dedupe-contacts.ts --dry-run
 *   npx tsx scripts/dedupe-contacts.ts --i-have-a-backup --confirm-prod
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { normalizeContactNameForMatch } from '@/lib/accounting/normalize-contact-name';

config({ path: '.env.local' });

interface CliFlags {
  dryRun: boolean;
  iHaveABackup: boolean;
  confirmProd: boolean;
  orgFilter: string | null;
  maxGroups: number | null;
}

function parseFlags(): CliFlags {
  const args = process.argv.slice(2);
  const flags: CliFlags = {
    dryRun: args.includes('--dry-run'),
    iHaveABackup: args.includes('--i-have-a-backup'),
    confirmProd: args.includes('--confirm-prod'),
    orgFilter: null,
    maxGroups: null,
  };
  for (const a of args) {
    if (a.startsWith('--org=')) flags.orgFilter = a.slice('--org='.length);
    if (a.startsWith('--max-groups=')) flags.maxGroups = parseInt(a.slice('--max-groups='.length), 10) || null;
  }
  return flags;
}

const flags = parseFlags();

const url = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!url) {
  console.error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) must be set');
  process.exit(1);
}
const isProd = url.includes('supabase.com');

if (!flags.dryRun) {
  if (!flags.iHaveABackup) {
    console.error('Refusing to run destructive cleanup without --i-have-a-backup');
    process.exit(1);
  }
  if (isProd && !flags.confirmProd) {
    console.error('Refusing to run against production without --confirm-prod');
    process.exit(1);
  }
}

const logDir = '_smoke';
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
const logPath = `${logDir}/dedupe-contacts-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
writeFileSync(logPath, `# dedupe-contacts ${new Date().toISOString()}\n`);

function log(msg: string) {
  console.log(msg);
  appendFileSync(logPath, msg + '\n');
}

const sql = postgres(url, { max: 1, ssl: 'require' });

interface ContactRow {
  id: string;
  organization_id: string;
  contact_name: string;
  is_active: boolean;
  created_at: string;
}

interface FkColumn {
  table_name: string;
  column_name: string;
  has_unique: boolean;
}

/** Discover every column in the public schema named contact_id or *_contact_id. */
async function findContactFkColumns(): Promise<FkColumn[]> {
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (column_name = 'contact_id' OR column_name LIKE '%\\_contact\\_id' ESCAPE '\\')
      AND table_name <> 'contacts'
    ORDER BY table_name, column_name
  `;
  // Detect unique constraints on (column) — needed for contact_profiles.
  const uniques = await sql<{ table_name: string; column_name: string }[]>`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = 'public'
      AND tc.constraint_type = 'UNIQUE'
      AND (kcu.column_name = 'contact_id' OR kcu.column_name LIKE '%\\_contact\\_id' ESCAPE '\\')
  `;
  const uniqueSet = new Set(uniques.map((u) => `${u.table_name}.${u.column_name}`));
  return rows.map((r) => ({
    table_name: r.table_name,
    column_name: r.column_name,
    has_unique: uniqueSet.has(`${r.table_name}.${r.column_name}`),
  }));
}

async function loadContacts(orgFilter: string | null): Promise<ContactRow[]> {
  if (orgFilter) {
    return sql<ContactRow[]>`
      SELECT id, organization_id, contact_name, is_active, created_at::text AS created_at
      FROM contacts
      WHERE is_active = true AND organization_id LIKE ${orgFilter + '%'}
    `;
  }
  return sql<ContactRow[]>`
    SELECT id, organization_id, contact_name, is_active, created_at::text AS created_at
    FROM contacts
    WHERE is_active = true
  `;
}

interface DupGroup {
  organizationId: string;
  matchKey: string;
  winner: ContactRow;
  losers: ContactRow[];
}

function groupDupes(contacts: ContactRow[]): DupGroup[] {
  const byKey = new Map<string, ContactRow[]>();
  for (const c of contacts) {
    const key = `${c.organization_id}|${normalizeContactNameForMatch(c.contact_name)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(c);
  }
  const groups: DupGroup[] = [];
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const [winner, ...losers] = sorted;
    groups.push({
      organizationId: winner.organization_id,
      matchKey: key.split('|')[1],
      winner,
      losers,
    });
  }
  return groups;
}

async function mergeGroup(group: DupGroup, fkColumns: FkColumn[]): Promise<void> {
  const loserIds = group.losers.map((l) => l.id);

  log(
    `\n[group] org=${group.organizationId.slice(0, 8)} key="${group.matchKey}" ` +
    `winner=${group.winner.id.slice(0, 8)} (${group.winner.contact_name}) losers=${loserIds.length}`,
  );
  for (const l of group.losers) {
    log(`  loser ${l.id.slice(0, 8)} "${l.contact_name}" created_at=${l.created_at}`);
  }

  if (flags.dryRun) {
    for (const fk of fkColumns) {
      const counts = await sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM ${sql(fk.table_name)}
        WHERE ${sql(fk.column_name)} = ANY(${loserIds})
      `;
      if (counts[0]?.n > 0) {
        log(`  [dry-run] WOULD UPDATE ${fk.table_name}.${fk.column_name}: ${counts[0].n} rows`);
      }
    }
    log(`  [dry-run] WOULD soft-delete ${loserIds.length} losers`);
    return;
  }

  await sql.begin(async (tx) => {
    for (const fk of fkColumns) {
      if (fk.has_unique) {
        // Special: column has UNIQUE — we may already have a row pointing
        // at the winner. Delete losers' rows that would conflict; UPDATE
        // the rest.
        const conflicts = await tx<{ loser: string }[]>`
          SELECT t.${tx(fk.column_name)} AS loser
          FROM ${tx(fk.table_name)} t
          WHERE t.${tx(fk.column_name)} = ANY(${loserIds})
            AND EXISTS (
              SELECT 1 FROM ${tx(fk.table_name)} w
              WHERE w.${tx(fk.column_name)} = ${group.winner.id}
            )
        `;
        if (conflicts.length > 0) {
          const deleted = await tx`
            DELETE FROM ${tx(fk.table_name)}
            WHERE ${tx(fk.column_name)} = ANY(${loserIds})
            RETURNING ${tx(fk.column_name)} AS id
          `;
          log(`  DELETE conflict ${fk.table_name}.${fk.column_name}: ${deleted.length} rows`);
        } else {
          const updated = await tx`
            UPDATE ${tx(fk.table_name)}
            SET ${tx(fk.column_name)} = ${group.winner.id}
            WHERE ${tx(fk.column_name)} = ANY(${loserIds})
            RETURNING ${tx(fk.column_name)} AS id
          `;
          if (updated.length > 0) {
            log(`  UPDATE ${fk.table_name}.${fk.column_name}: ${updated.length} rows`);
          }
        }
      } else {
        const updated = await tx`
          UPDATE ${tx(fk.table_name)}
          SET ${tx(fk.column_name)} = ${group.winner.id}
          WHERE ${tx(fk.column_name)} = ANY(${loserIds})
          RETURNING ${tx(fk.column_name)} AS id
        `;
        if (updated.length > 0) {
          log(`  UPDATE ${fk.table_name}.${fk.column_name}: ${updated.length} rows`);
        }
      }
    }
    await tx`
      UPDATE contacts SET is_active = false, updated_at = NOW()
      WHERE id = ANY(${loserIds})
    `;
    log(`  soft-deleted ${loserIds.length} loser contact rows`);
  });
}

async function main() {
  log(`flags: ${JSON.stringify(flags)}`);
  log(`db: ${isProd ? 'PRODUCTION' : 'non-prod'}`);

  if (!flags.dryRun) {
    const rl = createInterface({ input: stdin, output: stdout });
    const ans = await rl.question(
      `\nAbout to MERGE duplicate contacts in ${isProd ? 'PRODUCTION' : 'non-prod'}.\n` +
      `Type "MERGE" to proceed: `,
    );
    rl.close();
    if (ans.trim() !== 'MERGE') {
      log('Aborted by user.');
      await sql.end();
      return;
    }
  }

  const fkColumns = await findContactFkColumns();
  log(`\nFK columns referencing contacts.id (or named *contact_id*):`);
  for (const fk of fkColumns) {
    log(`  ${fk.table_name}.${fk.column_name}${fk.has_unique ? ' [UNIQUE]' : ''}`);
  }

  const contacts = await loadContacts(flags.orgFilter);
  log(`\nLoaded ${contacts.length} active contacts${flags.orgFilter ? ` (org filter: ${flags.orgFilter})` : ''}`);

  const groups = groupDupes(contacts);
  log(`Found ${groups.length} duplicate groups`);

  const limit = flags.maxGroups ?? groups.length;
  let processed = 0;
  let merged = 0;
  let failed = 0;
  for (const g of groups.slice(0, limit)) {
    processed++;
    try {
      await mergeGroup(g, fkColumns);
      merged++;
    } catch (err) {
      failed++;
      log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(
    `\nDone. processed=${processed} merged=${merged} failed=${failed} ` +
    `(of ${groups.length} total dup groups). Log: ${logPath}`,
  );
  await sql.end();
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
