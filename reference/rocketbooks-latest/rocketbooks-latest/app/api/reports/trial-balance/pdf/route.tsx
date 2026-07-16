import { NextRequest, NextResponse } from 'next/server';
import { getCurrentOrgId } from '@/lib/auth/org';
import { safeIsoDate, todayIso } from '@/lib/reports/dates';
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
  const asOfDate = safeIsoDate(searchParams.get('asOf') ?? undefined, todayIso());
  const basis = parseBasis(searchParams.get('basis'));

  // Lazy-load @react-pdf and the component (see balance-sheet route for why).
  const [{ renderToBuffer }, { loadTrialBalance }, { TrialBalancePdf }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('@/lib/reports/trial-balance-data'),
    import('@/lib/reports/trial-balance-pdf'),
  ]);

  const data = await loadTrialBalance(orgId, asOfDate, basis);
  const buffer = await renderToBuffer(<TrialBalancePdf {...data} />);

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="trial-balance-${asOfDate}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
