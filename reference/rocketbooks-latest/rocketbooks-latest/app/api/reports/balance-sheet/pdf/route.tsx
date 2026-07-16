import { NextRequest, NextResponse } from 'next/server';
import { getCurrentOrgId } from '@/lib/auth/org';
import { safeIsoDate, todayIso } from '@/lib/reports/dates';
import { parseBasis } from '@/lib/reports/basis-filter';
import { hasActiveDemoTrial } from '@/lib/billing/demo-trial';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const orgId = await getCurrentOrgId();
  // Demo trial: report view stays available, PDF download does not.
  if (await hasActiveDemoTrial(orgId)) {
    return NextResponse.json({ error: 'PDF export is disabled during the demo trial. Upgrade to enable.' }, { status: 403 });
  }
  const { searchParams } = req.nextUrl;
  const asOfDate = safeIsoDate(searchParams.get('asOf') ?? undefined, todayIso());
  const basis = parseBasis(searchParams.get('basis'));

  // @react-pdf/renderer is heavy — load it and the report component lazily so
  // they stay out of the static route bundle (keeps the Cloudflare worker lean;
  // this route runs on the Node runtime where they load at request time).
  const [{ renderToBuffer }, { loadBalanceSheet }, { BalanceSheetPdf }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('@/lib/reports/balance-sheet-data'),
    import('@/lib/reports/balance-sheet-pdf'),
  ]);

  const data = await loadBalanceSheet(orgId, asOfDate, basis);
  const buffer = await renderToBuffer(<BalanceSheetPdf {...data} />);

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="balance-sheet-${asOfDate}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
