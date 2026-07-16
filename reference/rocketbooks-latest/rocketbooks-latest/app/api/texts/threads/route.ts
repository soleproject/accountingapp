import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isTextsEnabled } from '@/lib/texts/access';

export const runtime = 'nodejs';

export interface ThreadRow {
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  lastMessageAt: string;
  lastMessageBody: string;
  lastDirection: 'inbound' | 'outbound';
  unreadCount: number;
}

export async function GET() {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  if (!(await isTextsEnabled(user.id))) {
    return NextResponse.json({ error: 'texts not enabled' }, { status: 404 });
  }

  // One row per (contact_id) thread (NULL contact_id collapsed into a
  // single "unknown" pseudo-thread). Last message + unread inbound count
  // computed in one pass via DISTINCT ON. Unread = inbound with no
  // read_at — outbound messages are never "unread".
  interface Row {
    contact_id: string | null;
    contact_name: string | null;
    contact_phone: string | null;
    last_at: string;
    last_body: string;
    last_direction: 'inbound' | 'outbound';
    unread_count: number;
  }
  const result = await db.execute(sql`
    WITH msg AS (
      SELECT
        tm.contact_id,
        tm.body,
        tm.direction,
        tm.created_at,
        tm.read_at
      FROM text_messages tm
      WHERE tm.organization_id = ${orgId}
    ),
    latest AS (
      SELECT DISTINCT ON (contact_id)
        contact_id, body, direction, created_at
      FROM msg
      ORDER BY contact_id, created_at DESC
    ),
    unread AS (
      SELECT contact_id, COUNT(*)::int AS n
      FROM msg
      WHERE direction = 'inbound' AND read_at IS NULL
      GROUP BY contact_id
    )
    SELECT
      l.contact_id,
      c.contact_name,
      c.phone AS contact_phone,
      l.created_at AS last_at,
      l.body AS last_body,
      l.direction AS last_direction,
      COALESCE(u.n, 0) AS unread_count
    FROM latest l
    LEFT JOIN contacts c ON c.id = l.contact_id
    LEFT JOIN unread  u ON u.contact_id IS NOT DISTINCT FROM l.contact_id
    ORDER BY l.created_at DESC
    LIMIT 200
  `);

  const threads: ThreadRow[] = (result as unknown as Row[]).map((r) => ({
    contactId: r.contact_id,
    contactName: r.contact_name,
    contactPhone: r.contact_phone,
    lastMessageAt: r.last_at,
    lastMessageBody: r.last_body,
    lastDirection: r.last_direction,
    unreadCount: Number(r.unread_count) || 0,
  }));

  return NextResponse.json({ threads });
}
