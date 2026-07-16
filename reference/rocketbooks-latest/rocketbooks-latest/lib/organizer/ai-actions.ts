import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, tasks, users, signatureRequests, signatureRecipients } from '@/db/schema/schema';
import { sendAsUser } from '@/lib/email-accounts/send-as-user';
import { getOrCreateBookingProfile } from '@/lib/booking/profile';
import { publicBookingUrl, appBaseUrl } from '@/lib/booking/links';
import { videoProvider } from '@/lib/video';
import { getDocument, listDocuments, type DocumentListItem } from '@/lib/documents/store';
import { createRequestFromDocument } from '@/lib/signatures/create';
import { inviteRecipients } from '@/lib/signatures/route';
import { newSigningToken } from '@/lib/signatures/tokens';
import { renderTextPdf } from '@/lib/signatures/render-pdf';
import {
  downloadOrganizerDocument,
  uploadOrganizerDocument,
  ORGANIZER_DOCUMENTS_BUCKET,
} from '@/lib/storage/organizer-documents';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Server-side primitives behind the Organizer AI "do-it-for-me" actions
 * (send my calendar link, send an email, include my calendar link). Shared by
 * the committing AI tool AND the confirm-card's Send button (API route) so
 * there's exactly one send + task-trail path.
 *
 * Every completed action drops a DONE task so the user has a trail of what the
 * assistant did on their behalf.
 */

/** Resolve the user's public booking (calendar) link, creating the profile on
 *  first use (mirrors the get_booking_link tool). */
export async function resolveBookingLink(userId: string, orgId: string): Promise<string> {
  const [u] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const bundle = await getOrCreateBookingProfile({
    userId,
    organizationId: orgId,
    seed: u?.fullName || u?.email || 'meet',
  });
  return publicBookingUrl(bundle.profile.slug);
}

/** Insert a task already marked DONE — the audit trail of an AI action. */
export async function logCompletedTask(
  orgId: string,
  userId: string,
  opts: { title: string; description?: string | null; contactId?: string | null },
): Promise<string> {
  const id = randomUUID();
  await db.insert(tasks).values({
    id,
    userId,
    organizationId: orgId,
    product: 'organizer',
    page: '/organizer/dashboard',
    title: opts.title.slice(0, 200),
    description: opts.description ?? null,
    status: 'DONE',
    source: 'ai',
    autoCreated: true,
    reviewRequired: false,
    assignedToUsers: [userId],
    assignedToContacts: opts.contactId ? [opts.contactId] : [],
    subitems: [],
  });
  return id;
}

export interface SendOrganizerEmailInput {
  orgId: string;
  userId: string;
  /** Literal email address, or a contactId to resolve. */
  to: string;
  subject: string;
  body: string;
  includeBookingLink?: boolean;
  /** Append an arbitrary labeled link (e.g. a video join link). */
  extraLink?: { label: string; url: string };
  /** File attachments (Resend shape: filename + base64 content). */
  attachments?: Array<{ filename: string; content: string }>;
  /** Override the trail task's title; defaults to a sensible summary. */
  taskTitle?: string;
}

export interface SendOrganizerEmailResult {
  ok: boolean;
  error?: string;
  to?: string;
  toName?: string | null;
  contactId?: string | null;
  subject?: string;
  includedBookingLink?: boolean;
  bookingLink?: string;
  taskId?: string;
  taskTitle?: string;
}

/** Resolve a `to` that is either an email or a contactId into an address. */
export async function resolveEmailRecipient(
  orgId: string,
  to: string,
): Promise<{ email: string; name: string | null; contactId: string | null } | { error: string }> {
  const raw = to.trim();
  if (!raw) return { error: 'recipient required' };
  if (raw.includes('@')) return { email: raw, name: null, contactId: null };
  const [contact] = await db
    .select({ id: contacts.id, email: contacts.email, name: contacts.contactName })
    .from(contacts)
    .where(and(eq(contacts.id, raw), eq(contacts.organizationId, orgId)))
    .limit(1);
  if (!contact) return { error: `Contact ${raw} not found.` };
  if (!contact.email) return { error: `${contact.name} has no email on file.` };
  return { email: contact.email, name: contact.name, contactId: contact.id };
}

/**
 * Send a transactional email on the user's behalf, optionally appending their
 * calendar link, then log a completed task. The single send path for both the
 * confirm-card button and the conversational commit tool.
 */
export async function sendOrganizerEmail(input: SendOrganizerEmailInput): Promise<SendOrganizerEmailResult> {
  const subject = input.subject.trim();
  let body = input.body.trim();
  if (!subject) return { ok: false, error: 'subject required' };
  if (subject.length > 200) return { ok: false, error: 'subject exceeds 200 chars' };
  if (!body) return { ok: false, error: 'body required' };

  const recip = await resolveEmailRecipient(input.orgId, input.to);
  if ('error' in recip) return { ok: false, error: recip.error };

  let bookingLink: string | undefined;
  if (input.includeBookingLink) {
    bookingLink = await resolveBookingLink(input.userId, input.orgId);
    body += `\n\nGrab a time that works for you: ${bookingLink}`;
  }
  if (input.extraLink) {
    body += `\n\n${input.extraLink.label} ${input.extraLink.url}`;
  }
  if (body.length > 10000) return { ok: false, error: 'body exceeds 10000 chars' };

  // Prefer the user's own linked mailbox (from their real address, replies to
  // their inbox); fall back to Resend when they haven't connected one.
  const result = await sendAsUser({
    userId: input.userId,
    to: recip.email,
    subject,
    text: body,
    attachments: input.attachments,
  });
  if (!result.sent) {
    return { ok: false, error: result.error ?? 'Send failed.' };
  }

  const taskTitle =
    input.taskTitle?.trim() ||
    `Emailed ${recip.name ?? recip.email}${input.includeBookingLink ? ' (calendar link)' : ''}: ${subject}`;
  const taskId = await logCompletedTask(input.orgId, input.userId, {
    title: taskTitle,
    description: `Sent email to ${recip.email}.\nSubject: ${subject}${bookingLink ? `\nIncluded calendar link: ${bookingLink}` : ''}`,
    contactId: recip.contactId,
  });

  return {
    ok: true,
    to: recip.email,
    toName: recip.name,
    contactId: recip.contactId,
    subject,
    includedBookingLink: Boolean(input.includeBookingLink),
    bookingLink,
    taskId,
    taskTitle,
  };
}

export interface VideoInvite {
  toEmail: string;
  toName: string | null;
  contactId: string | null;
  roomName: string;
  /** Public guest-join URL — share this and the host's Join button opens it. */
  joinUrl: string;
}

/**
 * Provision an ad-hoc video room and resolve the recipient, for a "send <x> a
 * link to my video call" invite. The room is short-lived; the email is sent
 * separately (on confirm) via sendOrganizerEmail with the join link appended.
 */
export async function createVideoInvite(
  userId: string,
  orgId: string,
  to: string,
): Promise<VideoInvite | { error: string }> {
  if (!videoProvider.isConfigured()) return { error: 'Video calling is not configured.' };
  const recip = await resolveEmailRecipient(orgId, to);
  if ('error' in recip) return { error: recip.error };
  const room = await videoProvider.createRoom({ namePrefix: 'mtg' });
  return {
    toEmail: recip.email,
    toName: recip.name,
    contactId: recip.contactId,
    roomName: room.name,
    joinUrl: `${appBaseUrl()}/video/join/${room.name}`,
  };
}

/** Fuzzy-match organizer documents by title (top 5). */
export async function findDocument(
  orgId: string,
  userId: string,
  query: string,
): Promise<DocumentListItem[]> {
  const q = query.toLowerCase().trim();
  const docs = await listDocuments(orgId, userId);
  if (!q) return docs.slice(0, 5);
  return docs.filter((d) => d.title.toLowerCase().includes(q)).slice(0, 5);
}

export interface SendForSignatureResult {
  ok: boolean;
  error?: string;
  toName?: string | null;
  toEmail?: string;
  documentTitle?: string;
  signingUrl?: string;
  taskId?: string;
  taskTitle?: string;
}

/**
 * Send an existing document to a contact for e-signature: freeze it to a
 * signature request, add the contact as the sole recipient, email the signing
 * link, and log a completed task. Reuses the Signatures pipeline end-to-end.
 */
export async function sendDocumentForSignature(input: {
  orgId: string;
  userId: string;
  to: string;
  documentId: string;
}): Promise<SendForSignatureResult> {
  const doc = await getDocument(input.orgId, input.documentId);
  if (!doc) return { ok: false, error: 'Document not found.' };
  const recip = await resolveEmailRecipient(input.orgId, input.to);
  if ('error' in recip) return { ok: false, error: recip.error };

  let requestId: string;
  try {
    requestId = await createRequestFromDocument(input.orgId, input.userId, doc);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not prepare the document for signature.' };
  }

  await db.insert(signatureRecipients).values({
    id: randomUUID(),
    requestId,
    name: recip.name ?? recip.email,
    email: recip.email,
    signingOrder: 0,
    status: 'pending',
    token: newSigningToken(),
  });
  await db
    .update(signatureRequests)
    .set({ status: 'sent', sentAt: new Date().toISOString(), deliveryChannels: 'email' })
    .where(eq(signatureRequests.id, requestId));

  const [req] = await db.select().from(signatureRequests).where(eq(signatureRequests.id, requestId)).limit(1);
  const [recRow] = await db
    .select()
    .from(signatureRecipients)
    .where(eq(signatureRecipients.requestId, requestId))
    .limit(1);
  const links = req && recRow ? await inviteRecipients(req, [recRow], ['email']) : [];

  const taskTitle = `Sent "${doc.title}" to ${recip.name ?? recip.email} for signature`;
  const taskId = await logCompletedTask(input.orgId, input.userId, {
    title: taskTitle,
    description: `Signature request for "${doc.title}" sent to ${recip.email}.`,
    contactId: recip.contactId,
  });

  return {
    ok: true,
    toName: recip.name,
    toEmail: recip.email,
    documentTitle: doc.title,
    signingUrl: links[0]?.url,
    taskId,
    taskTitle,
  };
}

const SHARE_LINK_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function safeFilename(s: string): string {
  return s.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'document';
}

/** Longer-lived signed URL than the 1h default, for an emailed view link. */
async function shareSignedUrl(path: string): Promise<string> {
  const supa = createServiceClient();
  const { data, error } = await supa.storage
    .from(ORGANIZER_DOCUMENTS_BUCKET)
    .createSignedUrl(path, SHARE_LINK_TTL_SECONDS);
  if (error || !data) throw new Error(`signed url failed: ${error?.message ?? 'unknown'}`);
  return data.signedUrl;
}

export interface SendDocumentResult {
  ok: boolean;
  error?: string;
  toName?: string | null;
  toEmail?: string;
  documentTitle?: string;
  viewLink?: string;
  taskId?: string;
  taskTitle?: string;
}

/**
 * Email a document to a contact: attach it as a PDF AND include a (7-day)
 * view link. Uploaded PDFs are attached as-is; created documents are rendered
 * to PDF and uploaded so they too get a link. Logs a completed task.
 */
export async function sendDocumentToContact(input: {
  orgId: string;
  userId: string;
  to: string;
  documentId: string;
  subject?: string;
  body?: string;
}): Promise<SendDocumentResult> {
  const doc = await getDocument(input.orgId, input.documentId);
  if (!doc) return { ok: false, error: 'Document not found.' };
  const recip = await resolveEmailRecipient(input.orgId, input.to);
  if ('error' in recip) return { ok: false, error: recip.error };

  let pdfBytes: Uint8Array;
  let storagePath: string;
  let filename: string;
  if (doc.source === 'uploaded') {
    if (doc.mimeType !== 'application/pdf' || !doc.storagePath) {
      return { ok: false, error: 'Only PDF uploads can be emailed. Convert it to PDF, or send a created document.' };
    }
    pdfBytes = await downloadOrganizerDocument(doc.storagePath);
    storagePath = doc.storagePath;
    filename = doc.originalFilename || `${safeFilename(doc.title)}.pdf`;
  } else {
    pdfBytes = await renderTextPdf(doc.title, doc.body);
    const up = await uploadOrganizerDocument({
      organizationId: input.orgId,
      documentId: doc.id,
      filename: `${safeFilename(doc.title)}.pdf`,
      contentType: 'application/pdf',
      bytes: pdfBytes,
    });
    storagePath = up.path;
    filename = `${safeFilename(doc.title)}.pdf`;
  }

  let viewLink: string | undefined;
  try {
    viewLink = await shareSignedUrl(storagePath);
  } catch {
    viewLink = undefined; // attachment still goes; link is a bonus
  }

  const subject = input.subject?.trim() || `Document: ${doc.title}`;
  const body = input.body?.trim() || `Hi${recip.name ? ` ${recip.name}` : ''}, here's ${doc.title} — attached as a PDF.`;

  const result = await sendOrganizerEmail({
    orgId: input.orgId,
    userId: input.userId,
    to: input.to,
    subject,
    body,
    ...(viewLink ? { extraLink: { label: 'View online (7-day link):', url: viewLink } } : {}),
    attachments: [{ filename, content: Buffer.from(pdfBytes).toString('base64') }],
    taskTitle: `Sent "${doc.title}" to ${recip.name ?? recip.email}`,
  });
  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    toName: recip.name,
    toEmail: recip.email,
    documentTitle: doc.title,
    viewLink,
    taskId: result.taskId,
    taskTitle: result.taskTitle,
  };
}

