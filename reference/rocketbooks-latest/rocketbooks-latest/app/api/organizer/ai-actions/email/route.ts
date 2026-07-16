import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { sendOrganizerEmail } from '@/lib/organizer/ai-actions';

export const runtime = 'nodejs';

const Schema = z.object({
  to: z.string().trim().min(1),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10000),
  includeBookingLink: z.boolean().optional(),
  taskTitle: z.string().trim().max(200).optional(),
});

/**
 * Commit an Organizer AI email draft — the confirm card's Send button hits
 * this. Sends the email and logs a completed task. Demo workspace is read-only.
 */
export async function POST(req: Request) {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();
  if (isDemoOrg(orgId)) {
    return NextResponse.json({ error: "This action isn't available in the demo workspace." }, { status: 403 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const parsed = Schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad request', issues: parsed.error.issues }, { status: 400 });
  }

  const result = await sendOrganizerEmail({ orgId, userId, ...parsed.data });
  if (!result.ok) return NextResponse.json({ error: result.error ?? 'send failed' }, { status: 502 });
  return NextResponse.json(result);
}
