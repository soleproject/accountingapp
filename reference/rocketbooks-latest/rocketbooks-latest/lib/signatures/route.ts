import 'server-only';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, organizations, signatureRequests, signatureRecipients } from '@/db/schema/schema';
import { sendInvites, type DeliveryChannel, type RecipientLink } from './notify';
import { recordEvent } from './store';

const ALL_CHANNELS: DeliveryChannel[] = ['email', 'sms', 'link'];

/** Parse the stored csv back into channels (defaults to email + link). */
export function parseChannels(csv: string | null): DeliveryChannel[] {
  if (!csv) return ['email', 'link'];
  const set = csv.split(',').map((s) => s.trim());
  const out = ALL_CHANNELS.filter((c) => set.includes(c));
  return out.length ? out : ['email', 'link'];
}

type RecipientDbRow = typeof signatureRecipients.$inferSelect;

/** Display name for the person who sent the request (creator → org → fallback). */
async function senderNameFor(req: typeof signatureRequests.$inferSelect): Promise<string> {
  if (req.userId) {
    const [u] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, req.userId)).limit(1);
    if (u?.fullName?.trim()) return u.fullName.trim();
  }
  const [o] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, req.organizationId)).limit(1);
  return o?.name?.trim() || 'Your sender';
}

/**
 * Deliver invites to the given recipients over the chosen channels, stamp
 * invited_at, and log a 'sent' event each. Returns the per-recipient links.
 */
export async function inviteRecipients(
  req: typeof signatureRequests.$inferSelect,
  recipients: RecipientDbRow[],
  channels: DeliveryChannel[],
): Promise<RecipientLink[]> {
  if (recipients.length === 0) return [];
  const senderName = await senderNameFor(req);
  const links = await sendInvites({
    senderName,
    documentTitle: req.title || 'Document',
    message: req.message || '',
    channels,
    recipients: recipients.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      signingOrder: r.signingOrder,
      status: r.status,
      token: r.token,
      invitedAt: r.invitedAt,
      signedAt: r.signedAt,
    })),
    usage: { userId: req.userId ?? null, orgId: req.organizationId, actor: 'system', feature: 'signature-invite' },
  });
  const now = new Date().toISOString();
  for (const r of recipients) {
    await db.update(signatureRecipients).set({ invitedAt: now }).where(eq(signatureRecipients.id, r.id));
    await recordEvent({ requestId: req.id, recipientId: r.id, type: 'sent' });
  }
  return links;
}

/**
 * After a signer finishes in a sequential request, invite the next
 * not-yet-invited recipient in signing_order. No-op for parallel requests, or
 * when everyone in line has already been invited.
 */
export async function advanceSequential(requestId: string): Promise<void> {
  const [req] = await db.select().from(signatureRequests).where(eq(signatureRequests.id, requestId)).limit(1);
  if (!req || !req.sequential || req.status !== 'sent') return;

  const [next] = await db
    .select()
    .from(signatureRecipients)
    .where(and(eq(signatureRecipients.requestId, requestId), eq(signatureRecipients.status, 'pending'), isNull(signatureRecipients.invitedAt)))
    .orderBy(asc(signatureRecipients.signingOrder))
    .limit(1);
  if (!next) return;

  await inviteRecipients(req, [next], parseChannels(req.deliveryChannels));
}

/**
 * Re-send a recipient's invite (manual reminder). Only valid for an open
 * request and a recipient who has actually been invited but hasn't finished —
 * so a sequential signer who isn't up yet can't be prematurely nudged.
 */
export async function remindRecipient(requestId: string, recipientId: string): Promise<{ ok: boolean; error?: string }> {
  const [req] = await db.select().from(signatureRequests).where(eq(signatureRequests.id, requestId)).limit(1);
  if (!req || req.status !== 'sent') return { ok: false, error: 'This request is not open for signing.' };

  const [r] = await db
    .select()
    .from(signatureRecipients)
    .where(and(eq(signatureRecipients.id, recipientId), eq(signatureRecipients.requestId, requestId)))
    .limit(1);
  if (!r) return { ok: false, error: 'Recipient not found.' };
  if (r.status === 'signed' || r.status === 'declined') return { ok: false, error: 'This signer is already done.' };
  if (!r.invitedAt) return { ok: false, error: 'This signer has not been invited yet (waiting their turn).' };

  const senderName = await senderNameFor(req);
  await sendInvites({
    senderName,
    documentTitle: req.title || 'Document',
    message: req.message || '',
    channels: parseChannels(req.deliveryChannels),
    recipients: [{ id: r.id, name: r.name, email: r.email, phone: r.phone, signingOrder: r.signingOrder, status: r.status, token: r.token, invitedAt: r.invitedAt, signedAt: r.signedAt }],
    usage: { userId: req.userId ?? null, orgId: req.organizationId, actor: 'system', feature: 'signature-reminder' },
  });
  await recordEvent({ requestId, recipientId, type: 'reminded' });
  return { ok: true };
}
