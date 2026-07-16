import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { plaidAccounts } from '@/db/schema/schema';
import { verifyPlaidWebhook } from '@/lib/plaid/webhook-verify';
import { safeSend } from '@/lib/inngest';
import { logger } from '@/lib/logger';

interface PlaidWebhookPayload {
  webhook_type: string;
  webhook_code: string;
  item_id: string;
  error?: { error_code: string; error_message: string };
  new_transactions?: number;
  removed_transactions?: string[];
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const jwt = req.headers.get('plaid-verification') ?? '';

  // Verify in every reachable environment. Skip only when explicitly opted out
  // for local sandbox testing via PLAID_WEBHOOK_VERIFY=skip — never based on
  // PLAID_ENV alone (an env-file copy-paste shouldn't expose the endpoint).
  const skipVerify =
    process.env.PLAID_WEBHOOK_VERIFY === 'skip' && process.env.NODE_ENV !== 'production';
  if (!skipVerify) {
    if (!jwt) return new NextResponse('missing signature', { status: 401 });
    const ok = await verifyPlaidWebhook(raw, jwt);
    if (!ok) return new NextResponse('bad signature', { status: 401 });
  }

  let evt: PlaidWebhookPayload;
  try {
    evt = JSON.parse(raw);
  } catch {
    return new NextResponse('bad body', { status: 400 });
  }

  logger.info({ webhook: evt.webhook_type, code: evt.webhook_code, item: evt.item_id }, 'plaid webhook received');

  if (evt.webhook_type === 'TRANSACTIONS') {
    // /transactions/sync is item-scoped (one cursor returns the whole item's
    // transactions across all accounts), but our sync worker filters each
    // response to its own plaid_account_id to avoid cross-account fanout
    // duplicates. So we MUST fan out the webhook to every account on the
    // item — otherwise transactions for sibling accounts get fetched by the
    // calling account and silently filtered away. Previously this loop only
    // dispatched to the first account, which broke multi-account items
    // (e.g. a Plaid Item with 3 BoA accounts where 2 of them never picked up
    // their transactions).
    const accts = await db
      .select({ id: plaidAccounts.id })
      .from(plaidAccounts)
      .where(eq(plaidAccounts.plaidItemId, evt.item_id));
    if (accts.length === 0) {
      logger.warn({ itemId: evt.item_id }, 'plaid webhook for unknown item');
      return NextResponse.json({ ok: true });
    }
    for (const acct of accts) {
      await safeSend({
        name: 'plaid/sync.requested',
        data: { accountId: acct.id, trigger: evt.webhook_code },
      });
    }
  }

  return NextResponse.json({ ok: true });
}
