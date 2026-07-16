import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { listAccessibleEnterprises } from '@/lib/auth/enterprise';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function resolveEnterpriseId(req: NextRequest): Promise<string | null> {
  const url = new URL(req.url);
  const requested = url.searchParams.get('enterpriseId');
  const accessible = await listAccessibleEnterprises();
  if (requested) {
    return accessible.find((e) => e.id === requested)?.id ?? null;
  }
  return accessible[0]?.id ?? null;
}

export async function POST(req: NextRequest) {
  await requireSession();
  const enterpriseId = await resolveEnterpriseId(req);
  if (!enterpriseId) {
    return NextResponse.json({ error: 'No accessible enterprise' }, { status: 403 });
  }

  let body: { enabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 });
  }
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: '`enabled` must be a boolean' }, { status: 400 });
  }

  await db
    .update(organizations)
    .set({ entityTypeOnboardingEnabled: body.enabled })
    .where(eq(organizations.id, enterpriseId));

  return NextResponse.json({ ok: true, enabled: body.enabled });
}
