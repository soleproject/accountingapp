/**
 * One-off: for each Plaid account in plaid_accounts, call /transactions/sync
 * with the persisted cursor and report what Plaid would return RIGHT NOW.
 * If added.length > 0 or has_more === true, there's data Plaid has that we
 * haven't pulled yet. Read-only — does not persist anything.
 *
 * Usage:
 *   tsx scripts/check-plaid-sync-lag.ts                 # all items
 *   tsx scripts/check-plaid-sync-lag.ts <plaid_item_id> # one item
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

async function main() {
  const filterItemId = process.argv[2] ?? null;

  const plaidEnvName = (process.env.PLAID_ENV ?? 'sandbox') as keyof typeof PlaidEnvironments;
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

  const accounts = filterItemId
    ? await sql<
        {
          id: string;
          plaid_account_id: string;
          plaid_item_id: string;
          plaid_access_token: string;
          plaid_cursor: string | null;
          institution_name: string;
          account_name: string;
        }[]
      >`
        SELECT id, plaid_account_id, plaid_item_id, plaid_access_token, plaid_cursor, institution_name, account_name
        FROM plaid_accounts WHERE plaid_item_id = ${filterItemId}
        ORDER BY created_at ASC
      `
    : await sql<
        {
          id: string;
          plaid_account_id: string;
          plaid_item_id: string;
          plaid_access_token: string;
          plaid_cursor: string | null;
          institution_name: string;
          account_name: string;
        }[]
      >`
        SELECT id, plaid_account_id, plaid_item_id, plaid_access_token, plaid_cursor, institution_name, account_name
        FROM plaid_accounts ORDER BY plaid_item_id, created_at ASC
      `;

  console.log(`Checking ${accounts.length} account(s) against Plaid /transactions/sync\n`);

  // Group by item to avoid making the same itemGet call per-account-in-item.
  const seenItems = new Set<string>();
  for (const a of accounts) {
    const itemTag = seenItems.has(a.plaid_item_id) ? '' : `[item ${a.plaid_item_id}]\n`;
    seenItems.add(a.plaid_item_id);
    if (itemTag) console.log(itemTag);

    let token: string;
    try {
      token = decryptToken(a.plaid_access_token);
    } catch (err) {
      console.log(`  ${a.institution_name} / ${a.account_name}: decrypt failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    try {
      const res = await plaid.transactionsSync({
        access_token: token,
        cursor: a.plaid_cursor ?? undefined,
        count: 500,
      });
      const data = res.data;
      // Filter added/modified/removed to this account_id (matches the worker's behavior)
      const addedThis = data.added.filter((t) => t.account_id === a.plaid_account_id).length;
      const modifiedThis = data.modified.filter((t) => t.account_id === a.plaid_account_id).length;
      const removedThis = data.removed.filter((t) => t.account_id === a.plaid_account_id).length;
      const verdict =
        addedThis === 0 && modifiedThis === 0 && removedThis === 0 && !data.has_more
          ? '✓ caught up'
          : `⚠ pending: added=${addedThis} modified=${modifiedThis} removed=${removedThis} has_more=${data.has_more}`;
      console.log(
        `  ${a.institution_name} / ${a.account_name} ` +
          `(plaid_account_id=${a.plaid_account_id.slice(0, 12)}…): ${verdict}`,
      );
      // Also report the WHOLE-item totals (across sibling accounts) since
      // /transactions/sync is item-scoped — useful to see if a sibling account
      // has new data.
      console.log(
        `    item-wide response totals: added=${data.added.length} modified=${data.modified.length} removed=${data.removed.length} has_more=${data.has_more}`,
      );
    } catch (err) {
      const plaidErr =
        isAxiosError(err) && err.response?.data
          ? (err.response.data as { error_code?: string; error_message?: string })
          : null;
      console.log(
        `  ${a.institution_name} / ${a.account_name}: transactionsSync failed: ${
          plaidErr ? `${plaidErr.error_code}: ${plaidErr.error_message}` : err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
