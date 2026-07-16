import { NextRequest, NextResponse } from 'next/server';
import { isAuthorizedCron } from '@/lib/cron';
import { previousMonth } from '@/lib/reconciliation/dates';
import { runFirmArrearsBilling } from '@/lib/stripe/firm-arrears';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

/**
 * Firm-pays arrears billing — runs on the 5th of each month (see vercel.json). Bills
 * every firm for the JUST-CLOSED prior month's covered clients: one consolidated
 * Stripe invoice per firm, each client at its tier's reduced price, charged to the
 * firm's card. Idempotent (firm_arrears_invoices UNIQUE per firm+period). Add
 * ?dryRun=1 to compute the invoices without creating or charging anything.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse('forbidden', { status: 401 });

  const now = new Date();
  const { year, month } = previousMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';

  const results = await runFirmArrearsBilling(year, month, { dryRun });
  const billed = results.filter((r) => r.status === 'billed');
  const totalCents = billed.reduce((s, r) => s + (r.amountCents ?? 0), 0);
  logger.info(
    { year, month, dryRun, firms: results.length, billed: billed.length, totalCents },
    'firm arrears cron complete',
  );
  return NextResponse.json({ ok: true, period: `${year}-${String(month).padStart(2, '0')}`, dryRun, billed: billed.length, totalCents, results });
}
