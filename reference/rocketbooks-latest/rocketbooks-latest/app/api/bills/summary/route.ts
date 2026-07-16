import { NextRequest, NextResponse } from 'next/server';
import { loadBillsSummary } from '@/app/(app)/bills/_lib/loadBillsSummary';
import { requireSession } from '@/lib/auth/session';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  await requireSession();
  const sp = req.nextUrl.searchParams;
  const data = await loadBillsSummary({ page: sp.get('page'), filter: sp.get('filter') });
  return NextResponse.json(data);
}
