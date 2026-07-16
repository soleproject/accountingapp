import { NextResponse } from 'next/server';
import { isAxiosError } from 'axios';
import { plaid } from '@/lib/plaid/client';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { CountryCode, Products } from 'plaid';
import { logger } from '@/lib/logger';

export async function POST() {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  if (isDemoOrg(orgId)) {
    return NextResponse.json(
      { error: "Bank connections aren't available in the demo workspace. Create your own workspace from /businesses." },
      { status: 403 },
    );
  }

  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    return NextResponse.json(
      { error: 'Plaid not configured: PLAID_CLIENT_ID + PLAID_SECRET required' },
      { status: 503 },
    );
  }

  const webhook = process.env.PLAID_WEBHOOK_URL?.trim();
  const env = process.env.PLAID_ENV ?? 'sandbox';

  // Plaid binds the webhook to the Item at link time. Silently dropping it
  // when the env var is unset (the prior behavior) produces webhook-less
  // Items in any deploy where PLAID_WEBHOOK_URL was forgotten — and we only
  // notice when transactions stop flowing for a fresh connection. Fail loudly
  // outside sandbox so the misconfig surfaces at link time, not weeks later.
  if (!webhook && env !== 'sandbox') {
    logger.error({ env }, 'PLAID_WEBHOOK_URL is not set — refusing to mint link token without a webhook');
    return NextResponse.json(
      {
        error:
          'Plaid webhook not configured: set PLAID_WEBHOOK_URL in the deploy environment. ' +
          'Without it, new connections will not receive transaction notifications.',
      },
      { status: 503 },
    );
  }

  try {
    const res = await plaid.linkTokenCreate({
      user: { client_user_id: user.id },
      client_name: 'RocketSuite',
      products: [Products.Transactions],
      transactions: { days_requested: 730 },
      country_codes: [CountryCode.Us],
      language: 'en',
      ...(webhook ? { webhook } : {}),
    });
    return NextResponse.json({ linkToken: res.data.link_token, env });
  } catch (err) {
    const plaidError =
      isAxiosError(err) && err.response?.data
        ? (err.response.data as { error_code?: string; error_message?: string; display_message?: string })
        : null;
    logger.error(
      { err: err instanceof Error ? err.message : String(err), plaidError, env, hasWebhook: !!webhook },
      'plaid linkTokenCreate failed',
    );
    return NextResponse.json(
      {
        error: plaidError?.error_message ?? plaidError?.display_message ?? (err instanceof Error ? err.message : 'Plaid error'),
        code: plaidError?.error_code ?? null,
        env,
      },
      { status: 500 },
    );
  }
}
