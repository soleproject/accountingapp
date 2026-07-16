import { NextRequest, NextResponse } from 'next/server';
import { getCurrentOrgId } from '@/lib/auth/org';
import { safeIsoDate, todayIso, yearStartIso } from '@/lib/reports/dates';
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
  const accountId = searchParams.get('accountId')?.trim() || null;
  const basis = parseBasis(searchParams.get('basis'));

  // Lazy-load @react-pdf and the component (see balance-sheet route for why).
  const [{ renderToBuffer }, { loadGeneralLedger }, { GeneralLedgerPdf }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('@/lib/reports/general-ledger-data'),
    import('@/lib/reports/general-ledger-pdf'),
  ]);

  const data = await loadGeneralLedger(orgId, fromDate, toDate, accountId, basis);
  const buffer = await renderToBuffer(<GeneralLedgerPdf {...data} />);

  const filenameSuffix = accountId ? `-account-${accountId.slice(0, 8)}` : '';
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="general-ledger-${fromDate}-${toDate}${filenameSuffix}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
