import { NextResponse } from 'next/server';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { inboxMessages, users, contacts } from '@/db/schema/schema';
import { logger } from '@/lib/logger';

/**
 * Inbound-message ingestion endpoint for the external email / SMS
 * agents. POST a single message; the endpoint will:
 *
 *   1. Authenticate via Authorization: Bearer <INBOX_INGEST_SECRET>.
 *      503 if the env var isn't set, 401 if the token is wrong.
 *   2. Resolve organization_id (use the user's active_organization_id
 *      if the caller omits it).
 *   3. Best-effort match the sender to a contact by email; sets
 *      contact_id when there's exactly one match in that org.
 *   4. Insert with status='open'. If external_id collides on the
 *      (user_id, external_id) unique index, the insert is a no-op and
 *      we return { duplicate: true } so the agent can safely retry.
 */

const Schema = z.object({
  userId: z.string().min(1).max(64),
  organizationId: z.string().min(1).max(64).optional(),
  source: z.enum(['email', 'sms', 'other']),
  fromAddress: z.string().min(1).max(512),
  fromName: z.string().max(255).optional(),
  subject: z.string().max(1000).optional(),
  body: z.string().min(1).max(100_000),
  bodyHtml: z.string().max(500_000).optional(),
  receivedAt: z.string().datetime().optional(),
  externalId: z.string().min(1).max(255).optional(),
  threadId: z.string().min(1).max(255).optional(),
  contactId: z.string().min(1).max(64).optional(),
});

function checkBearer(header: string | null, secret: string): boolean {
  if (!header) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const token = header.slice(prefix.length);
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const secret = process.env.INBOX_INGEST_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'INBOX_INGEST_SECRET not configured.' },
      { status: 503 },
    );
  }
  if (!checkBearer(req.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const parsed = Schema.safeParse(bodyJson);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad request', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const payload = parsed.data;

  // Resolve org: caller-provided takes precedence; fall back to the
  // user's active organization. If neither is available we can't
  // satisfy the NOT NULL FK, so 400 with a clear message.
  let organizationId = payload.organizationId;
  if (!organizationId) {
    const [profile] = await db
      .select({ activeOrg: users.activeOrganizationId, orgId: users.organizationId })
      .from(users)
      .where(eq(users.id, payload.userId))
      .limit(1);
    organizationId = profile?.activeOrg ?? profile?.orgId ?? undefined;
  }
  if (!organizationId) {
    return NextResponse.json(
      { error: 'organizationId required (user has no active organization)' },
      { status: 400 },
    );
  }

  // Best-effort contact match by email (only when caller didn't pass
  // contactId). Skip if the sender's address looks empty / non-email.
  let contactId = payload.contactId ?? null;
  if (!contactId && payload.fromAddress.includes('@')) {
    const matches = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.email, payload.fromAddress)))
      .limit(2);
    if (matches.length === 1) contactId = matches[0].id;
  }

  const id = randomUUID();
  // Email messages get queued for an AI draft; other sources (SMS,
  // other) don't have a drafting pipeline today, so ai_status stays
  // NULL for them and the cron sweep ignores them.
  const aiStatus = payload.source === 'email' ? 'pending' : null;
  try {
    const inserted = await db
      .insert(inboxMessages)
      .values({
        id,
        userId: payload.userId,
        organizationId,
        contactId,
        source: payload.source,
        fromAddress: payload.fromAddress,
        fromName: payload.fromName ?? null,
        subject: payload.subject ?? null,
        body: payload.body,
        bodyHtml: payload.bodyHtml ?? null,
        receivedAt: payload.receivedAt ?? new Date().toISOString(),
        status: 'open',
        externalId: payload.externalId ?? null,
        threadId: payload.threadId ?? null,
        aiStatus,
      })
      .onConflictDoNothing({
        target: [inboxMessages.userId, inboxMessages.externalId],
      })
      .returning({ id: inboxMessages.id });

    if (inserted.length === 0) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    return NextResponse.json({ ok: true, id: inserted[0].id, contactId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ userId: payload.userId, externalId: payload.externalId, err: msg }, 'inbox ingest failed');
    return NextResponse.json({ error: 'insert failed', detail: msg }, { status: 500 });
  }
}
