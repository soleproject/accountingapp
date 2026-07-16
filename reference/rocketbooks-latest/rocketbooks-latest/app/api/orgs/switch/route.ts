import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { setActiveOrg, OrgAccessDeniedError } from '@/lib/auth/org';
import { logger } from '@/lib/logger';

const Body = z.object({ orgId: z.string().min(1) });

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  try {
    await setActiveOrg(parsed.data.orgId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof OrgAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    logger.error({ err }, 'org switch failed');
    return NextResponse.json({ error: 'Failed to switch organization' }, { status: 500 });
  }
}
