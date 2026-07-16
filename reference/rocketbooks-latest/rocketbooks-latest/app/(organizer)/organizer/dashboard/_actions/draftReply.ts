'use server';

import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { inboxMessages, textMessages, contacts, users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { isDemoOrg } from '@/lib/auth/demo';
import { chatCompletion } from '@/lib/ai/openai';

const MODEL = 'gpt-5-mini';
const THREAD_CAP = 12;

/** Tone presets → drafting instruction. Server-only (not exported: a
 *  'use server' module may only export async functions). */
const DRAFT_TONES: Record<string, string> = {
  professional: 'Professional and polished, but warm — not stiff or robotic.',
  casual: 'Casual and conversational, like writing to a friendly peer.',
  friendly: 'Warm, friendly, and approachable.',
  humorous: 'Light and good-humored — a touch of tasteful humor, never forced or unprofessional.',
  serious: 'Serious, direct, and businesslike.',
  concise: 'As brief as possible — a sentence or two, no filler.',
};
type ToneKey = keyof typeof DRAFT_TONES;

export interface DraftReplyInput {
  kind: 'email' | 'text';
  /** email → inbox message id; text → contact id. */
  id: string;
  tone: string;
}

export interface DraftReplyResult {
  ok: boolean;
  text?: string;
  error?: string;
}

interface Turn {
  who: string;
  mine: boolean;
  body: string;
}

function firstName(full: string | null | undefined, email: string | null | undefined): string {
  const f = (full ?? '').trim().split(/\s+/)[0];
  if (f) return f;
  const local = (email ?? '').split('@')[0] ?? '';
  const head = local.split(/[._-]/)[0] ?? local;
  return head ? head.charAt(0).toUpperCase() + head.slice(1) : 'me';
}

/**
 * Draft a reply for the dashboard flip editor in a chosen tone. Reads the
 * conversation (email thread by thread_id, or the text thread by contact),
 * asks the model to write the user's next reply, and returns the text for the
 * editor to drop into the compose box. Nothing is persisted.
 */
export async function draftReplyAction(input: DraftReplyInput): Promise<DraftReplyResult> {
  try {
    return await draft(input);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function draft(input: DraftReplyInput): Promise<DraftReplyResult> {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();
  const demo = isDemoOrg(orgId);
  const tone = (Object.prototype.hasOwnProperty.call(DRAFT_TONES, input.tone) ? input.tone : 'professional') as ToneKey;

  const turns: Turn[] = [];
  let counterpart = 'them';

  if (input.kind === 'email') {
    const ownerScope = demo
      ? eq(inboxMessages.organizationId, orgId)
      : and(eq(inboxMessages.organizationId, orgId), eq(inboxMessages.userId, userId));

    const cols = {
      id: inboxMessages.id,
      fromAddress: inboxMessages.fromAddress,
      fromName: inboxMessages.fromName,
      body: inboxMessages.body,
      receivedAt: inboxMessages.receivedAt,
      aiStatus: inboxMessages.aiStatus,
      aiDraftText: inboxMessages.aiDraftText,
      threadId: inboxMessages.threadId,
    };
    const [msg] = await db.select(cols).from(inboxMessages).where(and(eq(inboxMessages.id, input.id), ownerScope)).limit(1);
    if (!msg) return { ok: false, error: 'Message not found' };
    counterpart = msg.fromName || msg.fromAddress;

    const rows = msg.threadId
      ? await db.select(cols).from(inboxMessages).where(and(eq(inboxMessages.threadId, msg.threadId), ownerScope)).orderBy(asc(inboxMessages.receivedAt))
      : [msg];
    for (const r of rows) {
      turns.push({ who: r.fromName || r.fromAddress, mine: false, body: r.body });
      if (r.aiStatus === 'sent' && r.aiDraftText) turns.push({ who: 'You', mine: true, body: r.aiDraftText });
    }
  } else {
    const rows = await db
      .select({ direction: textMessages.direction, body: textMessages.body, fromPhone: textMessages.fromPhone })
      .from(textMessages)
      .where(and(eq(textMessages.organizationId, orgId), eq(textMessages.contactId, input.id)))
      .orderBy(asc(textMessages.createdAt));
    if (rows.length === 0) return { ok: false, error: 'No conversation found' };
    const [c] = await db.select({ name: contacts.contactName }).from(contacts).where(eq(contacts.id, input.id)).limit(1);
    counterpart = c?.name || rows.find((r) => r.direction === 'inbound')?.fromPhone || 'them';
    for (const r of rows) {
      turns.push({ who: r.direction === 'outbound' ? 'You' : counterpart, mine: r.direction === 'outbound', body: r.body });
    }
  }

  const recent = turns.slice(-THREAD_CAP);

  const [u] = await db
    .select({ fullName: users.fullName, email: users.email, voice: users.aiVoiceDoc })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const me = firstName(u?.fullName, u?.email);

  const channel = input.kind === 'email' ? 'email' : 'text message';
  const system = [
    `You draft a ${channel} reply on the user's behalf for them to review and send.`,
    `You are writing as ${me}.`,
    '',
    `Tone: ${DRAFT_TONES[tone]}`,
    '',
    'Rules:',
    `- Mirror the other person's length. ${input.kind === 'text' ? 'Texts must be short — SMS length.' : 'Match the email\'s length and formality.'}`,
    input.kind === 'email'
      ? '- Sign with the first name only. No subject line, no quoting the original.'
      : '- No signature, no greeting boilerplate — write it like a real text.',
    '- Do NOT invent dates, numbers, prices, names, or commitments. If something is needed that you do not have, ask for it or say you will follow up.',
    '- Output the reply body ONLY. Plain UTF-8 text.',
    u?.voice ? `\nThe user's style preferences (apply where they don't conflict with the rules):\n${u.voice.trim()}` : '',
  ].join('\n');

  const convo = recent.length
    ? recent.map((t) => `${t.mine ? 'You' : t.who}: ${t.body.trim()}`).join('\n\n')
    : '(no prior messages)';

  const userPrompt = [
    `Conversation with ${counterpart} (oldest first):`,
    '',
    convo,
    '',
    `Write ${me}'s next reply now, in the requested tone. Reply body only.`,
  ].join('\n');

  try {
    const res = await chatCompletion(
      {
        userId,
        orgId,
        actor: 'dashboard-flip-draft',
        feature: 'flip-ai-draft',
        metadata: { kind: input.kind, id: input.id, tone },
      },
      {
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
      },
    );
    const text = (res.choices[0]?.message?.content ?? '').trim();
    if (!text) return { ok: false, error: 'The AI returned an empty draft — try again.' };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Draft failed' };
  }
}
