import { NextRequest, NextResponse } from 'next/server';
import { getCurrentOrgId } from '@/lib/auth/org';
import { hasAnyPermission } from '@/lib/auth/permissions';
import { hasActiveDemoTrial } from '@/lib/billing/demo-trial';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const orgId = await getCurrentOrgId();
  if (!(await hasAnyPermission(['accounting.transactions.accountant_review', 'enterprise.dashboard.view', 'enterprise.clients.view']))) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  }
  if (await hasActiveDemoTrial(orgId)) {
    return NextResponse.json({ error: 'PDF export is disabled during the demo trial. Upgrade to enable.' }, { status: 403 });
  }

  const yp = Number(req.nextUrl.searchParams.get('year'));
  const thisYear = new Date().getFullYear();
  const year = Number.isInteger(yp) && yp >= 2000 && yp <= thisYear + 1 ? yp : thisYear;

  // Lazy-load @react-pdf and the component (see balance-sheet route for why).
  const [{ renderToBuffer }, { loadForm1099Filings }, { Form1099NecPdf }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('@/lib/reports/form-1099-filings'),
    import('@/lib/reports/form-1099-pdf'),
  ]);

  const data = await loadForm1099Filings(orgId, year);
  const buffer = await renderToBuffer(<Form1099NecPdf {...data} />);

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="1099-nec-${year}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
