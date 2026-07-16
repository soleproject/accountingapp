import 'server-only';
import { randomUUID } from 'crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { signatureRequests, signatureRecipients, signatureFields, signatureEvents } from '@/db/schema/schema';

export type RequestStatus = 'draft' | 'sent' | 'completed' | 'declined' | 'voided';
export type FieldType = 'signature' | 'initials' | 'date' | 'text' | 'name' | 'checkbox';

export interface Recipient {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  signingOrder: number;
  status: string;
  token: string;
  invitedAt: string | null;
  signedAt: string | null;
}

export interface Field {
  id: string;
  recipientId: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  type: FieldType;
  required: boolean;
  value: string | null;
  signatureImagePath: string | null;
}

export interface RequestRow {
  id: string;
  organizationId: string;
  title: string;
  message: string;
  status: string;
  sourceDocumentId: string | null;
  sourcePdfPath: string | null;
  completedPdfPath: string | null;
  sequential: boolean;
  deliveryChannels: string | null;
  createdAt: string;
  sentAt: string | null;
  completedAt: string | null;
}

const num = (v: unknown): number => Number(v ?? 0);

/** List a list-view summary of an org's requests, newest first. */
export async function listRequests(orgId: string): Promise<(RequestRow & { recipients: Recipient[] })[]> {
  const reqs = await db
    .select()
    .from(signatureRequests)
    .where(eq(signatureRequests.organizationId, orgId))
    .orderBy(desc(signatureRequests.createdAt))
    .limit(200);
  if (reqs.length === 0) return [];
  const ids = new Set(reqs.map((r) => r.id));
  const recips = await db
    .select()
    .from(signatureRecipients)
    .orderBy(asc(signatureRecipients.signingOrder));
  const byReq = new Map<string, Recipient[]>();
  for (const r of recips) {
    if (!ids.has(r.requestId)) continue;
    const list = byReq.get(r.requestId) ?? [];
    list.push(toRecipient(r));
    byReq.set(r.requestId, list);
  }
  return reqs.map((r) => ({ ...toRequest(r), recipients: byReq.get(r.id) ?? [] }));
}

/** Full request (recipients + fields) for the owner builder. Org-scoped. */
export async function getRequestForOwner(
  orgId: string,
  id: string,
): Promise<{ request: RequestRow; recipients: Recipient[]; fields: Field[] } | null> {
  const [req] = await db
    .select()
    .from(signatureRequests)
    .where(and(eq(signatureRequests.id, id), eq(signatureRequests.organizationId, orgId)))
    .limit(1);
  if (!req) return null;
  const recipients = (
    await db.select().from(signatureRecipients).where(eq(signatureRecipients.requestId, id)).orderBy(asc(signatureRecipients.signingOrder))
  ).map(toRecipient);
  const fields = (await db.select().from(signatureFields).where(eq(signatureFields.requestId, id))).map(toField);
  return { request: toRequest(req), recipients, fields };
}

/** Resolve the signing context for a public token (no org scoping — the token
 *  IS the authorization). Returns the recipient, its request, and that
 *  recipient's fields. */
export async function getByToken(token: string): Promise<{
  request: RequestRow;
  recipient: Recipient;
  fields: Field[];
} | null> {
  const [recip] = await db.select().from(signatureRecipients).where(eq(signatureRecipients.token, token)).limit(1);
  if (!recip) return null;
  const [req] = await db.select().from(signatureRequests).where(eq(signatureRequests.id, recip.requestId)).limit(1);
  if (!req) return null;
  const fields = (
    await db.select().from(signatureFields).where(and(eq(signatureFields.requestId, recip.requestId), eq(signatureFields.recipientId, recip.id)))
  ).map(toField);
  return { request: toRequest(req), recipient: toRecipient(recip), fields };
}

/** Append an audit-trail event. */
export async function recordEvent(args: {
  requestId: string;
  recipientId?: string | null;
  type: string;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown> | null;
}): Promise<void> {
  await db.insert(signatureEvents).values({
    id: randomUUID(),
    requestId: args.requestId,
    recipientId: args.recipientId ?? null,
    type: args.type,
    ip: args.ip ?? null,
    userAgent: args.userAgent ?? null,
    meta: args.meta ?? null,
  });
}

function toRequest(r: typeof signatureRequests.$inferSelect): RequestRow {
  return {
    id: r.id,
    organizationId: r.organizationId,
    title: r.title,
    message: r.message,
    status: r.status,
    sourceDocumentId: r.sourceDocumentId,
    sourcePdfPath: r.sourcePdfPath,
    completedPdfPath: r.completedPdfPath,
    sequential: r.sequential,
    deliveryChannels: r.deliveryChannels,
    createdAt: r.createdAt,
    sentAt: r.sentAt,
    completedAt: r.completedAt,
  };
}

function toRecipient(r: typeof signatureRecipients.$inferSelect): Recipient {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    signingOrder: r.signingOrder,
    status: r.status,
    token: r.token,
    invitedAt: r.invitedAt,
    signedAt: r.signedAt,
  };
}

function toField(f: typeof signatureFields.$inferSelect): Field {
  return {
    id: f.id,
    recipientId: f.recipientId,
    page: f.page,
    x: num(f.x),
    y: num(f.y),
    w: num(f.w),
    h: num(f.h),
    type: f.type as FieldType,
    required: f.required,
    value: f.value,
    signatureImagePath: f.signatureImagePath,
  };
}
