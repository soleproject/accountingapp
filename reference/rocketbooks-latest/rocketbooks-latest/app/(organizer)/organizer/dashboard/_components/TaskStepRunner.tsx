'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import { useCardFlip, type FlipTaskPlan, type FlipCompose } from './CardFlipContext';
import { TaskWorkspaceClient } from '@/app/(organizer)/organizer/tasks/[id]/workspace/_components/TaskWorkspaceClient';
import { FlipComposeEditor } from './FlipComposeEditor';
import type { TaskStep, StepDocKind } from './taskPlanTypes';

/**
 * Right-card face when a task plan is open: runs the ACTIVE step.
 *  - document → the full Task Workspace canvas (reused), autosaving to the
 *    task's artifact, with the AI assistant scoped to drafting this doc.
 *  - email / text → the compose editor (AI-drafted from task context).
 *  - manual → a simple "mark done" panel for work the app can't do for you.
 */
export function TaskStepRunner({ target }: { target: FlipTaskPlan }) {
  const { planSteps, activeStepId, toggleStepDone, planConfirmed, close } = useCardFlip();
  const steps = planSteps.length ? planSteps : target.plan.steps;
  const active: TaskStep | null = steps.find((s) => s.id === activeStepId) ?? steps[0] ?? null;

  // Before the plan is confirmed the AI is still reviewing it — don't run a step
  // yet. Show a gentle placeholder so the right card isn't blank/working early.
  if (!planConfirmed) {
    return (
      <Shell onClose={close} title="Reviewing the plan">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-violet-100 text-violet-600 dark:bg-violet-900/40 dark:text-violet-300">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
            </svg>
          </span>
          <p className="max-w-xs text-sm text-zinc-600 dark:text-zinc-300">
            The assistant is reviewing the steps with you. Confirm the plan (left) to start working through them.
          </p>
        </div>
      </Shell>
    );
  }

  if (!active) {
    return (
      <Shell onClose={close} title="No step selected">
        <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
          Pick a step on the left to work on it.
        </p>
      </Shell>
    );
  }

  if (active.type === 'document') {
    return (
      <DocumentStepRunner
        key={`doc:${active.id}:${active.draft?.body ? 'd' : 'e'}`}
        target={target}
        step={active}
        onClose={close}
        onToggleDone={() => toggleStepDone(active.id)}
      />
    );
  }

  if (active.type === 'email' || active.type === 'text') {
    return (
      <ComposeStepRunner
        key={`step:${active.id}:${active.draft?.body ? 'd' : 'e'}`}
        target={target}
        step={active}
        channel={active.type}
      />
    );
  }

  // manual
  return (
    <Shell onClose={close} title="Manual step">
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-10 text-center">
        <p className="max-w-sm text-sm text-zinc-600 dark:text-zinc-300">{active.title}</p>
        <p className="max-w-sm text-xs text-zinc-400 dark:text-zinc-500">
          This step is something to do outside the app. Mark it done when you’ve handled it.
        </p>
        <button
          type="button"
          onClick={() => toggleStepDone(active.id)}
          className={`rounded-md px-4 py-1.5 text-sm font-medium shadow-sm ${
            active.status === 'done'
              ? 'border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
              : 'bg-emerald-600 text-white hover:bg-emerald-700'
          }`}
        >
          {active.status === 'done' ? 'Mark not done' : 'Mark done'}
        </button>
      </div>
    </Shell>
  );
}

/** Pull distinct [bracketed] placeholders out of a draft (e.g. "[date]",
 *  "[Your Company Name]", "[Task 1]"). These are the bits the AI still needs
 *  the user to supply. Capped + de-duped so the prompt stays short. */
function extractPlaceholders(body: string): string[] {
  const found = body.match(/\[[^\]\n]{1,60}\]/g);
  if (!found) return [];
  const seen = new Set<string>();
  for (const p of found) {
    const t = p.trim();
    if (!seen.has(t)) seen.add(t);
    if (seen.size >= 12) break;
  }
  return [...seen];
}

/** Turn a raw "[Your Company Name]" placeholder into a friendly field label
 *  ("Your Company Name") for the fields-to-complete checklist. */
function humanizeField(placeholder: string): string {
  return placeholder.replace(/^\[|\]$/g, '').replace(/\s+/g, ' ').trim();
}

/** Type-aware interview openers: what the AI should ask before drafting each
 *  kind of document, so it generates from real particulars, not guesses. */
const DOC_INTERVIEW: Record<StepDocKind, string> = {
  deck:
    'Ask what the deck is proposing, who the audience is, the 3–5 key points/sections they want, the desired outcome, and whether they want images. Then build the slides.',
  letter:
    'Ask who the letter is to, its purpose/ask, the key points to include, and the tone. Then write the letter.',
  resolution:
    'Ask what is being resolved/authorized, the entity and parties, the effective date, and any specific terms. Then draft the resolution.',
  email:
    'Ask who it’s to, the main message, and any specifics to include. Then draft the email.',
  text:
    'Ask the main message and any specifics. Then draft the text.',
};

/**
 * Document step: the AI does NOT auto-draft. The first time the user lands on
 * an undrafted document step, the assistant interviews them about the
 * document's particulars (type-aware), works it through, then generates it on
 * the canvas via generate_artifact. Already-drafted steps open with the draft
 * pre-filled and skip the interview (the user can still refine).
 */
function DocumentStepRunner({
  target,
  step,
  onClose,
  onToggleDone,
}: {
  target: FlipTaskPlan;
  step: TaskStep;
  onClose: () => void;
  onToggleDone: () => void;
}) {
  const { seedPrompt, requestSidecarOpen } = useAssistant();
  const docKind = (step.docKind ?? 'letter') as StepDocKind;
  // A draft is present if EITHER the step's own auto-draft OR the task's
  // previously-saved artifact has a body — both render on the canvas. (Document
  // steps don't auto-draft, so step.draft is usually empty; the visible draft
  // comes from initialArtifact. Without this fallback the AI wrongly ran the
  // "no draft yet" interview and asked for things already written in the doc.)
  const draftBody = step.draft?.body ?? target.plan.initialArtifact?.body ?? '';
  const hasDraft = !!draftBody.trim();
  // A drafted doc that still has [bracketed] placeholders needs the user's
  // input to finish. List the distinct placeholders so the AI can walk them
  // through each one. (Matches things like [Your Company Name], [date], [Task 1].)
  const placeholders = useMemo(() => (hasDraft ? extractPlaceholders(draftBody) : []), [hasDraft, draftBody]);
  const name = target.plan.userFirstName;

  // Track the LIVE canvas body so the "fields to complete" flip reflects what's
  // still unfilled as the AI patches the draft. Seeded with the initial draft.
  const [liveBody, setLiveBody] = useState(draftBody);
  const [showFields, setShowFields] = useState(false);
  const remainingFields = useMemo(() => extractPlaceholders(liveBody), [liveBody]);

  // One seed per step, when the user lands on it:
  //  - no draft yet → interview about the document's particulars, then draft.
  //  - drafted but with placeholders → warmly offer to finish it together and
  //    walk through each missing piece so the user can fill them in.
  //  - drafted + complete → no seed (they can refine freely).
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (seeded.current === step.id) return;
    if (hasDraft && placeholders.length === 0) {
      seeded.current = step.id; // complete draft — nothing to prompt
      return;
    }
    seeded.current = step.id;
    requestSidecarOpen('side');
    const greet = name ? `Address the user as ${name} (use their name naturally, not in every sentence).` : '';
    // Shared grounding rule: the AI already KNOWS the project/recipient/etc.
    // from the task + page context — it must use that and never ask for
    // anything it can reasonably infer. ("Draft sprint 5 proposal for
    // Greenfield" → project=Greenfield, recipient=Greenfield Consulting,
    // sprint=5; don't ask "what's the project?".)
    const groundRule =
      `You already know a lot from your page state (the task title "${target.plan.taskTitle}", the linked contact, notes, and prior emails). ` +
      `FIRST infer everything you can from that — the project/company, recipient, dates, subject — and fill those in yourself. ` +
      `NEVER ask the user for something the task or context already tells you. Only ask about specifics that genuinely cannot be inferred ` +
      `(the substantive content — e.g. for a proposal: the actual deliverables, scope, goals, pricing).`;
    if (hasDraft) {
      seedPrompt(
        `The user is on the document step "${step.title}" (a ${docKind}) for the task "${target.plan.taskTitle}". ` +
          `IMPORTANT: a draft is ALREADY WRITTEN and visible on the canvas (it's in your page state as current_draft.body) — most of it is done. ` +
          (placeholders.length
            ? `The ONLY things still missing are these bracketed fields: ${placeholders.map((p) => `"${p}"`).join(', ')}. Do NOT ask about anything else — the recipient, purpose, and body are already written; never re-ask for content that's already in the draft. `
            : `It has no remaining placeholders — just offer to refine it. `) +
          `${groundRule} ${greet} ` +
          `Open warmly ("Let's finish this together"), then IMMEDIATELY call generate_artifact (kind="${docKind}") once to fill in every listed field you can infer from context (e.g. [Your Name] → the user's name; start from current_draft.body and replace only the inferable bracketed fields). ` +
          `Then walk the user through the REMAINING fields, ONE at a time, in plain business language — never quote the raw [bracket] text. Frame each as the next thing to complete, e.g. "Next, the proposal needs the key deliverables — what's the first one?". ` +
          `For a field that is clearly a LIST (deliverables, user stories, objectives, risks, attendees), ask for the first item, then ask "Anything else, or move on?" and keep adding until they say move on. ` +
          `After each answer, call generate_artifact again with the FULL updated body, then go to the next field. Keep it conversational — one field per message.`,
        { mode: 'side', hidden: true },
      );
    } else {
      seedPrompt(
        `The user is on the document step "${step.title}" for the task "${target.plan.taskTitle}". This is a ${docKind}. Do NOT draft the full doc yet. ` +
          `${groundRule} ${greet} ` +
          `Help them work through it: ${DOC_INTERVIEW[docKind]} ` +
          `Ask ONLY about the specifics you can't infer, in one short friendly message (a few bullets). Once they answer, call generate_artifact (kind="${docKind}") to put the draft on the canvas, then tell them they can refine it.`,
        { mode: 'side', hidden: true },
      );
    }
  }, [hasDraft, placeholders, step.id, step.title, docKind, name, target.plan.taskTitle, requestSidecarOpen, seedPrompt]);

  const stepArtifact = step.draft?.body
    ? { kind: docKind, title: step.draft.title ?? step.title, body: step.draft.body }
    : target.plan.initialArtifact;

  const onBodyChange = useCallback((body: string) => setLiveBody(body), []);
  const fieldCount = remainingFields.length;

  return (
    <div className="flex flex-col">
      {/* Header with a fields-to-complete toggle (only when there are any). */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Document step</p>
          <p className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">{step.title}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {fieldCount > 0 && (
            <button
              type="button"
              onClick={() => setShowFields((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
              {showFields ? 'Back to draft' : `${fieldCount} field${fieldCount === 1 ? '' : 's'} to complete`}
            </button>
          )}
          <CloseBtn onClose={onClose} />
        </div>
      </div>

      {showFields && fieldCount > 0 ? (
        <FieldsToComplete fields={remainingFields} />
      ) : (
        <TaskWorkspaceClient
          taskId={target.plan.taskId}
          mirrorToDocuments
          pageTitle={`Task step — ${step.title}`}
          route="/organizer/dashboard"
          grounding={target.plan.grounding}
          initialArtifact={stepArtifact}
          branding={target.plan.branding}
          onBodyChange={onBodyChange}
        />
      )}
      <StepFooter done={step.status === 'done'} onToggle={onToggleDone} />
    </div>
  );
}

/** The flipped face: the fields the document still needs from the user, in
 *  plain language. Read-only — the user fills them by answering the assistant,
 *  which patches the canvas (and this list shrinks as fields get filled). */
function FieldsToComplete({ fields }: { fields: string[] }) {
  return (
    <div className="rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        To finish this document, the assistant still needs these from you. Answer them in the chat — they’ll fill in
        as you go.
      </p>
      <ul className="mt-3 flex flex-col gap-1.5">
        {fields.map((f, i) => (
          <li
            key={`${f}-${i}`}
            className="flex items-start gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-amber-400 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
              {i + 1}
            </span>
            <span className="text-zinc-700 dark:text-zinc-200">{humanizeField(f)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Email/text step: the message is auto-drafted, so the compose box opens ready.
 * The assistant just presents the draft and asks if there's anything to add —
 * no interview, since a plain message needs no extra fields. (If the draft
 * somehow isn't ready yet, it offers to draft from the task context instead.)
 */
function ComposeStepRunner({
  target,
  step,
  channel,
}: {
  target: FlipTaskPlan;
  step: TaskStep;
  channel: 'email' | 'text';
}) {
  const { seedPrompt, requestSidecarOpen } = useAssistant();
  const name = target.plan.userFirstName;
  const to = target.plan.contact?.name ?? null;
  const hasDraft = !!step.draft?.body;

  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (seeded.current === step.id) return;
    seeded.current = step.id;
    requestSidecarOpen('side');
    const greet = name ? `Address the user as ${name} naturally (not every sentence).` : '';
    const who = to ? ` to ${to}` : '';
    if (hasDraft) {
      seedPrompt(
        `The user is on the ${channel} step "${step.title}" for the task "${target.plan.taskTitle}". ` +
          `A ${channel}${who} is ALREADY DRAFTED and visible in the editor — they can read it there. ${greet} ` +
          `Do NOT interview them or ask for the recipient/subject/purpose. In ONE short, friendly line, let them know the ${channel} is drafted and ready, and ask only: is there anything they'd like to add or change before sending? ` +
          `If they ask for a change, call generate_artifact (kind="${channel}") with the full revised body. If they're happy, tell them it's ready to send.`,
        { mode: 'side', hidden: true },
      );
    } else {
      seedPrompt(
        `The user is on the ${channel} step "${step.title}" for the task "${target.plan.taskTitle}". ${greet} ` +
          `Infer the recipient and purpose from your page state (linked contact, notes, prior emails) — don't ask for what you can infer. ` +
          `Offer to draft the ${channel}${who}; if you have enough context, just draft it with generate_artifact (kind="${channel}") and ask if they want changes.`,
        { mode: 'side', hidden: true },
      );
    }
  }, [hasDraft, step.id, step.title, channel, name, to, target.plan.taskTitle, requestSidecarOpen, seedPrompt]);

  const compose: FlipCompose = {
    kind: 'compose',
    channel,
    taskId: target.plan.taskId,
    taskTitle: target.plan.taskTitle,
    contactId: target.plan.contact?.id ?? null,
    contactName: target.plan.contact?.name ?? null,
    to: channel === 'text' ? target.plan.contact?.phone ?? null : target.plan.contact?.email ?? null,
    subject: channel === 'email' ? step.draft?.title ?? step.title : null,
    note: step.title,
    initialBody: step.draft?.body ?? undefined,
  };
  return <FlipComposeEditor target={compose} />;
}

function Shell({ children, title, onClose }: { children: React.ReactNode; title: string; onClose: () => void }) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <StepHeaderBare title={title} onClose={onClose} />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

function StepHeaderBare({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</h2>
      <CloseBtn onClose={onClose} />
    </div>
  );
}

function StepFooter({ done, onToggle }: { done: boolean; onToggle: () => void }) {
  return (
    <div className="mt-2 flex justify-end">
      <button
        type="button"
        onClick={onToggle}
        className={`rounded-md px-3 py-1.5 text-xs font-medium ${
          done
            ? 'border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
            : 'bg-emerald-600 text-white hover:bg-emerald-700'
        }`}
      >
        {done ? 'Step done ✓ — undo' : 'Mark step done'}
      </button>
    </div>
  );
}

function CloseBtn({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close step"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  );
}
