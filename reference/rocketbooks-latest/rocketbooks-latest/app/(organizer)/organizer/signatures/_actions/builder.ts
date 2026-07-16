'use server';

import { and, asc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { signatureRequests, signatureRecipients, signatureFields } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { newSigningToken } from '@/lib/signatures/tokens';
import { recordEvent } from '@/lib/signatures/store';
import { inviteRecipients } from '@/lib/signatures/route';
import type { DeliveryChannel, RecipientLink } from '@/lib/signatures/notify';
import type { FieldType } from '@/lib/signatures/store';

export interface RecipientInput {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  signingOrder: number;
}
export interface FieldInput {
  id: string;
  recipientId: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  type: FieldType;
  required: boolean;
}
export interface BuilderPayload {
  title: string;
  message: string;
  sequential: boolean;
  recipients: RecipientInput[];
  fields: FieldInput[];
}

const FIELD_TYPES: FieldType[] = ['signature', 'initials', 'date', 'text', 'name', 'checkbox'];
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

/** Load a draft request that belongs to this org, or null. */
async function loadDraft(orgId: string, requestId: string) {
  const [req] = await db
    .select()
    .from(signatureRequests)
    .where(and(eq(signatureRequests.id, requestId), eq(signatureRequests.organizationId, orgId)))
    .limit(1);
  return req ?? null;
}

/**
 * Replace the request's recipients + fields with the builder payload. Only
 * allowed while the request is a draft. Recipients are re-created (each gets a
 * fresh signing token); client-supplied UUIDs are used as the DB ids so field
 * → recipient references stay intact without a remap.
 */
async function persist(orgId: string, requestId: string, payload: BuilderPayload): Promise<{ ok: boolean; error?: string }> {
  const req = await loadDraft(orgId, requestId);
  if (!req) return { ok: false, error: 'Request not found.' };
  if (req.status !== 'draft') return { ok: false, error: 'This request has already been sent.' };

  const recipients = payload.recipients.filter((r) => r.name.trim() || r.email.trim());
  // Fields must reference a kept recipient.
  const recipientIds = new Set(recipients.map((r) => r.id));
  const fields = payload.fields.filter((f) => recipientIds.has(f.recipientId) && FIELD_TYPES.includes(f.type));

  await db
    .update(signatureRequests)
    .set({ title: payload.title.slice(0, 300), message: payload.message.slice(0, 2000), sequential: !!payload.sequential })
    .where(eq(signatureRequests.id, requestId));

  // Order matters: fields FK → recipients, so clear fields first.
  await db.delete(signatureFields).where(eq(signatureFields.requestId, requestId));
  await db.delete(signatureRecipients).where(eq(signatureRecipients.requestId, requestId));

  if (recipients.length > 0) {
    await db.insert(signatureRecipients).values(
      recipients.map((r, i) => ({
        id: r.id,
        requestId,
        name: r.name.slice(0, 200),
        email: r.email.slice(0, 200),
        phone: r.phone?.slice(0, 40) || null,
        signingOrder: r.signingOrder ?? i,
        status: 'pending',
        token: newSigningToken(),
      })),
    );
  }
  if (fields.length > 0) {
    await db.insert(signatureFields).values(
      fields.map((f) => ({
        id: f.id,
        requestId,
        recipientId: f.recipientId,
        page: Math.max(0, Math.floor(f.page)),
        x: String(clamp01(f.x)),
        y: String(clamp01(f.y)),
        w: String(clamp01(f.w)),
        h: String(clamp01(f.h)),
        type: f.type,
        required: f.required !== false,
      })),
    );
  }
  return { ok: true };
}

export async function saveBuilderAction(requestId: string, payload: BuilderPayload): Promise<{ ok: boolean; error?: string }> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const res = await persist(orgId, requestId, payload);
  if (res.ok) revalidatePath(`/organizer/signatures/${requestId}`);
  return res;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  links?: RecipientLink[];
}

/** Persist the builder, then mark the request sent and deliver invites. */
export async function sendRequestAction(requestId: string, payload: BuilderPayload, channels: DeliveryChannel[]): Promise<SendResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();

  const saved = await persist(orgId, requestId, payload);
  if (!saved.ok) return { ok: false, error: saved.error };

  const recipients = await db
    .select()
    .from(signatureRecipients)
    .where(eq(signatureRecipients.requestId, requestId))
    .orderBy(asc(signatureRecipients.signingOrder));
  if (recipients.length === 0) return { ok: false, error: 'Add at least one recipient.' };
  const withoutEmail = recipients.find((r) => !r.email.trim());
  if (withoutEmail) return { ok: false, error: 'Every recipient needs an email address.' };

  const fieldRows = await db.select({ recipientId: signatureFields.recipientId }).from(signatureFields).where(eq(signatureFields.requestId, requestId));
  const haveFieldFor = new Set(fieldRows.map((f) => f.recipientId));
  const noFields = recipients.find((r) => !haveFieldFor.has(r.id));
  if (noFields) return { ok: false, error: `Place at least one field for ${noFields.name || noFields.email}.` };

  await db
    .update(signatureRequests)
    .set({ status: 'sent', sentAt: new Date().toISOString(), deliveryChannels: channels.join(',') })
    .where(eq(signatureRequests.id, requestId));
  const [req] = await db.select().from(signatureRequests).where(eq(signatureRequests.id, requestId)).limit(1);

  // Sequential: invite only the first signer; the rest are invited as each
  // one finishes (advanceSequential). Parallel: invite everyone now.
  const toInvite = req.sequential ? recipients.slice(0, 1) : recipients;
  const links = await inviteRecipients(req, toInvite, channels);
  await recordEvent({ requestId, type: 'sent', meta: { channels, sequential: req.sequential, recipientCount: recipients.length } });

  revalidatePath('/organizer/signatures');
  revalidatePath(`/organizer/signatures/${requestId}`);
  return { ok: true, links };
}
