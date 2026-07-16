import { NextRequest, NextResponse } from 'next/server';
import { isAxiosError } from 'axios';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { plaid } from '@/lib/plaid/client';
import { requireSession } from '@/lib/auth/session';
import { db } from '@/db/client';
import { plaidAccounts } from '@/db/schema/schema';
import { CountryCode } from 'plaid';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 15;

const Body = z.object({
  plaidItemId: z.string().min(1),
});

/**
 * Plaid Link in *update mode*: re-authenticates an existing Item without
 * re-linking from scratch. Requires the existing access_token, which we look
 * up server-side by plaid_item_id scoped to the requesting user. The
 * initial-link route at /api/plaid/link/token stays untouched — update mode
 * has different inputs (no `products`, must include `access_token`) and
 * mixing them would muddy both call sites.
 */
export async function POST(req: NextRequest) {
  const user = await requireSession();

  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    return NextResponse.json(
      { error: 'Plaid not configured: PLAID_CLIENT_ID + PLAID_SECRET required' },
      { status: 503 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body — { plaidItemId } required' }, { status: 400 });
  }
  const { plaidItemId } = parsed.data;

  // Scope the access-token lookup to the requesting user. Multiple plaid_account
  // rows can share one item (one institution login = many accounts); any row
  // for this item under this user gives us the access token we need.
  const [account] = await db
    .select({ accessToken: plaidAccounts.plaidAccessToken })
    .from(plaidAccounts)
    .where(and(eq(plaidAccounts.plaidItemId, plaidItemId), eq(plaidAccounts.userId, user.id)))
    .limit(1);

  if (!account) {
    return NextResponse.json({ error: 'Plaid item not found for this user' }, { status: 404 });
  }

  const webhook = process.env.PLAID_WEBHOOK_URL?.trim();
  const env = process.env.PLAID_ENV ?? 'sandbox';

  // See app/api/plaid/link/token/route.ts for why this is a hard fail outside
  // sandbox: webhook is bound at link time and silent omission produces dead
  // connections. Update mode is even more sensitive — re-auth without a
  // webhook leaves the existing Item permanently webhook-less.
  if (!webhook && env !== 'sandbox') {
    logger.error(
      { env, plaidItemId },
      'PLAID_WEBHOOK_URL is not set — refusing to mint update-mode link token without a webhook',
    );
    return NextResponse.json(
      {
        error:
          'Plaid webhook not configured: set PLAID_WEBHOOK_URL in the deploy environment. ' +
          'Refusing to re-auth without a webhook to avoid leaving this Item silently disconnected.',
      },
      { status: 503 },
    );
  }

  try {
    const res = await plaid.linkTokenCreate({
      user: { client_user_id: user.id },
      client_name: 'RocketSuite',
      country_codes: [CountryCode.Us],
      language: 'en',
      access_token: account.accessToken,
      ...(webhook ? { webhook } : {}),
    });
    return NextResponse.json({ linkToken: res.data.link_token, env });
  } catch (err) {
    const plaidError =
      isAxiosError(err) && err.response?.data
        ? (err.response.data as { error_code?: string; error_message?: string; display_message?: string })
        : null;
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        plaidError,
        env,
        hasWebhook: !!webhook,
        plaidItemId,
      },
      'plaid linkTokenCreate (update mode) failed',
    );
    return NextResponse.json(
      {
        error:
          plaidError?.error_message ??
          plaidError?.display_message ??
          (err instanceof Error ? err.message : 'Plaid error'),
        code: plaidError?.error_code ?? null,
        env,
      },
      { status: 500 },
    );
  }
}
