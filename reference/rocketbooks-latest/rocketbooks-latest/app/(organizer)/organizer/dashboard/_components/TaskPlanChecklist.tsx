'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import { useCardFlip, type FlipTaskPlan } from './CardFlipContext';
import type { TaskStep, TaskStepType } from './taskPlanTypes';

/**
 * Left-column face when a task plan is open: the ordered step checklist. Click a
 * step to make it active (the right card runs it); tick the box to mark it
 * done. Mirrors the message-history flip, but for a task's plan instead.
 */
const TYPE_LABEL: Record<TaskStepType, string> = {
  document: 'Document',
  email: 'Email',
  text: 'Text',
  manual: 'Action',
};

const TYPE_TONE: Record<TaskStepType, string> = {
  document: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  email: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  text: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  manual: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
};

export function TaskPlanChecklist({ target }: { target: FlipTaskPlan }) {
  const { planSteps, activeStepId, setActiveStep, toggleStepDone, draftingStepIds, planConfirmed, confirmPlan, applyPlanUpdate, close } =
    useCardFlip();
  const { setPageContext, registerClientAction, seedPrompt, requestSidecarOpen } = useAssistant();
  const steps = planSteps.length ? planSteps : target.plan.steps;
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const draftingCount = steps.filter((s) => draftingStepIds.has(s.id)).length;

  // Own the assistant page context ONLY during the review phase (unconfirmed),
  // so the AI can confirm / edit the plan via update_task_steps. Once confirmed,
  // we release the slot — the active step's runner (the document canvas) takes
  // it over so the AI's generate_artifact targets the canvas, not the plan.
  // The update_task_steps result handler is registered regardless, so an AI
  // plan edit during review still flows back into the checklist.
  useEffect(() => {
    const unregister = registerClientAction('task_plan_updated', (raw) => {
      const rawSteps = Array.isArray(raw.steps) ? (raw.steps as TaskStep[]) : [];
      applyPlanUpdate({ steps: rawSteps, confirmed: raw.confirmed === true });
    });
    return unregister;
  }, [registerClientAction, applyPlanUpdate]);

  useEffect(() => {
    if (planConfirmed) return; // released once work starts — step runner owns context
    setPageContext({
      pageId: 'task-step-plan',
      pageTitle: `Task plan — ${target.plan.taskTitle}`,
      route: '/organizer/dashboard',
      toolNames: ['update_task_steps'],
      data: {
        task_id: target.plan.taskId,
        task_title: target.plan.taskTitle,
        confirmed: planConfirmed,
        steps: steps.map((s, i) => ({ n: i + 1, title: s.title, type: s.type, status: s.status })),
        instructions:
          'The user just opened this task. Briefly restate the task and list the steps you will take, then ask if it looks right or if any steps should be added/removed. When they approve or request changes, call update_task_steps (full ordered list; confirm=true on approval). Once confirmed, you work step by step.',
      },
    });
    return () => setPageContext(null);
  }, [setPageContext, target.plan.taskId, target.plan.taskTitle, planConfirmed, steps]);

  // First open of an unconfirmed plan: open the assistant and have it review
  // the plan with the user. Guarded so it only fires once per opened task.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (planConfirmed) return;
    if (seededFor.current === target.plan.taskId) return;
    seededFor.current = target.plan.taskId;
    requestSidecarOpen('side');
    seedPrompt(
      `The user just opened the task "${target.plan.taskTitle}" on the dashboard. Your page state has the proposed steps. ` +
        `In a brief message: restate what the task is in one line, list the steps you'll take to complete it, then ask whether it looks right or if any steps should be added or removed. ` +
        `Do NOT call any tool yet — wait for their answer. When they approve, call update_task_steps with the full step list and confirm=true; if they want changes, call it with the revised list (confirm=true only once they're happy).`,
      { mode: 'side', hidden: true },
    );
  }, [planConfirmed, target.plan.taskId, target.plan.taskTitle, requestSidecarOpen, seedPrompt]);

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-600 shadow-sm dark:bg-violet-900/40 dark:text-violet-300">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            </span>
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Steps to complete
              </h2>
              <p className="mt-0.5 truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
                {target.plan.taskTitle}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close plan"
            className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="mt-2 flex items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-500">
          {doneCount} of {steps.length} done
          {draftingCount > 0 && (
            <span className="inline-flex items-center gap-1 text-violet-500 dark:text-violet-400">
              <Spinner />
              AI drafting {draftingCount} {draftingCount === 1 ? 'step' : 'steps'}…
            </span>
          )}
        </p>

        {!planConfirmed && (
          <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2.5 dark:border-violet-900/40 dark:bg-violet-950/30">
            <p className="text-[11px] text-violet-700 dark:text-violet-300">
              Review the steps below. Tell the assistant to add or remove any — or start once they look right.
            </p>
            <button
              type="button"
              onClick={confirmPlan}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-violet-700"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Looks good — start
            </button>
          </div>
        )}

        <ol className="mt-3 flex flex-col gap-2">
          {steps.map((s, i) => (
            <StepRow
              key={s.id}
              step={s}
              index={i}
              active={s.id === activeStepId}
              drafting={draftingStepIds.has(s.id)}
              onActivate={() => setActiveStep(s.id)}
              onToggle={() => toggleStepDone(s.id)}
            />
          ))}
        </ol>

        <div className="mt-3 border-t border-zinc-100 pt-2 dark:border-zinc-800">
          <Link
            href={`/organizer/tasks/${target.plan.taskId}/workspace`}
            className="text-[11px] text-zinc-500 hover:text-indigo-600 hover:underline dark:text-zinc-400 dark:hover:text-indigo-400"
          >
            Open full workspace ↗
          </Link>
        </div>
      </section>
    </div>
  );
}

function StepRow({
  step,
  index,
  active,
  drafting,
  onActivate,
  onToggle,
}: {
  step: TaskStep;
  index: number;
  active: boolean;
  drafting: boolean;
  onActivate: () => void;
  onToggle: () => void;
}) {
  const done = step.status === 'done';
  const aiAble = step.type !== 'manual';
  const ready = aiAble && !drafting && !!step.draft?.body;
  return (
    <li
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 transition-colors ${
        active
          ? 'border-violet-300 bg-violet-50 dark:border-violet-700 dark:bg-violet-950/30'
          : 'border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900'
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={done ? 'Mark step not done' : 'Mark step done'}
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
          done
            ? 'border-emerald-500 bg-emerald-500 text-white'
            : 'border-zinc-300 bg-white dark:border-zinc-600 dark:bg-zinc-900'
        }`}
      >
        {done && (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </button>
      <button type="button" onClick={onActivate} className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-2">
          <span className="text-[10px] font-medium text-zinc-400">{index + 1}.</span>
          <span className={`truncate text-sm ${done ? 'text-zinc-400 line-through dark:text-zinc-500' : 'text-zinc-800 dark:text-zinc-200'}`}>
            {step.title}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className={`inline-block rounded-full px-1.5 text-[10px] font-medium ${TYPE_TONE[step.type]}`}>
            {TYPE_LABEL[step.type]}
          </span>
          {drafting && (
            <span className="inline-flex items-center gap-1 text-[10px] text-violet-500 dark:text-violet-400">
              <Spinner />
              Drafting…
            </span>
          )}
          {ready && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Draft ready
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function Spinner() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" className="animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
    </svg>
  );
}
