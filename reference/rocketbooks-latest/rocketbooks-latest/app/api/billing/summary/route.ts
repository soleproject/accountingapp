import { NextRequest, NextResponse } from 'next/server';
import { loadBillingSummary } from '@/app/(app)/billing/_lib/loadBillingSummary';
import { observeDeferredApiPhase } from '@/lib/perf/request-observability';

export const runtime = 'nodejs';

async function handleGet(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const data = await loadBillingSummary({ tab: sp.get('tab') });
  return NextResponse.json(data);
}

export function GET(req: NextRequest) {
  return observeDeferredApiPhase('billing.summary', () => handleGet(req));
}
