/**
 * Diagnostic: report ground truth about the Plaid connection + transaction state
 * for a target org (default: "909 LLC"). Mirrors the pattern in
 * scripts/diagnose-categorization-session.ts.
 *
 * The Plaid Feed UI (app/(app)/plaid-feed/page.tsx) renders rows from
 * `plaid_raw_transactions` for plaid_accounts where linked_organization_id = orgId,
 * and marks each row "Promoted" when there's a matching `transactions` row with
 * reference = 'plaid:<plaidTransactionId>'. So we cross-check:
 *   - DB transactions vs raw feed (orphans on either side)
 *   - Plaid connection state (sync status, errors, cursor, last_synced_at)
 *   - Per-Item webhook state via plaid.itemGet (item.webhook on Plaid's side —
 *     this is the source of truth for "did this item get a webhook at link
 *     time"). Decrypts plaid_access_token using PLAID_ENCRYPTION_KEY.
 *
 * Read-only. Does not mutate anything.
 *
 * Usage:
 *   tsx scripts/diagnose-plaid-feed.ts                  # org '%909%' + its items
 *   tsx scripts/diagnose-plaid-feed.ts "Acme Corp"      # named org + its items
 *   tsx scripts/diagnose-plaid-feed.ts "909" --all      # also scan every item
 *   tsx scripts/diagnose-plaid-feed.ts --all            # global item scan only
 *
 * Required env (from .env.local):
 *   POSTGRES_URL_NON_POOLING, PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV,
 *   PLAID_ENCRYPTION_KEY
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { isAxiosError } from 'axios';

config({ path: '.env.local' });

const sql = postgres(process.env.POSTGRES_URL_NON_POOLING!, { prepare: false, max: 1 });

const RECENT_LIMIT = 20;

// Inline decrypt — mirrors lib/plaid/encryption.ts so this script doesn't pull
// in 'server-only' (which is fine in tsx but cleaner to avoid).
function decryptToken(payload: string): string {
  const secret = process.env.PLAID_ENCRYPTION_KEY;
  if (!secret) throw new Error('PLAID_ENCRYPTION_KEY is required');
  const key = scryptSync(secret, 'rocketsuite-plaid', 32);
  const [ivB64, tagB64, encB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !encB64) throw new Error('Malformed encrypted payload');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

const plaidEnvName = (process.env.PLAID_ENV ?? 'sandbox') as keyof typeof PlaidEnvironments;
const plaid = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[plaidEnvName],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID ?? '',
        'PLAID-SECRET': process.env.PLAID_SECRET ?? '',
        'Plaid-Version': '2020-09-14',
      },
    },
  }),
);

interface ItemReport {
  plaid_item_id: string;
  org_names: string[];
  institutions: string[];
  account_count: number;
  earliest_created: string;
  webhook: string | null | '(error)';
  error_code: string | null;
  error_message: string | null;
  available_products: string[] | null;
  billed_products: string[] | null;
  consent_expiration_time: string | null;
  update_type: string | null;
  itemget_error: string | null;
}

async function inspectItem(
  plaidItemId: string,
  meta: { orgNames: string[]; institutions: string[]; accountCount: number; earliestCreated: string; sampleAccessToken: string },
): Promise<ItemReport> {
  const base: ItemReport = {
    plaid_item_id: plaidItemId,
    org_names: meta.orgNames,
    institutions: meta.institutions,
    account_count: meta.accountCount,
    earliest_created: meta.earliestCreated,
    webhook: null,
    error_code: null,
    error_message: null,
    available_products: null,
    billed_products: null,
    consent_expiration_time: null,
    update_type: null,
    itemget_error: null,
  };
  let accessToken: string;
  try {
    accessToken = decryptToken(meta.sampleAccessToken);
  } catch (err) {
    return { ...base, webhook: '(error)', itemget_error: `decrypt failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const res = await plaid.itemGet({ access_token: accessToken });
    const item = res.data.item;
    return {
      ...base,
      webhook: item.webhook ?? null,
      error_code: item.error?.error_code ?? null,
      error_message: item.error?.error_message ?? null,
      available_products: item.available_products ?? null,
      billed_products: item.billed_products ?? null,
      consent_expiration_time: item.consent_expiration_time ?? null,
      update_type: item.update_type ?? null,
    };
  } catch (err) {
    const plaidError =
      isAxiosError(err) && err.response?.data
        ? (err.response.data as { error_code?: string; error_message?: string })
        : null;
    return {
      ...base,
      webhook: '(error)',
      itemget_error: plaidError
        ? `${plaidError.error_code}: ${plaidError.error_message}`
        : err instanceof Error
        ? err.message
        : String(err),
    };
  }
}

function printItemReport(r: ItemReport, indent = '  ') {
  const webhookCell =
    r.webhook === '(error)'
      ? '(itemGet errored)'
      : r.webhook === null || r.webhook === ''
      ? '*** NO WEBHOOK ***'
      : r.webhook;
  console.log(`${indent}plaid_item_id : ${r.plaid_item_id}`);
  console.log(`${indent}orgs          : ${r.org_names.join(', ') || '(none)'}`);
  console.log(`${indent}institutions  : ${r.institutions.join(', ') || '(none)'}`);
  console.log(`${indent}accounts      : ${r.account_count}  (earliest_created=${r.earliest_created})`);
  console.log(`${indent}webhook       : ${webhookCell}`);
  if (r.itemget_error) console.log(`${indent}itemGet error : ${r.itemget_error}`);
  if (r.error_code) console.log(`${indent}item.error    : ${r.error_code} — ${r.error_message ?? ''}`);
  if (r.available_products) console.log(`${indent}available     : ${r.available_products.join(', ')}`);
  if (r.billed_products) console.log(`${indent}billed        : ${r.billed_products.join(', ')}`);
  if (r.update_type) console.log(`${indent}update_type   : ${r.update_type}`);
  if (r.consent_expiration_time) console.log(`${indent}consent_exp   : ${r.consent_expiration_time}`);
}

async function main() {
  // CLI: positional name pattern (default '909'); flag --all triggers a global
  // item scan. "--all" alone (no name) means: skip the org section entirely.
  const args = process.argv.slice(2);
  const scanAll = args.includes('--all');
  const positional = args.filter((a) => !a.startsWith('--'));
  const orgNameArg = positional[0];
  const skipOrg = !orgNameArg && scanAll;
  const namePattern = orgNameArg ?? '909';
  const likePattern = `%${namePattern}%`;

  console.log(`PLAID_ENV=${plaidEnvName}  scanAll=${scanAll}  skipOrg=${skipOrg}\n`);

  let orgPlaidItemIds = new Set<string>();
  let orgId: string | null = null;

  if (!skipOrg) {
    // 1. Resolve org by name.
    const orgs = await sql<{ id: string; name: string; created_at: string }[]>`
      SELECT id, name, created_at::text AS created_at
      FROM organizations
      WHERE name ILIKE ${likePattern}
      ORDER BY created_at DESC
      LIMIT 5
    `;
    console.log('=== ORG MATCHES ===');
    if (orgs.length === 0) {
      console.log(`  (no organizations matching ILIKE ${likePattern})`);
      if (!scanAll) {
        await sql.end();
        return;
      }
    } else {
      for (const o of orgs) console.log(`  ${o.id}  ${o.name}  (created ${o.created_at})`);
      const org = orgs[0];
      orgId = org.id;
      console.log(`\nUsing org: ${org.id}  ${org.name}\n`);
    }
  }

  if (orgId !== null) {
    await runOrgDiagnostic(orgId, orgPlaidItemIds);
  }

  if (scanAll) {
    await runGlobalItemScan(orgPlaidItemIds);
  }

  await sql.end();
}

async function runOrgDiagnostic(org_id: string, collectedItemIds: Set<string>) {
  const org = { id: org_id };

  // 2. Total transactions for the org.
  const [{ total }] = await sql<{ total: number }[]>`
    SELECT COUNT(*)::int AS total
    FROM transactions
    WHERE organization_id = ${org.id}
  `;
  console.log('=== TRANSACTIONS TABLE (this org) ===');
  console.log(`  total rows: ${total}`);

  // 3. Categorized vs uncategorized + contact_id breakdown.
  const [breakdown] = await sql<
    {
      categorized: number;
      uncategorized: number;
      with_contact: number;
      no_contact: number;
      reviewed_true: number;
      reviewed_false: number;
    }[]
  >`
    SELECT
      COUNT(*) FILTER (WHERE category_account_id IS NOT NULL)::int AS categorized,
      COUNT(*) FILTER (WHERE category_account_id IS NULL)::int     AS uncategorized,
      COUNT(*) FILTER (WHERE contact_id IS NOT NULL)::int          AS with_contact,
      COUNT(*) FILTER (WHERE contact_id IS NULL)::int              AS no_contact,
      COUNT(*) FILTER (WHERE reviewed = TRUE)::int                 AS reviewed_true,
      COUNT(*) FILTER (WHERE reviewed = FALSE OR reviewed IS NULL)::int AS reviewed_false
    FROM transactions
    WHERE organization_id = ${org.id}
  `;
  console.log(`  categorized:   ${breakdown.categorized}`);
  console.log(`  uncategorized: ${breakdown.uncategorized}`);
  console.log(`  with contact:  ${breakdown.with_contact}`);
  console.log(`  no contact:    ${breakdown.no_contact}`);
  console.log(`  reviewed=t:    ${breakdown.reviewed_true}`);
  console.log(`  reviewed=f:    ${breakdown.reviewed_false}`);

  // 4. Source breakdown via imports.method (and reference prefix).
  const sourceRows = await sql<{ source: string; n: number }[]>`
    SELECT
      COALESCE(
        i.method,
        CASE
          WHEN t.reference LIKE 'plaid:%' THEN '(no import row, plaid: ref)'
          WHEN t.import_id IS NULL        THEN '(no import_id)'
          ELSE                                 '(import_id but no row)'
        END
      ) AS source,
      COUNT(*)::int AS n
    FROM transactions t
    LEFT JOIN imports i ON i.id = t.import_id
    WHERE t.organization_id = ${org.id}
    GROUP BY 1
    ORDER BY n DESC
  `;
  console.log('\n=== TRANSACTIONS by source (imports.method) ===');
  if (sourceRows.length === 0) console.log('  (none)');
  else for (const r of sourceRows) console.log(`  ${r.source.padEnd(35)} ${r.n}`);

  // 5. Most recent N transactions.
  const recent = await sql<
    {
      id: string;
      date: string;
      description: string | null;
      amount: number | null;
      contact_id: string | null;
      category_account_id: string | null;
      reference: string | null;
      plaid_transaction_id: string | null;
      source: string | null;
      reviewed: boolean | null;
      created_at: string | null;
    }[]
  >`
    SELECT
      t.id,
      t.date::text                                                            AS date,
      t.description,
      t.amount,
      t.contact_id,
      t.category_account_id,
      t.reference,
      CASE WHEN t.reference LIKE 'plaid:%'
           THEN substring(t.reference FROM 7)
           ELSE NULL
      END                                                                     AS plaid_transaction_id,
      i.method                                                                AS source,
      t.reviewed,
      t.created_at::text                                                      AS created_at
    FROM transactions t
    LEFT JOIN imports i ON i.id = t.import_id
    WHERE t.organization_id = ${org.id}
    ORDER BY t.date DESC NULLS LAST, t.created_at DESC NULLS LAST
    LIMIT ${RECENT_LIMIT}
  `;
  console.log(`\n=== MOST RECENT ${RECENT_LIMIT} TRANSACTIONS ===`);
  if (recent.length === 0) {
    console.log('  (none)');
  } else {
    for (const r of recent) {
      const desc = (r.description ?? '').padEnd(40).slice(0, 40);
      const amt = r.amount === null ? '   n/a' : r.amount.toFixed(2).padStart(10);
      const cat = r.category_account_id ? 'cat:Y' : 'cat:N';
      const con = r.contact_id ? 'con:Y' : 'con:N';
      const ptid = r.plaid_transaction_id
        ? r.plaid_transaction_id.slice(0, 16) + '…'
        : '(non-plaid)';
      const src = (r.source ?? '?').padEnd(8).slice(0, 8);
      console.log(
        `  ${r.date}  ${amt}  ${cat}  ${con}  ${src}  ${desc}  ${ptid}`,
      );
    }
  }

  // 6. Plaid accounts (connections) for this org.
  const accounts = await sql<
    {
      id: string;
      institution_name: string;
      account_name: string;
      last4: string | null;
      account_type: string;
      subtype: string | null;
      connection_status: string;
      sync_status: string;
      sync_in_progress: boolean;
      has_user_synced_once: boolean;
      plaid_item_id: string;
      plaid_cursor: string | null;
      last_synced_at: string | null;
      last_sync_started_at: string | null;
      last_sync_error_at: string | null;
      last_sync_error: string | null;
      sync_error_message: string | null;
      created_at: string;
      updated_at: string;
    }[]
  >`
    SELECT
      id,
      institution_name,
      account_name,
      last4,
      account_type,
      subtype,
      connection_status,
      sync_status,
      sync_in_progress,
      has_user_synced_once,
      plaid_item_id,
      plaid_cursor,
      last_synced_at::text       AS last_synced_at,
      last_sync_started_at::text AS last_sync_started_at,
      last_sync_error_at::text   AS last_sync_error_at,
      last_sync_error,
      sync_error_message,
      created_at::text           AS created_at,
      updated_at::text           AS updated_at
    FROM plaid_accounts
    WHERE linked_organization_id = ${org.id}
    ORDER BY created_at DESC
  `;
  console.log(`\n=== PLAID ACCOUNTS (linked to org) — ${accounts.length} ===`);
  if (accounts.length === 0) {
    console.log('  (no plaid_accounts.linked_organization_id rows for this org)');
  } else {
    for (const a of accounts) {
      console.log(
        `  ${a.institution_name} / ${a.account_name}${a.last4 ? ` ••${a.last4}` : ''} ` +
          `(${a.account_type}${a.subtype ? `/${a.subtype}` : ''})`,
      );
      console.log(`    plaid_account_id     : ${a.id}`);
      console.log(`    plaid_item_id        : ${a.plaid_item_id}`);
      console.log(`    connection_status    : ${a.connection_status}`);
      console.log(
        `    sync_status          : ${a.sync_status}  (in_progress=${a.sync_in_progress}, has_synced_once=${a.has_user_synced_once})`,
      );
      console.log(`    plaid_cursor         : ${a.plaid_cursor ? a.plaid_cursor.slice(0, 24) + '…' : '(null — never advanced)'}`);
      console.log(`    last_synced_at       : ${a.last_synced_at ?? '(never)'}`);
      console.log(`    last_sync_started_at : ${a.last_sync_started_at ?? '(never)'}`);
      console.log(`    last_sync_error_at   : ${a.last_sync_error_at ?? '(none)'}`);
      console.log(`    last_sync_error      : ${a.last_sync_error ?? '(none)'}`);
      console.log(`    sync_error_message   : ${a.sync_error_message ?? '(none)'}`);
      console.log(`    created_at / updated : ${a.created_at} / ${a.updated_at}`);
    }
  }

  const accountIds = accounts.map((a) => a.id);

  // 7. Recent plaid_sync_batches for these accounts (did the webhook drive any pulls?).
  if (accountIds.length > 0) {
    const batches = await sql<
      {
        id: string;
        plaid_account_id: string;
        cursor: string | null;
        added_count: number;
        modified_count: number;
        removed_count: number;
        created_at: string;
      }[]
    >`
      SELECT id, plaid_account_id, cursor, added_count, modified_count, removed_count, created_at::text AS created_at
      FROM plaid_sync_batches
      WHERE plaid_account_id IN ${sql(accountIds)}
      ORDER BY created_at DESC
      LIMIT 10
    `;
    console.log(`\n=== RECENT plaid_sync_batches (last 10 across these accounts) ===`);
    if (batches.length === 0) {
      console.log('  (none — no sync has ever pulled for these accounts)');
    } else {
      for (const b of batches) {
        console.log(
          `  ${b.created_at}  acct=${b.plaid_account_id.slice(0, 8)}…  added=${b.added_count} modified=${b.modified_count} removed=${b.removed_count}  cursor=${b.cursor ? b.cursor.slice(0, 16) + '…' : '(null)'}`,
        );
      }
    }
  }

  // 8. plaid_raw_transactions counts (= what the Plaid Feed UI would render).
  let rawTotal = 0;
  if (accountIds.length > 0) {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM plaid_raw_transactions
      WHERE plaid_account_id IN ${sql(accountIds)}
    `;
    rawTotal = n;
  }
  console.log(`\n=== PLAID FEED VIEW (plaid_raw_transactions for org's accounts) ===`);
  console.log(`  raw transactions in feed: ${rawTotal}`);

  // 9. DB transactions that look plaid-sourced (reference like 'plaid:%').
  const [{ plaid_ref }] = await sql<{ plaid_ref: number }[]>`
    SELECT COUNT(*)::int AS plaid_ref
    FROM transactions
    WHERE organization_id = ${org.id} AND reference LIKE 'plaid:%'
  `;
  console.log(`  DB transactions w/ reference LIKE 'plaid:%': ${plaid_ref}`);

  // 10. Cross-check: orphans in either direction.
  if (accountIds.length > 0) {
    // (a) Raw txns NOT promoted (no transactions row with matching reference).
    const [{ unpromoted }] = await sql<{ unpromoted: number }[]>`
      SELECT COUNT(*)::int AS unpromoted
      FROM plaid_raw_transactions r
      WHERE r.plaid_account_id IN ${sql(accountIds)}
        AND NOT EXISTS (
          SELECT 1 FROM transactions t
          WHERE t.organization_id = ${org.id}
            AND t.reference = 'plaid:' || r.plaid_transaction_id
        )
    `;
    // (b) DB transactions w/ plaid: reference but no raw row in this org's accounts (the
    //     "in DB but missing from feed" case the user is asking about).
    const [{ orphan_db }] = await sql<{ orphan_db: number }[]>`
      SELECT COUNT(*)::int AS orphan_db
      FROM transactions t
      WHERE t.organization_id = ${org.id}
        AND t.reference LIKE 'plaid:%'
        AND NOT EXISTS (
          SELECT 1 FROM plaid_raw_transactions r
          WHERE r.plaid_account_id IN ${sql(accountIds)}
            AND ('plaid:' || r.plaid_transaction_id) = t.reference
        )
    `;
    console.log(`  raw NOT promoted (in feed, no transactions row): ${unpromoted}`);
    console.log(`  DB plaid txns NOT in raw feed (the discrepancy): ${orphan_db}`);

    if (orphan_db > 0) {
      const orphans = await sql<
        {
          id: string;
          date: string;
          description: string | null;
          amount: number | null;
          reference: string | null;
          contact_id: string | null;
          category_account_id: string | null;
        }[]
      >`
        SELECT t.id, t.date::text AS date, t.description, t.amount, t.reference, t.contact_id, t.category_account_id
        FROM transactions t
        WHERE t.organization_id = ${org.id}
          AND t.reference LIKE 'plaid:%'
          AND NOT EXISTS (
            SELECT 1 FROM plaid_raw_transactions r
            WHERE r.plaid_account_id IN ${sql(accountIds)}
              AND ('plaid:' || r.plaid_transaction_id) = t.reference
          )
        ORDER BY t.date DESC
        LIMIT 20
      `;
      console.log(`\n  Sample orphan DB plaid txns (up to 20):`);
      for (const r of orphans) {
        const desc = (r.description ?? '').padEnd(40).slice(0, 40);
        const amt = r.amount === null ? '   n/a' : r.amount.toFixed(2).padStart(10);
        console.log(`    ${r.date}  ${amt}  ${desc}  ref=${r.reference}`);
      }
    }
  } else {
    console.log('  (skipping orphan check — no plaid accounts linked to org)');
  }

  // 11. Sanity: any plaid_accounts whose linked_organization_id matches but where
  //     the user-side connection looks healthy yet zero raw txns exist?
  if (accountIds.length > 0) {
    const perAcct = await sql<
      {
        id: string;
        institution_name: string;
        account_name: string;
        raw_count: number;
      }[]
    >`
      SELECT pa.id, pa.institution_name, pa.account_name, COUNT(prt.id)::int AS raw_count
      FROM plaid_accounts pa
      LEFT JOIN plaid_raw_transactions prt ON prt.plaid_account_id = pa.id
      WHERE pa.linked_organization_id = ${org.id}
      GROUP BY pa.id, pa.institution_name, pa.account_name
      ORDER BY raw_count DESC
    `;
    console.log(`\n=== Per-account raw transaction counts ===`);
    for (const a of perAcct) {
      console.log(
        `  ${a.institution_name} / ${a.account_name}: ${a.raw_count} raw txn(s)  [${a.id.slice(0, 8)}…]`,
      );
    }
  }

  // 12. Per-Item Plaid state via plaid.itemGet — the source of truth for
  //     "did this Item get a webhook attached at link time".
  if (accounts.length > 0) {
    console.log(`\n=== PER-ITEM PLAID STATE (plaid.itemGet) ===`);
    const itemIdToSampleToken = new Map<string, string>();
    const itemIdToInstitutions = new Map<string, Set<string>>();
    const itemIdToAccountCount = new Map<string, number>();
    const itemIdToEarliest = new Map<string, string>();

    // We need access tokens — fetch one per item_id in scope.
    const tokenRows = await sql<
      { plaid_item_id: string; plaid_access_token: string }[]
    >`
      SELECT DISTINCT ON (plaid_item_id) plaid_item_id, plaid_access_token
      FROM plaid_accounts
      WHERE linked_organization_id = ${org.id}
      ORDER BY plaid_item_id, created_at ASC
    `;
    for (const t of tokenRows) itemIdToSampleToken.set(t.plaid_item_id, t.plaid_access_token);

    for (const a of accounts) {
      collectedItemIds.add(a.plaid_item_id);
      const insts = itemIdToInstitutions.get(a.plaid_item_id) ?? new Set<string>();
      insts.add(a.institution_name);
      itemIdToInstitutions.set(a.plaid_item_id, insts);
      itemIdToAccountCount.set(a.plaid_item_id, (itemIdToAccountCount.get(a.plaid_item_id) ?? 0) + 1);
      const prev = itemIdToEarliest.get(a.plaid_item_id);
      if (!prev || a.created_at < prev) itemIdToEarliest.set(a.plaid_item_id, a.created_at);
    }

    for (const [itemId, sampleToken] of itemIdToSampleToken) {
      const report = await inspectItem(itemId, {
        orgNames: [],
        institutions: Array.from(itemIdToInstitutions.get(itemId) ?? []),
        accountCount: itemIdToAccountCount.get(itemId) ?? 0,
        earliestCreated: itemIdToEarliest.get(itemId) ?? '',
        sampleAccessToken: sampleToken,
      });
      printItemReport(report);
      console.log('');
    }
  }
}

async function runGlobalItemScan(alreadyScanned: Set<string>) {
  console.log(`\n=== GLOBAL ITEM SCAN — every distinct plaid_item_id in DB ===`);
  // One token per item_id, plus light metadata for grouping.
  const tokenRows = await sql<
    {
      plaid_item_id: string;
      plaid_access_token: string;
      account_count: number;
      institutions: string[];
      org_ids: (string | null)[];
      earliest_created: string;
    }[]
  >`
    SELECT
      pa.plaid_item_id,
      (array_agg(pa.plaid_access_token ORDER BY pa.created_at ASC))[1] AS plaid_access_token,
      COUNT(*)::int                                                     AS account_count,
      array_agg(DISTINCT pa.institution_name)                           AS institutions,
      array_agg(DISTINCT pa.linked_organization_id)                     AS org_ids,
      MIN(pa.created_at)::text                                          AS earliest_created
    FROM plaid_accounts pa
    GROUP BY pa.plaid_item_id
    ORDER BY MIN(pa.created_at) DESC
  `;
  console.log(`  ${tokenRows.length} distinct items in plaid_accounts\n`);

  // Resolve org names in one shot.
  const allOrgIds = Array.from(
    new Set(tokenRows.flatMap((r) => r.org_ids).filter((x): x is string => Boolean(x))),
  );
  const orgNameMap = new Map<string, string>();
  if (allOrgIds.length > 0) {
    const orgRows = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM organizations WHERE id IN ${sql(allOrgIds)}
    `;
    for (const o of orgRows) orgNameMap.set(o.id, o.name);
  }

  let withWebhook = 0;
  let withoutWebhook = 0;
  let errored = 0;

  for (const r of tokenRows) {
    const orgNames = r.org_ids
      .filter((x): x is string => Boolean(x))
      .map((id) => orgNameMap.get(id) ?? `(unknown:${id.slice(0, 8)})`);
    const report = await inspectItem(r.plaid_item_id, {
      orgNames,
      institutions: r.institutions,
      accountCount: r.account_count,
      earliestCreated: r.earliest_created,
      sampleAccessToken: r.plaid_access_token,
    });
    printItemReport(report);
    console.log('');
    if (report.webhook === '(error)') errored++;
    else if (!report.webhook) withoutWebhook++;
    else withWebhook++;
  }

  console.log(`=== GLOBAL ITEM SCAN SUMMARY ===`);
  console.log(`  items scanned        : ${tokenRows.length}`);
  console.log(`  with webhook         : ${withWebhook}`);
  console.log(`  without webhook      : ${withoutWebhook}`);
  console.log(`  itemGet errored      : ${errored}`);
  if (alreadyScanned.size > 0) {
    console.log(`  (${alreadyScanned.size} of these were also in the org-scoped section)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
