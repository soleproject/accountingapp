import { NextResponse } from 'next/server';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 15;

export async function GET() {
  await requireSession();
  const orgId = await getCurrentOrgId();

  try {
    const accounts = await db
      .select({
        id: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
        gaapType: chartOfAccounts.gaapType,
      })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)))
      .orderBy(asc(chartOfAccounts.accountNumber));
    return NextResponse.json({ accounts });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'categorization accounts error';
    logger.error({ err: msg }, 'GET /api/categorization/accounts failed');
    return NextResponse.json({ accounts: [], degraded: true });
  }
}
