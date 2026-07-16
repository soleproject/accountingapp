import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { isAxiosError } from 'axios';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { plaidAccounts, personalAccounts } from '@/db/schema/schema';
import { plaid } from '@/lib/plaid/client';
import { encryptToken } from '@/lib/plaid/encryption';
import { requireSession } from '@/lib/auth/session';
import { safeSend } from '@/lib/inngest';
import { logger } from '@/lib/logger';

const Body = z.object({
  publicToken: z.string().min(10),
  institutionId: z.string().optional(),
  institutionName: z.string().optional(),
  accounts: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        mask: z.string().optional(),
        subtype: z.string().optional(),
        type: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * Map Plaid account type/subtype to our personal_accounts.type vocabulary.
 * isLiability() (lib/personal/queries.ts) treats 'credit' and 'loan' as debts.
 */
function personalType(type: string | undefined, subtype: string | undefined): string {
  if (type === 'credit') return 'credit';
  if (type === 'loan') return 'loan';
  if (type === 'investment' || type === 'brokerage') return 'investment';
  if (type === 'depository') return subtype === 'savings' ? 'savings' : 'checking';
  return subtype ?? type ?? 'other';
}

export async function POST(req: NextRequest) {
  const user = await requireSession();

  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    return NextResponse.json({ error: 'Plaid not configured: PLAID_CLIENT_ID + PLAID_SECRET required' }, { status: 503 });
  }

  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  let accessToken: string;
  let itemId: string;
  try {
    const exchange = await plaid.itemPublicTokenExchange({ public_token: parsed.data.publicToken });
    accessToken = exchange.data.access_token;
    itemId = exchange.data.item_id;
  } catch (err) {
    const plaidError =
      isAxiosError(err) && err.response?.data
        ? (err.response.data as { error_code?: string; error_message?: string; display_message?: string })
        : null;
    logger.error({ err: err instanceof Error ? err.message : String(err), plaidError }, 'personal plaid exchange failed');
    return NextResponse.json(
      {
        error:
          plaidError?.display_message ??
          plaidError?.error_message ??
          'Could not link this account. Please reopen the Plaid Link dialog and try again.',
        code: plaidError?.error_code ?? null,
      },
      { status: 502 },
    );
  }
  const encrypted = encryptToken(accessToken);

  // Seed balances so net worth is meaningful immediately. Uses the FREE
  // /accounts/get (cached balances), not the metered /accounts/balance/get;
  // the INITIAL sync that fires right after refreshes balance off the
  // /transactions/sync response. Best-effort — a failure links at 0 and the
  // next sync corrects it.
  const balanceByPlaidId = new Map<string, number>();
  try {
    const bal = await plaid.accountsGet({ access_token: accessToken });
    for (const a of bal.data.accounts) {
      const v = a.balances.current ?? a.balances.available ?? 0;
      balanceByPlaidId.set(a.account_id, Number(v));
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'personal plaid accountsGet failed (non-fatal)');
  }

  const institutionName = parsed.data.institutionName ?? 'Unknown';
  const linkedIds: string[] = [];

  for (const acct of parsed.data.accounts ?? []) {
    const balance = balanceByPlaidId.get(acct.id) ?? 0;

    // Create the user-facing personal account first so we can point the Plaid
    // row at it via linked_personal_id.
    const personalId = randomUUID();
    await db
      .insert(personalAccounts)
      .values({
        id: personalId,
        userId: user.id,
        name: acct.name,
        type: personalType(acct.type, acct.subtype),
        balance: String(balance),
        institution: institutionName,
        plaidAccountId: acct.id,
      })
      .onConflictDoNothing();

    const plaidRowId = randomUUID();
    await db
      .insert(plaidAccounts)
      .values({
        id: plaidRowId,
        userId: user.id,
        institutionName,
        accountName: acct.name,
        last4: acct.mask ?? null,
        accountType: acct.type ?? 'depository',
        subtype: acct.subtype ?? null,
        balance: String(balance),
        connectionStatus: 'connected',
        // Personal accounts carry NO org link — that keeps them out of the
        // business books (plaid-promote-on-sync skips no-org accounts).
        linkedPersonalId: personalId,
        plaidAccessToken: encrypted,
        plaidItemId: itemId,
        plaidAccountId: acct.id,
        syncStatus: 'pending',
      })
      .onConflictDoNothing();
    linkedIds.push(plaidRowId);
  }

  // Kick off the initial transaction sync for each linked account. The
  // personal promote job (plaid-promote-personal-on-sync) fires on completion.
  for (const id of linkedIds) {
    await safeSend({ name: 'plaid/sync.requested', data: { accountId: id, trigger: 'INITIAL' } });
  }

  logger.info({ itemId, count: linkedIds.length, userId: user.id }, 'personal plaid item linked');
  return NextResponse.json({ ok: true, accountIds: linkedIds });
}
