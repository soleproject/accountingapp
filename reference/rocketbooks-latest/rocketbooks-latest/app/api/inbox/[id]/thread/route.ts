import { NextResponse } from 'next/server';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { inboxMessages } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';

export const runtime = 'nodejs';

export interface ThreadEntry {
  id: string;
  direction: 'inbound' | 'outbound';
  who: string;
  at: string;
  body: string;
}

/**
 * Reconstruct an email thread for the flip editor. Mirrors the inbox
 * message-detail view: all messages sharing the row's thread_id, ordered by
 * received time, with any reply that was sent through the app surfaced as a
 * separate "You" entry. This is the synced view (received mail + app-sent
 * replies) — replies sent outside the app aren't captured. In the shared demo
 * org, messages belong to the demo system user, so we scope by org there.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  const { id } = await ctx.params;

  const demo = isDemoOrg(orgId);
  const ownerScope = demo
    ? eq(inboxMessages.organizationId, orgId)
    : and(eq(inboxMessages.organizationId, orgId), eq(inboxMessages.userId, user.id));

  const cols = {
    id: inboxMessages.id,
    fromAddress: inboxMessages.fromAddress,
    fromName: inboxMessages.fromName,
    body: inboxMessages.body,
    receivedAt: inboxMessages.receivedAt,
    aiStatus: inboxMessages.aiStatus,
    aiDraftText: inboxMessages.aiDraftText,
    sentAt: inboxMessages.sentAt,
    threadId: inboxMessages.threadId,
  };

  const [row] = await db
    .select(cols)
    .from(inboxMessages)
    .where(and(eq(inboxMessages.id, id), ownerScope))
    .limit(1);

  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // With a thread id, pull every message that shares it. Without one (a lone
  // message — common for single-email "threads"), fall back to just this row
  // so the panel always shows at least the message being replied to.
  const rows = row.threadId
    ? await db
        .select(cols)
        .from(inboxMessages)
        .where(and(eq(inboxMessages.threadId, row.threadId), ownerScope))
        .orderBy(asc(inboxMessages.receivedAt))
    : [row];

  const entries: ThreadEntry[] = [];
  for (const m of rows) {
    entries.push({
      id: m.id,
      direction: 'inbound',
      who: m.fromName || m.fromAddress,
      at: m.receivedAt,
      body: m.body,
    });
    if (m.aiStatus === 'sent' && m.aiDraftText) {
      entries.push({
        id: `${m.id}:reply`,
        direction: 'outbound',
        who: 'You',
        at: m.sentAt ?? m.receivedAt,
        body: m.aiDraftText,
      });
    }
  }
  // Stable chronological order across inbound + surfaced replies.
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return NextResponse.json({ entries });
}
