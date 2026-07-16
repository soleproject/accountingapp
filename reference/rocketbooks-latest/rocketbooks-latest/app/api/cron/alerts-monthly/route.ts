import { NextRequest, NextResponse } from 'next/server';
import { isAuthorizedCron } from '@/lib/cron';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse('forbidden', { status: 401 });
  logger.info('alerts-monthly cron tick — handler pending');
  return NextResponse.json({ ok: true, pending: true });
}
