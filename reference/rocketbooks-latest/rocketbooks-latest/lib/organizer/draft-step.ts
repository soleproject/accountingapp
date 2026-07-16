import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { getTaskContextPack } from '@/lib/task-links/queries';
import { chatCompletion } from '@/lib/ai/openai';

/**
 * Shared "draft a message/document for a task step" generator. Used by the
 * on-demand AI-draft button (draftTaskMessageAction) and the auto-draft-on-open
 * flow (draftStep in taskPlan). Grounds the draft in the task's context pack so
 * it writes from real data, not just the step title. Nothing is persisted here.
 */

const MODEL = 'gpt-5-mini';

export const DRAFT_TONES: Record<string, string> = {
  professional: 'Professional and polished, but warm — not stiff or robotic.',
  casual: 'Casual and conversational, like writing to a friendly peer.',
  friendly: 'Warm, friendly, and approachable.',
  humorous: 'Light and good-humored — a touch of tasteful humor, never forced.',
  serious: 'Serious, direct, and businesslike.',
  concise: 'As brief as possible — a sentence or two, no filler.',
};

export type DraftChannel = 'email' | 'text' | 'document';

function firstName(full: string | null | undefined, email: string | null | undefined): string {
  const f = (full ?? '').trim().split(/\s+/)[0];
  if (f) return f;
  const local = (email ?? '').split('@')[0] ?? '';
  const head = local.split(/[._-]/)[0] ?? local;
  return head ? head.charAt(0).toUpperCase() + head.slice(1) : 'me';
}

export interface DraftStepResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * @param channel  email/text → a message; document → a letter/memo/etc. body.
 * @param stepTitle  the specific step (e.g. "Draft the engagement letter"),
 *                   so the draft targets THIS step, not the whole task.
 */
export async function generateStepDraft(opts: {
  userId: string;
  orgId: string;
  taskId: string;
  channel: DraftChannel;
  tone: string;
  stepTitle?: string;
}): Promise<DraftStepResult> {
  const { userId, orgId, taskId, channel, stepTitle } = opts;
  const tone = Object.prototype.hasOwnProperty.call(DRAFT_TONES, opts.tone) ? opts.tone : 'professional';

  const pack = await getTaskContextPack(orgId, taskId);
  if (!pack) return { ok: false, error: 'Task not found' };

  const [u] = await db
    .select({ fullName: users.fullName, email: users.email, voice: users.aiVoiceDoc })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const me = firstName(u?.fullName, u?.email);
  const recipient = pack.contacts[0];

  const channelWord = channel === 'text' ? 'text message' : channel === 'email' ? 'email' : 'document';
  const focus = stepTitle ? `\nThis specific step: "${stepTitle}". Produce ONLY what this step needs.` : '';

  const rules =
    channel === 'text'
      ? '- Keep it short — SMS length. No signature, no greeting boilerplate; write it like a real text.'
      : channel === 'email'
        ? '- Match a normal business email length and formality. Sign with the first name only. No subject line, no quoting.'
        : '- Write the document body in clean Markdown (headings with #, bullet lines with -). No surrounding commentary.';

  const system = [
    `You draft a ${channelWord} that the user (${me}) needs to complete a task step. The user reviews before using it.`,
    `Tone: ${DRAFT_TONES[tone]}`,
    focus,
    '',
    'Rules:',
    rules,
    '- Ground it ONLY in the task and context provided. Do NOT invent dates, numbers, prices, attachments, names, or commitments. If something is needed that you do not have, leave a clearly-bracketed placeholder like [date] or ask for it.',
    `- Output the ${channel === 'document' ? 'document' : 'message'} body ONLY. Plain UTF-8 text.`,
    u?.voice ? `\nThe user's style preferences (apply where they don't conflict):\n${u.voice.trim()}` : '',
  ].join('\n');

  const lines: string[] = [`Task: ${pack.task.title}`];
  if (pack.task.description) lines.push(`Task detail: ${pack.task.description}`);
  if (recipient) lines.push(`Recipient: ${recipient.name}${recipient.company ? ` (${recipient.company})` : ''}`);
  if (pack.notes.length) lines.push(`Related notes:\n${pack.notes.map((n) => `- ${n.body}`).join('\n')}`);
  if (pack.emails.length) lines.push(`Prior emails:\n${pack.emails.map((e) => `- ${e.subject ?? '(no subject)'}: ${e.body}`).join('\n')}`);
  if (pack.texts.length) lines.push(`Prior texts:\n${pack.texts.map((t) => `- ${t.direction}: ${t.body}`).join('\n')}`);
  if (pack.meetings.length) lines.push(`Related meetings:\n${pack.meetings.map((m) => `- ${m.title}${m.description ? `: ${m.description}` : ''}`).join('\n')}`);

  const userPrompt = [lines.join('\n\n'), '', `Write it now, in the requested tone. Body only.`].join('\n');

  try {
    const res = await chatCompletion(
      { userId, orgId, actor: 'dashboard-task-step', feature: 'task-step-draft', metadata: { taskId, channel, stepTitle } },
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
