import { NextRequest, NextResponse } from 'next/server';
import { getCurrentOrgId } from '@/lib/auth/org';
import { safeIsoDate, todayIso, yearStartIso } from '@/lib/reports/dates';
import type { CashFlowMode } from '@/lib/reports/cash-flow-data';
import { parseBasis } from '@/lib/reports/basis-filter';
import { hasActiveDemoTrial } from '@/lib/billing/demo-trial';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const orgId = await getCurrentOrgId();
  if (await hasActiveDemoTrial(orgId)) {
    return NextResponse.json({ error: 'PDF export is disabled during the demo trial. Upgrade to enable.' }, { status: 403 });
  }
  const { searchParams } = req.nextUrl;
  const fromDate = safeIsoDate(searchParams.get('from') ?? undefined, yearStartIso());
  const toDate = safeIsoDate(searchParams.get('to') ?? undefined, todayIso());
  const mode: CashFlowMode = searchParams.get('mode') === 'simple' ? 'simple' : 'real';
  const basis = parseBasis(searchParams.get('basis'));

  // Lazy-load @react-pdf and the component (see balance-sheet route for why).
  const [{ renderToBuffer }, { loadCashFlow }, { CashFlowPdf }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('@/lib/reports/cash-flow-data'),
    import('@/lib/reports/cash-flow-pdf'),
  ]);

  const data = await loadCashFlow(orgId, fromDate, toDate, mode, basis);
  const buffer = await renderToBuffer(<CashFlowPdf {...data} />);

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="cash-flow-${mode}-${fromDate}-${toDate}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
