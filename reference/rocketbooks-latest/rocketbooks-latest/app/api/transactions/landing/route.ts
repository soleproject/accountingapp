import { NextResponse } from 'next/server';
import { loadTransactionsLanding } from '@/app/(app)/transactions/_lib/loadTransactionsLanding';
import { observeDeferredApiPhase } from '@/lib/perf/request-observability';

export const runtime = 'nodejs';

async function handleGet() {
  const rows = await loadTransactionsLanding();
  return NextResponse.json({ rows });
}

export function GET() {
  return observeDeferredApiPhase('transactions.landing', handleGet);
}
