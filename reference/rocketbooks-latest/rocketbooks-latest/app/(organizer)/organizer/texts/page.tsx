import { notFound } from 'next/navigation';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { isTextsEnabled } from '@/lib/texts/access';
import { TextsWorkspace } from '@/components/texts/TextsWorkspace';
import { getTelegramConnectState } from '@/lib/messaging/telegram-connect';
import { ConnectTelegram } from '@/components/texts/ConnectTelegram';

interface ThreadRow {
  contact_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  last_at: string;
  last_body: string;
  last_direction: 'inbound' | 'outbound';
  unread_count: number;
}

export default async function TextsPage() {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  // Always expose Texts in the shared demo org so the seeded threads render,
  // regardless of the viewer's own texts_enabled_at flag.
  if (!(await isTextsEnabled(user.id)) && !isDemoOrg(orgId)) notFound();

  const [threadsResult, contactsWithPhone] = await Promise.all([
    db.execute(sql`
      WITH msg AS (
        SELECT contact_id, body, direction, created_at, read_at
        FROM text_messages
        WHERE organization_id = ${orgId}
      ),
      latest AS (
        SELECT DISTINCT ON (contact_id) contact_id, body, direction, created_at
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
    `),
    db
      .select({ id: contacts.id, contactName: contacts.contactName, phone: contacts.phone })
      .from(contacts)
      .where(and(eq(contacts.organizationId, orgId), isNotNull(contacts.phone)))
      .limit(500),
  ]);

  const threadRows = threadsResult as unknown as ThreadRow[];
  const initialThreads = threadRows.map((r: ThreadRow) => ({
    contactId: r.contact_id,
    contactName: r.contact_name,
    contactPhone: r.contact_phone,
    lastMessageAt: r.last_at,
    lastMessageBody: r.last_body,
    lastDirection: r.last_direction,
    unreadCount: Number(r.unread_count) || 0,
  }));

  const contactOptions = contactsWithPhone
    .filter((c): c is { id: string; contactName: string; phone: string } => !!c.phone)
    .map((c) => ({ id: c.id, name: c.contactName, phone: c.phone }));

  const telegramState = await getTelegramConnectState(orgId, user.id);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Texts</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Send and receive SMS and Telegram conversations with your contacts.
        </p>
      </header>
      <ConnectTelegram state={telegramState} />
      <TextsWorkspace initialThreads={initialThreads} contactsWithPhone={contactOptions} />
    </div>
  );
}
