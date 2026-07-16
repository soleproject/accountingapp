'use server';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { tasks, users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { isDemoOrg } from '@/lib/auth/demo';
import { getTaskContextPack, getTaskArtifact } from '@/lib/task-links/queries';
import { getOrgBranding } from '@/lib/documents/branding';
import { chatCompletion } from '@/lib/ai/openai';
import { generateStepDraft } from '@/lib/organizer/draft-step';
import { logger } from '@/lib/logger';
import type { TaskPlanData, TaskStep, TaskStepType, StepDocKind } from '../_components/taskPlanTypes';

const MODEL = 'gpt-5-mini';
const STEP_TYPES = new Set<TaskStepType>(['document', 'email', 'text', 'manual']);
const DOC_KINDS = new Set<StepDocKind>(['letter', 'email', 'text', 'resolution', 'deck']);

/**
 * Resolve a task's step plan for the dashboard flip. Returns a persisted plan
 * from tasks.subitems if present (instant, no AI); otherwise asks the model to
 * decompose the task into ordered steps, persists them to subitems, and returns
 * them. Also returns the canvas bootstrap (grounding + saved artifact + branding)
 * so the flipped "document" runner mirrors the full Task Workspace.
 */
export async function getTaskPlan(taskId: string): Promise<TaskPlanData> {
  try {
    await requireSession();
    const userId = await getEffectiveUserId();
    const orgId = await getCurrentOrgId();
    const demo = isDemoOrg(orgId);

    const [task] = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        description: tasks.description,
        subitems: tasks.subitems,
        org: tasks.organizationId,
      })
      .from(tasks)
      .where(
        demo
          ? and(eq(tasks.id, taskId), eq(tasks.organizationId, orgId))
          : and(eq(tasks.id, taskId), eq(tasks.userId, userId)),
      )
      .limit(1);

    if (!task) return errPlan(taskId, 'Task not found');

    const taskOrg = task.org ?? orgId;

    // Pull canvas bootstrap + context in parallel; the pack also feeds the
    // decomposition prompt (linked contacts/notes/emails ground the steps).
    const [pack, savedArtifact, branding, userRow] = await Promise.all([
      getTaskContextPack(taskOrg, taskId),
      getTaskArtifact(taskOrg, taskId),
      getOrgBranding(taskOrg),
      db.select({ fullName: users.fullName }).from(users).where(eq(users.id, userId)).limit(1),
    ]);

    const contact = pack?.contacts[0]
      ? { id: pack.contacts[0].id, name: pack.contacts[0].name, email: pack.contacts[0].email, phone: pack.contacts[0].phone }
      : null;
    const userFirstName = (userRow[0]?.fullName ?? '').trim().split(/\s+/)[0] || null;

    const grounding = pack ? buildGrounding(pack) : { task_title: task.title };

    // 1) Persisted plan? Use it as-is (instant path).
    const stored = parseStoredPlan(task.subitems);
    let steps = stored.steps;
    let confirmed = stored.confirmed;

    // 2) Otherwise decompose with AI and persist (unconfirmed → AI reviews it).
    if (steps.length === 0) {
      steps = (await decompose(task.title, task.description, pack, { userId, orgId })) ?? [];
      // Fallback: a single manual step so the flip always has something to run.
      if (steps.length === 0) {
        steps = [{ id: randomUUID(), title: task.title, type: 'manual', status: 'open' }];
      }
      confirmed = false;
      await persist(taskId, taskOrg, steps, confirmed);
    }

    return {
      ok: true,
      taskId,
      taskTitle: task.title,
      confirmed,
      steps,
      contact,
      userFirstName,
      grounding,
      initialArtifact: savedArtifact,
      branding,
    };
  } catch (err) {
    return errPlan(taskId, err instanceof Error ? err.message : 'Plan failed');
  }
}

/** Persist updated step statuses (check off / reopen) back to subitems. */
export async function setTaskSteps(taskId: string, steps: TaskStep[]): Promise<{ ok: boolean; error?: string }> {
  try {
    await requireSession();
    const userId = await getEffectiveUserId();
    const orgId = await getCurrentOrgId();
    const demo = isDemoOrg(orgId);

    const [task] = await db
      .select({ id: tasks.id, org: tasks.organizationId, subitems: tasks.subitems })
      .from(tasks)
      .where(
        demo
          ? and(eq(tasks.id, taskId), eq(tasks.organizationId, orgId))
          : and(eq(tasks.id, taskId), eq(tasks.userId, userId)),
      )
      .limit(1);
    if (!task) return { ok: false, error: 'Task not found' };

    // Preserve the confirmed flag — a status toggle isn't a re-plan.
    const { confirmed } = parseStoredPlan(task.subitems);
    await persist(taskId, task.org ?? orgId, steps.map(sanitizeStep).filter((s): s is TaskStep => s !== null), confirmed);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Save failed' };
  }
}

/** Mark the plan confirmed (the user reviewed it and is ready to work). Sticks
 *  — used by the checklist "Looks good — start" button. */
export async function confirmTaskPlan(taskId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await requireSession();
    const userId = await getEffectiveUserId();
    const orgId = await getCurrentOrgId();
    const demo = isDemoOrg(orgId);
    const [task] = await db
      .select({ id: tasks.id, org: tasks.organizationId, subitems: tasks.subitems })
      .from(tasks)
      .where(demo ? and(eq(tasks.id, taskId), eq(tasks.organizationId, orgId)) : and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
      .limit(1);
    if (!task) return { ok: false, error: 'Task not found' };
    const { steps } = parseStoredPlan(task.subitems);
    await persist(taskId, task.org ?? orgId, steps, true);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Confirm failed' };
  }
}

export interface ReplaceStepsResult {
  ok: boolean;
  steps?: TaskStep[];
  confirmed?: boolean;
  error?: string;
}

/**
 * Replace the plan's steps (the AI's update_task_steps tool target). Accepts a
 * raw step list (add/remove/reorder), sanitizes it, preserves any existing
 * drafts by id, and optionally marks the plan confirmed in the same call (so
 * "looks good, go" from chat both finalizes the steps and starts work).
 */
export async function replaceTaskSteps(
  taskId: string,
  rawSteps: unknown[],
  confirm: boolean,
): Promise<ReplaceStepsResult> {
  try {
    await requireSession();
    const userId = await getEffectiveUserId();
    const orgId = await getCurrentOrgId();
    const demo = isDemoOrg(orgId);
    const [task] = await db
      .select({ id: tasks.id, org: tasks.organizationId, subitems: tasks.subitems })
      .from(tasks)
      .where(demo ? and(eq(tasks.id, taskId), eq(tasks.organizationId, orgId)) : and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
      .limit(1);
    if (!task) return { ok: false, error: 'Task not found' };

    const prev = parseStoredPlan(task.subitems);
    const prevById = new Map(prev.steps.map((s) => [s.id, s]));
    const prevByTitle = new Map(prev.steps.map((s) => [s.title.toLowerCase(), s]));

    const steps = rawSteps
      .map(sanitizeStep)
      .filter((s): s is TaskStep => s !== null)
      .slice(0, 8)
      .map((s) => {
        // Carry forward an existing draft for a kept step (matched by id, else
        // by identical title) so editing the plan doesn't discard work.
        const match = prevById.get(s.id) ?? prevByTitle.get(s.title.toLowerCase());
        return match?.draft && !s.draft ? { ...s, draft: match.draft } : s;
      });
    if (steps.length === 0) return { ok: false, error: 'A plan needs at least one step.' };

    await persist(taskId, task.org ?? orgId, steps, confirm || prev.confirmed);
    return { ok: true, steps, confirmed: confirm || prev.confirmed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Update failed' };
  }
}

export interface DraftStepResult {
  ok: boolean;
  /** The drafted body (also persisted into the step). */
  draft?: { title?: string; body: string };
  error?: string;
}

/**
 * Draft a single AI-able step and persist the result into the step plan
 * (subitems), so reopening the task shows it instantly without re-drafting.
 * Called once per step, in parallel, when the task plan first opens. Manual
 * steps return ok with no draft (nothing to generate).
 */
export async function draftStep(taskId: string, stepId: string, tone = 'professional'): Promise<DraftStepResult> {
  try {
    await requireSession();
    const userId = await getEffectiveUserId();
    const orgId = await getCurrentOrgId();
    const demo = isDemoOrg(orgId);

    const [task] = await db
      .select({ id: tasks.id, org: tasks.organizationId, subitems: tasks.subitems })
      .from(tasks)
      .where(
        demo
          ? and(eq(tasks.id, taskId), eq(tasks.organizationId, orgId))
          : and(eq(tasks.id, taskId), eq(tasks.userId, userId)),
      )
      .limit(1);
    if (!task) return { ok: false, error: 'Task not found' };

    const steps = parseStoredSteps(task.subitems);
    const step = steps.find((s) => s.id === stepId);
    if (!step) return { ok: false, error: 'Step not found' };
    if (step.type === 'manual') return { ok: true }; // nothing to draft
    if (step.draft?.body) return { ok: true, draft: step.draft }; // already drafted — reuse

    const channel = step.type === 'document' ? 'document' : step.type; // 'email' | 'text' | 'document'
    const r = await generateStepDraft({ userId, orgId, taskId, channel, tone, stepTitle: step.title });
    if (!r.ok || !r.text) return { ok: false, error: r.error ?? 'Draft failed' };

    const draft = { body: r.text, ...(step.type === 'document' ? { title: step.title } : {}) };
    // Persist into the matching step. Re-read fresh to avoid clobbering a
    // sibling step's draft written by a parallel call; preserve confirmed.
    const freshPlan = parseStoredPlan((await db.select({ s: tasks.subitems }).from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]?.s);
    const base = freshPlan.steps.length ? freshPlan.steps : steps;
    const merged = base.map((s) => (s.id === stepId ? { ...s, draft } : s));
    await persist(taskId, task.org ?? orgId, merged, freshPlan.confirmed);

    return { ok: true, draft };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Draft failed' };
  }
}

// --- helpers --------------------------------------------------------------

function errPlan(taskId: string, error: string): TaskPlanData {
  return {
    ok: false,
    taskId,
    taskTitle: '',
    confirmed: false,
    steps: [],
    contact: null,
    userFirstName: null,
    grounding: {},
    initialArtifact: null,
    // A minimal branding object so the type is satisfied even on error; the
    // canvas never renders on the error path.
    branding: {
      orgName: '',
      logoUrl: null,
      addressLines: [],
      phone: null,
      email: null,
      website: null,
      entityLabel: null,
      signatoryName: null,
      signatoryTitle: null,
      showLetterhead: false,
    },
    error,
  };
}

/**
 * subitems holds the plan as `{ confirmed, steps }`. Legacy rows stored a bare
 * step array (pre-confirm-gate); parseStored* read both shapes. We always write
 * the wrapped shape going forward.
 */
async function persist(taskId: string, orgId: string, steps: TaskStep[], confirmed: boolean): Promise<void> {
  await db
    .update(tasks)
    .set({ subitems: { confirmed, steps }, updatedAt: new Date().toISOString() })
    .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, orgId)));
}

function sanitizeStep(raw: unknown): TaskStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (!title) return null;
  const type = (STEP_TYPES.has(o.type as TaskStepType) ? o.type : 'manual') as TaskStepType;
  const status = o.status === 'done' ? 'done' : 'open';
  const id = typeof o.id === 'string' && o.id ? o.id : randomUUID();
  const docKind = type === 'document' && DOC_KINDS.has(o.docKind as StepDocKind) ? (o.docKind as StepDocKind) : type === 'document' ? 'letter' : undefined;
  // Preserve a persisted AI draft if present (body required; title optional).
  let draft: TaskStep['draft'];
  if (o.draft && typeof o.draft === 'object') {
    const d = o.draft as Record<string, unknown>;
    if (typeof d.body === 'string' && d.body.trim()) {
      draft = { body: d.body, ...(typeof d.title === 'string' ? { title: d.title } : {}) };
    }
  }
  return { id, title, type, status, ...(docKind ? { docKind } : {}), ...(draft ? { draft } : {}) };
}

/** Read the full stored plan ({steps, confirmed}); tolerates the legacy bare
 *  array shape (treated as unconfirmed). */
function parseStoredPlan(raw: unknown): { steps: TaskStep[]; confirmed: boolean } {
  if (Array.isArray(raw)) {
    return { steps: raw.map(sanitizeStep).filter((s): s is TaskStep => s !== null), confirmed: false };
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const steps = Array.isArray(o.steps) ? o.steps.map(sanitizeStep).filter((s): s is TaskStep => s !== null) : [];
    return { steps, confirmed: o.confirmed === true };
  }
  return { steps: [], confirmed: false };
}

/** Just the steps (convenience for callers that don't care about confirmed). */
function parseStoredSteps(raw: unknown): TaskStep[] {
  return parseStoredPlan(raw).steps;
}

interface PackLike {
  task: { title: string; description: string | null };
  contacts: { name: string; company: string | null }[];
  notes: { body: string }[];
  emails: { subject: string | null; body: string }[];
  meetings: { title: string }[];
}

async function decompose(
  title: string,
  description: string | null,
  pack: PackLike | null,
  ctx: { userId: string; orgId: string },
): Promise<TaskStep[] | null> {
  const contactStr = pack?.contacts.length
    ? pack.contacts.map((c) => c.company ?? c.name).join(', ')
    : '(none)';

  const system = [
    'You break an organizer task into the concrete ORDERED steps needed to complete it.',
    'Respond with STRICT JSON only: {"steps":[{"title":string,"type":"document|email|text|manual","docKind":"letter|email|text|resolution|deck"}]}',
    '',
    'Rules:',
    '- 1 to 5 steps. If the task is a single action, return ONE step. Do NOT pad — fewer, meaningful steps are better.',
    '- type="email"/"text" = sending a message. This ALREADY INCLUDES writing/drafting it (the user drafts in the same editor). So an email/text is ONE step — NEVER split "draft the email" and "send the email" into two. "Follow up with X", "email/text X", "reply to X" → a SINGLE email or text step.',
    '- type="document" = producing a standalone document that is NOT itself the message: a letter, legal resolution, memo, or slide deck (often attached, printed, or signed). Only use a separate document step when the deliverable is a real document, not when the task is just sending an email/text.',
    '- type="manual" for anything the app cannot do for the user (e.g. "get a signature", "call the client", "wait for approval").',
    '- Only split "produce" and "send" into two steps when the produced thing is a standalone document (letter/deck/resolution) that then gets sent/attached — never for a plain email or text.',
    '- Each title is a short imperative phrase. Do NOT restate the whole task.',
    '- set docKind on document steps (default "letter"); omit it otherwise.',
  ].join('\n');

  const userPrompt = [
    `Task: "${title}"`,
    description ? `Detail: "${description.slice(0, 500)}"` : '',
    `Linked contacts: ${contactStr}`,
    pack?.notes.length ? `Notes: ${pack.notes.slice(0, 3).map((n) => n.body).join(' | ')}` : '',
    '',
    'Return the JSON now.',
  ].filter(Boolean).join('\n');

  try {
    const res = await chatCompletion(
      { userId: ctx.userId, orgId: ctx.orgId, actor: 'dashboard-task-plan', feature: 'task-step-decompose', metadata: { title } },
      {
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      },
    );
    const raw = (res.choices[0]?.message?.content ?? '').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { steps?: unknown[] };
    if (!Array.isArray(parsed.steps)) return null;
    return parsed.steps
      .map((s) => sanitizeStep({ ...(s as object), id: randomUUID(), status: 'open' }))
      .filter((s): s is TaskStep => s !== null)
      .slice(0, 5);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'task-step-decompose failed');
    return null;
  }
}

function snip(s: string | null | undefined, n = 200): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Same grounding shape the full Task Workspace builds, so the embedded canvas
 *  behaves identically when the AI drafts/revises a document step. */
function buildGrounding(pack: NonNullable<Awaited<ReturnType<typeof getTaskContextPack>>>): Record<string, unknown> {
  return {
    task_title: pack.task.title,
    task_description: pack.task.description ?? null,
    due: pack.task.dueDate,
    priority: pack.task.priority,
    module: pack.task.module,
    linked_contacts: pack.contacts.map((c) => ({
      name: c.company ?? c.name,
      contact: c.company ? c.name : null,
      email: c.email,
      phone: c.phone,
    })),
    recent_notes: pack.notes.slice(0, 4).map((n) => snip(n.body)),
    related_emails: pack.emails.slice(0, 4).map((e) => ({ subject: e.subject, from: e.from, snippet: snip(e.body) })),
    related_texts: pack.texts.slice(0, 4).map((t) => ({ direction: t.direction, snippet: snip(t.body) })),
    related_meetings: pack.meetings.slice(0, 4).map((m) => ({ title: m.title, when: m.startsAt, about: snip(m.description) })),
  };
}
