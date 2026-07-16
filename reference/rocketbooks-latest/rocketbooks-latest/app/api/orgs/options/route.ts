import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId, listAccessibleOrgs } from '@/lib/auth/org';

export const runtime = 'nodejs';

export async function GET() {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const orgs = await listAccessibleOrgs();
  const currentOrg = orgs.find((org) => org.id === orgId) ?? (orgs[0] ? { id: orgs[0].id, name: orgs[0].name, role: orgs[0].role } : null);
  return NextResponse.json({ currentOrg, orgs });
}
