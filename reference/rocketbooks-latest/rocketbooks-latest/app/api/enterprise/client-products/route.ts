import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { listAccessibleEnterprises } from '@/lib/auth/enterprise';
import { setEnterpriseAllowedProducts } from '@/lib/enterprise/client-products';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Set which gated (custom-SKU) billing products an enterprise's clients can see
 * on /billing. Accessible to a superadmin (all enterprises) or the enterprise's
 * own staff/owner — listAccessibleEnterprises() enforces that, same as the
 * sibling enterprise settings endpoints.
 */
export async function POST(req: NextRequest) {
  await requireSession();

  let body: { enterpriseId?: unknown; productIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 });
  }

  const enterpriseId = typeof body.enterpriseId === 'string' ? body.enterpriseId : '';
  if (!enterpriseId) {
    return NextResponse.json({ error: 'enterpriseId is required' }, { status: 400 });
  }
  const productIds = Array.isArray(body.productIds)
    ? body.productIds.filter((x): x is string => typeof x === 'string')
    : [];

  const accessible = await listAccessibleEnterprises();
  if (!accessible.some((e) => e.id === enterpriseId)) {
    return NextResponse.json({ error: 'No access to this enterprise' }, { status: 403 });
  }

  await setEnterpriseAllowedProducts(enterpriseId, productIds);
  return NextResponse.json({ ok: true, count: productIds.length });
}
