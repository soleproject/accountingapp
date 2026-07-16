import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { executeRealtimeTool } from '@/lib/ai/realtime-tool-dispatch';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 30;

const InvokeBody = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  turnId: z.string().min(1).optional(),
});

export async function POST(req: NextRequest) {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const parsed = InvokeBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const { name, args, turnId } = parsed.data;
  try {
    const result = await executeRealtimeTool(orgId, name, args, turnId);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'tool error';
    logger.error({ tool: name, args, turnId, err: msg }, 'realtime tool failed');
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
