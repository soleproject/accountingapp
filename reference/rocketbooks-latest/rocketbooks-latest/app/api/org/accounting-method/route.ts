import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { parseBasis } from '@/lib/reports/basis-filter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Persist the org's reporting basis (cash / accrual). Called by the
 * BasisToggle whenever the user flips it. Treated as a preference, not a
 * security boundary — any signed-in user with org access can change it.
 */
export async function POST(req: NextRequest) {
  await requireSession();
  const orgId = await getCurrentOrgId();
  let body: { basis?: string };
  try {
    body = (await req.json()) as { basis?: string };
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const basis = parseBasis(body.basis);
  await db
    .update(organizations)
    .set({ accountingMethod: basis })
    .where(eq(organizations.id, orgId));
  return NextResponse.json({ ok: true, basis });
}
