import { NextRequest, NextResponse } from 'next/server';
import { isAuthorizedCron } from '@/lib/cron';
import { autoCompleteRecurringTasks } from '@/lib/enterprise/auto-complete-tasks';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

/**
 * Daily: close recurring tasks whose underlying work is verifiably done (e.g.
 * month-end-close → the period was reviewed/closed; clear-findings → no open
 * audit findings). Only keys with a reliable DB signal auto-complete; everything
 * else stays open for a person. Direct route (not Inngest) — app-sync trap.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse('forbidden', { status: 401 });

  const closed = await autoCompleteRecurringTasks();
  logger.info({ closed }, 'auto-complete-tasks cron: done');
  return NextResponse.json({ ok: true, closed });
}
