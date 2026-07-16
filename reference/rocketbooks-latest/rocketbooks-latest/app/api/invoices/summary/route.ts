import { NextRequest, NextResponse } from 'next/server';
import { loadInvoicesSummary } from '@/app/(app)/invoices/_lib/loadInvoicesSummary';
import { requireSession } from '@/lib/auth/session';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  await requireSession();
  const sp = req.nextUrl.searchParams;
  const data = await loadInvoicesSummary({ page: sp.get('page'), filter: sp.get('filter') });
  return NextResponse.json(data);
}
