import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/permissions';
import { getCurrentOrgId } from '@/lib/auth/org';
import { loadAllDimensionOptions } from '@/lib/tags/dimensions';
import { timeDb } from '@/lib/perf/db-timing';

export const runtime = 'nodejs';

export async function GET() {
  await requirePermission('accounting.transactions.view');
  const orgId = await getCurrentOrgId();
  const dimensions = (await timeDb(
    'transactions.bulkTagDimensions.lazy',
    () => loadAllDimensionOptions(orgId),
    { route: '/api/transactions/tag-dimensions' },
  )).map(({ dimension, options }) => ({
    entityType: dimension.entityType,
    shortLabel: dimension.shortLabel,
    emoji: dimension.emoji,
    options,
  }));

  return NextResponse.json({ dimensions });
}
