import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { loadDashboardSummary } from '@/app/(app)/dashboard/_lib/loadDashboardSummary';
import { observeDeferredApiPhase } from '@/lib/perf/request-observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handleGet() {
  await requireSession();
  const summary = await loadDashboardSummary();
  return NextResponse.json(summary);
}

export function GET() {
  return observeDeferredApiPhase('dashboard.summary', handleGet);
}
