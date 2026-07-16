import { NextRequest, NextResponse } from 'next/server';
import { loadContactsSummary } from '@/app/(app)/contacts/_lib/loadContactsSummary';
import { requirePermission } from '@/lib/auth/permissions';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  await requirePermission('accounting.contacts.view');
  const sp = req.nextUrl.searchParams;
  const data = await loadContactsSummary({ page: sp.get('page'), q: sp.get('q'), status: sp.get('status') });
  return NextResponse.json(data);
}
