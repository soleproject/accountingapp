/**
 * Backfill: re-attach the Plaid webhook URL to every existing Plaid Item.
 *
 * Why this exists:
 *   Commit 5adceab changed the link-token route to silently omit the `webhook`
 *   field when PLAID_WEBHOOK_URL was unset in the running env. Plaid binds the
 *   webhook to the Item at link time, so any Items linked while the env var was
 *   missing on the deploy are now permanently webhook-less — Plaid has nowhere
 *   to send transaction notifications. Setting the env var only fixes *future*
 *   link_token creations; existing Items must be patched via /item/webhook/update.
 *
 *   This script calls plaid.itemWebhookUpdate({ access_token, webhook }) once
 *   per distinct plaid_item_id in plaid_accounts.
 *
 * Safety:
 *   - Default mode is DRY-RUN: no mutations. Pass --apply to actually update.
 *   - Items whose current webhook already matches the target URL are skipped
 *     (uses plaid.itemGet to read current state before updating).
 *   - Pass --item-id <id> to target a single Item — recommended for the first
 *     run on the 909 LLC connection before going broad.
 *
 * Usage:
 *   tsx scripts/backfill-plaid-webhooks.ts                       # dry-run, all
 *   tsx scripts/backfill-plaid-webhooks.ts --item-id <plaid_item_id>
 *   tsx scripts/backfill-plaid-webhooks.ts --apply                # mutate, all
 *   tsx scripts/backfill-plaid-webhooks.ts --item-id <id> --apply # mutate one
 *
 * Required env (from .env.local):
 *   POSTGRES_URL_NON_POOLING, PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV,
 *   PLAID_ENCRYPTION_KEY, PLAID_WEBHOOK_URL
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { isAxiosError } from 'axios';

config({ path: '.env.local' });

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

function plaidErrorOf(err: unknown): string {
  if (isAxiosError(err) && err.response?.data) {
    const d = err.response.data as { error_code?: string; error_message?: string };
    return `${d.error_code ?? 'AXIOS'}: ${d.error_message ?? err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const itemIdIdx = args.indexOf('--item-id');
  const targetItemId = itemIdIdx >= 0 ? args[itemIdIdx + 1] : null;
  if (itemIdIdx >= 0 && !targetItemId) {
    console.error('--item-id requires a value');
    process.exit(2);
  }

  const targetWebhook = process.env.PLAID_WEBHOOK_URL?.trim();
  if (!targetWebhook) {
    console.error('PLAID_WEBHOOK_URL is not set in this environment. Set it in .env.local before running.');
    process.exit(2);
  }
  const plaidEnvName = (process.env.PLAID_ENV ?? 'sandbox') as keyof typeof PlaidEnvironments;

  console.log(`PLAID_ENV          : ${plaidEnvName}`);
  console.log(`Target webhook URL : ${targetWebhook}`);
  console.log(`Mode               : ${apply ? 'APPLY (will mutate)' : 'DRY-RUN (no changes)'}`);
  console.log(`Scope              : ${targetItemId ? `single item ${targetItemId}` : 'all distinct plaid_item_id rows'}`);
  console.log('');

  // Sanity: warn if running APPLY against production from a script that reads
  // .env.local (production env vars usually live in the deploy host, not here).
  // The script will still hit Plaid's production API if that's what the keys
  // resolve to — webhook updates are global per Item, so prod creds + the
  // .env.local webhook URL is fine, but worth a heads-up.
  if (apply && plaidEnvName === 'production') {
    console.log('NOTE: PLAID_ENV=production — this will modify live Plaid Items.\n');
  }

  const sql = postgres(process.env.POSTGRES_URL_NON_POOLING!, { prepare: false, max: 1 });
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

  // One token per item; aggregate display metadata.
  const items = targetItemId
    ? await sql<
        {
          plaid_item_id: string;
          plaid_access_token: string;
          account_count: number;
          institutions: string[];
          org_ids: (string | null)[];
        }[]
      >`
        SELECT
          pa.plaid_item_id,
          (array_agg(pa.plaid_access_token ORDER BY pa.created_at ASC))[1] AS plaid_access_token,
          COUNT(*)::int                                                     AS account_count,
          array_agg(DISTINCT pa.institution_name)                           AS institutions,
          array_agg(DISTINCT pa.linked_organization_id)                     AS org_ids
        FROM plaid_accounts pa
        WHERE pa.plaid_item_id = ${targetItemId}
        GROUP BY pa.plaid_item_id
      `
    : await sql<
        {
          plaid_item_id: string;
          plaid_access_token: string;
          account_count: number;
          institutions: string[];
          org_ids: (string | null)[];
        }[]
      >`
        SELECT
          pa.plaid_item_id,
          (array_agg(pa.plaid_access_token ORDER BY pa.created_at ASC))[1] AS plaid_access_token,
          COUNT(*)::int                                                     AS account_count,
          array_agg(DISTINCT pa.institution_name)                           AS institutions,
          array_agg(DISTINCT pa.linked_organization_id)                     AS org_ids
        FROM plaid_accounts pa
        GROUP BY pa.plaid_item_id
        ORDER BY MIN(pa.created_at) DESC
      `;

  if (items.length === 0) {
    console.log(targetItemId ? `No plaid_accounts row found with plaid_item_id=${targetItemId}` : 'No plaid_accounts rows in DB.');
    await sql.end();
    return;
  }

  // Resolve org names for display.
  const orgIds = Array.from(new Set(items.flatMap((i) => i.org_ids).filter((x): x is string => Boolean(x))));
  const orgNameMap = new Map<string, string>();
  if (orgIds.length > 0) {
    const orgRows = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM organizations WHERE id IN ${sql(orgIds)}
    `;
    for (const o of orgRows) orgNameMap.set(o.id, o.name);
  }

  let alreadyOk = 0;
  let updated = 0;
  let wouldUpdate = 0;
  let failed = 0;

  for (const item of items) {
    const orgNames = item.org_ids
      .filter((x): x is string => Boolean(x))
      .map((id) => orgNameMap.get(id) ?? `(unknown:${id.slice(0, 8)})`);
    const header =
      `${item.plaid_item_id}  [${item.institutions.join(', ')}]  ` +
      `accounts=${item.account_count}  orgs=${orgNames.join(', ') || '(none)'}`;

    let accessToken: string;
    try {
      accessToken = decryptToken(item.plaid_access_token);
    } catch (err) {
      console.log(`✗ ${header}\n    decrypt failed: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
      continue;
    }

    // Read current state so the operator can see before/after and so we can
    // skip no-op updates.
    let currentWebhook: string | null = null;
    try {
      const got = await plaid.itemGet({ access_token: accessToken });
      currentWebhook = got.data.item.webhook ?? null;
    } catch (err) {
      console.log(`✗ ${header}\n    itemGet failed: ${plaidErrorOf(err)}`);
      failed++;
      continue;
    }

    if (currentWebhook === targetWebhook) {
      console.log(`= ${header}\n    already set: ${currentWebhook}`);
      alreadyOk++;
      continue;
    }

    const before = currentWebhook ?? '(none)';
    if (!apply) {
      console.log(`~ ${header}\n    would update: ${before}  →  ${targetWebhook}`);
      wouldUpdate++;
      continue;
    }

    try {
      await plaid.itemWebhookUpdate({ access_token: accessToken, webhook: targetWebhook });
      console.log(`✓ ${header}\n    updated: ${before}  →  ${targetWebhook}`);
      updated++;
    } catch (err) {
      console.log(`✗ ${header}\n    itemWebhookUpdate failed: ${plaidErrorOf(err)}`);
      failed++;
    }
  }

  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`  items processed   : ${items.length}`);
  console.log(`  already correct   : ${alreadyOk}`);
  if (apply) {
    console.log(`  updated           : ${updated}`);
  } else {
    console.log(`  would update      : ${wouldUpdate}  (dry-run; pass --apply to mutate)`);
  }
  console.log(`  failed            : ${failed}`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
