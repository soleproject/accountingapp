import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { isSuperAdmin } from '@/lib/auth/org';
import { getFirstName } from '@/lib/ai/client-context';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 10;

export async function GET() {
  const user = await requireSession();

  const [firstName, canRealtime] = await Promise.all([
    getFirstName(user.id).catch(() => ''),
    isSuperAdmin().catch((err) => {
      const msg = err instanceof Error ? err.message : 'isSuperAdmin failed';
      logger.warn({ err: msg }, 'ai-chat bootstrap realtime capability degraded');
      return false;
    }),
  ]);

  return NextResponse.json({
    firstName: firstName ?? '',
    canRealtime: canRealtime === true,
  });
}
