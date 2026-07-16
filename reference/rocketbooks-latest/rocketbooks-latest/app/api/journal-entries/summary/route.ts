import { NextRequest, NextResponse } from 'next/server';
import { loadJournalEntriesSummary } from '@/app/(app)/journal-entries/_lib/loadJournalEntriesSummary';
import { requireSession } from '@/lib/auth/session';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  await requireSession();
  const sp = req.nextUrl.searchParams;
  const data = await loadJournalEntriesSummary({
    accountId: sp.get('accountId'),
    from: sp.get('from'),
    to: sp.get('to'),
    reversals: sp.get('reversals'),
  });
  return NextResponse.json(data);
}
