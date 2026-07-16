import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { isAxiosError } from 'axios';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { plaidAccounts } from '@/db/schema/schema';
import { plaid } from '@/lib/plaid/client';
import { encryptToken } from '@/lib/plaid/encryption';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { requireSession } from '@/lib/auth/session';
import { safeSend } from '@/lib/inngest';
import { logger } from '@/lib/logger';
import { autoCreateBankCoa } from '@/lib/accounting/auto-create-bank-coa';
import { assertDemoQuota, DemoQuotaExceededError } from '@/lib/billing/demo-limits';
import { canAddBankConnection } from '@/lib/accounting/entitlements';

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

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  if (isDemoOrg(orgId)) {
    return NextResponse.json(
      { error: "Bank connections aren't available in the demo workspace. Create your own workspace first." },
      { status: 403 },
    );
  }

  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    return NextResponse.json(
      { error: 'Plaid not configured: PLAID_CLIENT_ID + PLAID_SECRET required' },
      { status: 503 },
    );
  }

  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  // Demo trial cap: reject the whole batch BEFORE exchanging the public
  // token. Public tokens are one-time and burn on use, so checking after
  // the exchange would force the user back through the Plaid OAuth dance
  // just to see the quota error. One Plaid Link session = one institution,
  // regardless of how many accounts the user selected inside it.
  try {
    await assertDemoQuota(orgId, 'plaidInstitutions', 1);
  } catch (err) {
    if (err instanceof DemoQuotaExceededError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
    }
    throw err;
  }

  // Accounting-tier cap: Starter includes 1 bank connection; Plus/Pro and
  // grandfathered ($89) clients are unlimited. One Plaid Link session = one
  // institution, so check before exchanging (public tokens are one-time).
  const bankCap = await canAddBankConnection(orgId);
  if (!bankCap.allowed) {
    return NextResponse.json(
      {
        error: `Your plan includes ${bankCap.limit} bank connection${bankCap.limit === 1 ? '' : 's'}. Upgrade to Plus to connect more.`,
        code: 'accounting_tier_bank_limit',
      },
      { status: 403 },
    );
  }

  // Public tokens are one-time and expire in ~30min. If exchange fails the
  // user has to redo the entire bank OAuth, so surface a real error code so
  // the client can decide whether to retry vs reopen Plaid Link.
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
    logger.error(
      { err: err instanceof Error ? err.message : String(err), plaidError },
      'plaid itemPublicTokenExchange failed',
    );
    return NextResponse.json(
      {
        error:
          plaidError?.display_message ??
          plaidError?.error_message ??
          'Could not link this bank account. Please reopen the Plaid Link dialog and try again.',
        code: plaidError?.error_code ?? null,
      },
      { status: 502 },
    );
  }
  const encrypted = encryptToken(accessToken);

  // Seed balances at link so the UI/opening balance have a number immediately.
  // Uses the FREE /accounts/get (cached balances) — not the metered
  // /accounts/balance/get; the INITIAL sync that fires right after refreshes
  // balance off the /transactions/sync response. Best-effort.
  const balanceByPlaidId = new Map<string, number>();
  try {
    const bal = await plaid.accountsGet({ access_token: accessToken });
    for (const a of bal.data.accounts) {
      balanceByPlaidId.set(a.account_id, Number(a.balances.current ?? a.balances.available ?? 0));
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'business plaid accountsGet failed (non-fatal)');
  }

  const linkedIds: string[] = [];
  const coaCreated: Array<{ plaidAccountId: string; chartOfAccountId: string }> = [];
  const institutionName = parsed.data.institutionName ?? 'Unknown';

  for (const acct of parsed.data.accounts ?? []) {
    const id = randomUUID();
    await db
      .insert(plaidAccounts)
      .values({
        id,
        userId: user.id,
        institutionName,
        accountName: acct.name,
        last4: acct.mask ?? null,
        accountType: acct.type ?? 'depository',
        subtype: acct.subtype ?? null,
        connectionStatus: 'connected',
        linkedOrganizationId: orgId,
        plaidAccessToken: encrypted,
        plaidItemId: itemId,
        plaidAccountId: acct.id,
        balance: balanceByPlaidId.has(acct.id) ? String(balanceByPlaidId.get(acct.id)) : null,
        syncStatus: 'pending',
      })
      .onConflictDoNothing();
    linkedIds.push(id);

    // Auto-create a chart-of-accounts entry for this bank/credit account
    // and link it. Idempotent — if a mapping already exists, this no-ops.
    try {
      const coaId = await autoCreateBankCoa({
        organizationId: orgId,
        plaidAccountId: id,
        institutionName,
        accountName: acct.name,
        last4: acct.mask ?? null,
        subtype: acct.subtype ?? null,
      });
      coaCreated.push({ plaidAccountId: id, chartOfAccountId: coaId });
    } catch (err) {
      // Don't block the link if the COA creation fails — surface in logs and let the user map manually.
      logger.error({ err: err instanceof Error ? err.message : String(err), plaidAccountId: id }, 'auto-create bank COA failed');
    }
  }

  // Fire async sync events via safeSend — the exchange already succeeded and
  // transactions can be synced later if Inngest is unavailable.
  for (const id of linkedIds) {
    await safeSend({ name: 'plaid/sync.requested', data: { accountId: id, trigger: 'INITIAL' } });
  }

  logger.info({ itemId, count: linkedIds.length, coaCreated: coaCreated.length }, 'plaid item linked');
  return NextResponse.json({ ok: true, accountIds: linkedIds, coaCreated });
}
