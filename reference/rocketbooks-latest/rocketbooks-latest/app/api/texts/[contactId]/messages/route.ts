import { NextResponse } from 'next/server';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { textMessages } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { isTextsEnabled } from '@/lib/texts/access';

export const runtime = 'nodejs';

export interface MessageRow {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  status: string | null;
  fromPhone: string;
  toPhone: string;
  sentByUserId: string | null;
  createdAt: string;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ contactId: string }> },
) {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  // Mirror the Texts page: always allow in the shared demo org so seeded
  // threads load, regardless of the viewer's own texts_enabled_at flag.
  if (!(await isTextsEnabled(user.id)) && !isDemoOrg(orgId)) {
    return NextResponse.json({ error: 'texts not enabled' }, { status: 404 });
  }

  const { contactId } = await ctx.params;
  // 'none' = the pseudo-thread of inbound texts that didn't match a contact.
  const isNone = contactId === 'none';

  const whereClause = isNone
    ? and(eq(textMessages.organizationId, orgId), isNull(textMessages.contactId))
    : and(eq(textMessages.organizationId, orgId), eq(textMessages.contactId, contactId));

  const messages = await db
    .select({
      id: textMessages.id,
      direction: textMessages.direction,
      body: textMessages.body,
      status: textMessages.status,
      fromPhone: textMessages.fromPhone,
      toPhone: textMessages.toPhone,
      sentByUserId: textMessages.sentByUserId,
      createdAt: textMessages.createdAt,
    })
    .from(textMessages)
    .where(whereClause)
    .orderBy(asc(textMessages.createdAt))
    .limit(500);

  // Mark inbound unread → read on view. Best-effort; failure here
  // shouldn't block the read.
  try {
    await db
      .update(textMessages)
      .set({ readAt: new Date().toISOString() })
      .where(
        and(
          eq(textMessages.organizationId, orgId),
          isNone ? isNull(textMessages.contactId) : eq(textMessages.contactId, contactId),
          eq(textMessages.direction, 'inbound'),
          isNull(textMessages.readAt),
        ),
      );
  } catch {
    // ignore
  }

  return NextResponse.json({ messages: messages as MessageRow[] });
}
