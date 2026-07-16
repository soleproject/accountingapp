import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getOrgFeatures } from '@/lib/accounting/get-org-feature';

export const runtime = 'nodejs';

export async function GET() {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const features = await getOrgFeatures(orgId, ['beneficial_trust', 'business_trust']);
  return NextResponse.json({ features });
}
