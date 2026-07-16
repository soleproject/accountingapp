import { NextRequest, NextResponse } from 'next/server';
import { isAuthorizedCron } from '@/lib/cron';
import { runMeetingFollowups } from '@/lib/meetings/followups';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

// Advances the meeting follow-up lifecycle for every in-scope meeting:
// backfill → detect notes → chase → Call Debrief → execute-on-approval.
// Idempotent; runs every 15 min (see vercel.json).
export async function GET(req: NextRequest) {
	if (!isAuthorizedCron(req)) return new NextResponse('forbidden', { status: 401 });
	try {
		const summary = await runMeetingFollowups();
		return NextResponse.json({ ok: true, ...summary });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.error({ err: message }, 'meeting-followups cron failed');
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
