'use server';

import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { signatureRecipients, signatureFields } from '@/db/schema/schema';
import { getByToken, recordEvent } from '@/lib/signatures/store';
import { uploadSignatureObject, getSignatureSignedUrl } from '@/lib/storage/signatures';
import { completeRequestIfReady } from '@/lib/signatures/complete';
import { advanceSequential } from '@/lib/signatures/route';
import { logger } from '@/lib/logger';

export interface FieldSubmission {
  id: string;
  value?: string;
  /** data:image/png;base64,... for signature/initials fields. */
  signatureDataUrl?: string;
}

export interface SubmitResult {
  ok: boolean;
  error?: string;
}

const MAX_PNG_BYTES = 2 * 1024 * 1024;

async function clientMeta(): Promise<{ ip: string | null; ua: string | null }> {
  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || null;
  return { ip, ua: h.get('user-agent') };
}

/** Record that a recipient opened their signing link (best-effort). */
export async function markViewedAction(token: string): Promise<void> {
  const ctx = await getByToken(token);
  if (!ctx) return;
  if (ctx.recipient.status === 'pending') {
    await db.update(signatureRecipients).set({ status: 'viewed', viewedAt: new Date().toISOString() }).where(eq(signatureRecipients.id, ctx.recipient.id));
    const { ip, ua } = await clientMeta();
    await recordEvent({ requestId: ctx.request.id, recipientId: ctx.recipient.id, type: 'viewed', ip, userAgent: ua });
  }
}

/** Decode a PNG data URL to bytes, guarding type + size. */
function decodePng(dataUrl: string): Uint8Array | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length === 0 || buf.length > MAX_PNG_BYTES) return null;
  return new Uint8Array(buf);
}

/**
 * Submit a recipient's signature. Validates ESIGN consent + required fields,
 * stores drawn signatures, records values, marks the recipient signed, and
 * finalizes the request when everyone has signed. Token is the authorization —
 * no session required.
 */
export async function submitSignatureAction(token: string, consent: boolean, submissions: FieldSubmission[]): Promise<SubmitResult> {
  if (!consent) return { ok: false, error: 'You must agree to sign electronically.' };

  const ctx = await getByToken(token);
  if (!ctx) return { ok: false, error: 'This signing link is no longer valid.' };
  const { request, recipient, fields } = ctx;
  if (request.status === 'voided') return { ok: false, error: 'This request has been cancelled.' };
  if (recipient.status === 'signed') return { ok: true };
  if (request.status !== 'sent') return { ok: false, error: 'This request is not open for signing.' };

  const subById = new Map(submissions.map((s) => [s.id, s]));

  // Validate required fields are satisfied.
  for (const f of fields) {
    if (!f.required) continue;
    const s = subById.get(f.id);
    const hasValue = (s?.value && s.value.trim().length > 0) || (s?.signatureDataUrl && s.signatureDataUrl.length > 0);
    if (!hasValue) return { ok: false, error: 'Please complete every required field before submitting.' };
  }

  // Persist each field value / drawn signature.
  for (const f of fields) {
    const s = subById.get(f.id);
    if (!s) continue;
    if ((f.type === 'signature' || f.type === 'initials') && s.signatureDataUrl) {
      const bytes = decodePng(s.signatureDataUrl);
      if (!bytes) return { ok: false, error: 'The signature image could not be read. Please re-draw it.' };
      const path = `${request.organizationId}/${request.id}/signed/${recipient.id}-${f.id}.png`;
      await uploadSignatureObject({ path, contentType: 'image/png', bytes });
      await db.update(signatureFields).set({ signatureImagePath: path, value: 'signed' }).where(eq(signatureFields.id, f.id));
    } else if (s.value !== undefined) {
      await db.update(signatureFields).set({ value: s.value.slice(0, 500) }).where(eq(signatureFields.id, f.id));
    }
  }

  const { ip, ua } = await clientMeta();
  await db
    .update(signatureRecipients)
    .set({ status: 'signed', signedAt: new Date().toISOString(), signedIp: ip, signedUserAgent: ua })
    .where(eq(signatureRecipients.id, recipient.id));
  await recordEvent({ requestId: request.id, recipientId: recipient.id, type: 'consented', ip, userAgent: ua });
  await recordEvent({ requestId: request.id, recipientId: recipient.id, type: 'signed', ip, userAgent: ua });

  try {
    // Sequential requests: invite the next signer now that this one is done.
    await advanceSequential(request.id);
    await completeRequestIfReady(request.id);
  } catch (err) {
    // Signature is recorded; completion/advance can be retried. Don't fail the signer.
    logger.error({ err: err instanceof Error ? err.message : String(err), requestId: request.id }, 'post-sign routing failed');
  }

  return { ok: true };
}

/** Recipient declines to sign. */
export async function declineAction(token: string, reason: string): Promise<SubmitResult> {
  const ctx = await getByToken(token);
  if (!ctx) return { ok: false, error: 'This signing link is no longer valid.' };
  if (ctx.recipient.status === 'signed') return { ok: false, error: 'You have already signed.' };
  const { ip, ua } = await clientMeta();
  await db.update(signatureRecipients).set({ status: 'declined', declineReason: reason.slice(0, 500) }).where(eq(signatureRecipients.id, ctx.recipient.id));
  await recordEvent({ requestId: ctx.request.id, recipientId: ctx.recipient.id, type: 'declined', ip, userAgent: ua, meta: { reason: reason.slice(0, 500) } });
  return { ok: true };
}

/** Fresh signed-URL to download the completed PDF (post-completion). */
export async function getCompletedUrlByTokenAction(token: string): Promise<{ ok: boolean; url?: string }> {
  const ctx = await getByToken(token);
  if (!ctx || ctx.request.status !== 'completed' || !ctx.request.completedPdfPath) return { ok: false };
  try {
    const url = await getSignatureSignedUrl(ctx.request.completedPdfPath);
    return { ok: true, url };
  } catch {
    return { ok: false };
  }
}
