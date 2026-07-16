'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ThreadEntry } from './FlipThread';
import type { AppointmentContext } from '../../calendar/types';
import type { TaskPlanData, TaskStep } from './taskPlanTypes';
import { setTaskSteps, draftStep, confirmTaskPlan } from '../_actions/taskPlan';

/**
 * Which steps draft automatically on confirm. Email/text only: they're narrow
 * and well-grounded in the task context. Document steps are NOT auto-drafted —
 * the AI interviews the user about the document's particulars first, then
 * generates it on the canvas (see TaskStepRunner). Manual steps never draft.
 */
function isAutoDraftable(s: TaskStep): boolean {
  return (s.type === 'email' || s.type === 'text') && !s.draft?.body;
}

interface TextMessageRow {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  createdAt: string;
}

/**
 * Shared client state that lets the left-column cards (Inbox Issues, Texts)
 * drive the Open Tasks card on the right: clicking an inbox email or a text
 * selects it here, and the Open Tasks card flips around to show the matching
 * reply editor. Both sides are server-rendered siblings, so this provider
 * wraps the whole grid to give them a common client context.
 */

export interface FlipEmail {
  kind: 'email';
  id: string;
  subject: string | null;
  fromAddress: string;
  fromName: string | null;
  contactName: string | null;
  body: string;
}

export interface FlipText {
  kind: 'text';
  id: string;
  contactId: string | null;
  contactName: string | null;
  fromPhone: string;
  body: string;
}

export interface FlipAppointment {
  kind: 'appointment';
  id: string;
  title: string;
}

/**
 * A "compose a new message for this task" target. Unlike FlipEmail/FlipText
 * (which reply to an existing message thread), this opens a fresh compose
 * editor pre-addressed from the task's linked contact. Channel + recipient are
 * resolved server-side (AI-classified) before the flip.
 */
export interface FlipCompose {
  kind: 'compose';
  channel: 'email' | 'text';
  taskId: string;
  taskTitle: string;
  contactId: string | null;
  contactName: string | null;
  /** Recipient address/number for display + (text) sending. */
  to: string | null;
  /** Suggested email subject (email only). */
  subject: string | null;
  /** Short AI note on what the task asks. */
  note: string | null;
  /** Pre-filled body from the step's auto-draft (so the editor opens ready). */
  initialBody?: string;
}

/**
 * A multi-step task plan. Clicking a task resolves its plan (AI-decomposed,
 * persisted in tasks.subitems) and flips BOTH columns: the left column shows
 * the step checklist, the right card runs the active step (canvas for document
 * steps, compose editor for email/text, mark-done for manual).
 */
export interface FlipTaskPlan {
  kind: 'task-plan';
  plan: TaskPlanData;
}

export type FlipTarget = FlipEmail | FlipText | FlipAppointment | FlipCompose | FlipTaskPlan;

interface CardFlip {
  target: FlipTarget | null;
  /** When true (and a target is set), the left column flips to the conversation thread. */
  historyOpen: boolean;
  /** The selected message's conversation, chronological. Loaded once per selection. */
  thread: ThreadEntry[];
  threadLoading: boolean;
  threadError: string | null;
  /** Most recent message in the thread (shown in the reply editor for context). */
  lastMessage: ThreadEntry | null;
  /** When an appointment is selected, its purpose/notes/tasks/emails/texts. */
  apptContext: AppointmentContext | null;
  apptLoading: boolean;
  apptError: string | null;
  /** Re-fetch the selected appointment's context (e.g. after linking a contact). */
  refreshAppt: () => void;
  /** Task-plan flip state (only meaningful when target.kind === 'task-plan'). */
  planSteps: TaskStep[];
  activeStepId: string | null;
  setActiveStep: (stepId: string) => void;
  /** Toggle a step's done/open status; persists to the task's subitems. */
  toggleStepDone: (stepId: string) => void;
  /** Step ids currently being AI-drafted (show a spinner on the checklist row). */
  draftingStepIds: Set<string>;
  /** Whether the open task plan has been confirmed (gates drafting + step work). */
  planConfirmed: boolean;
  /** Confirm the plan (button path) — persists + flips drafting on. */
  confirmPlan: () => void;
  /** Apply an AI-driven plan edit (from the update_task_steps tool result). */
  applyPlanUpdate: (update: { steps: TaskStep[]; confirmed: boolean }) => void;
  open: (target: FlipTarget) => void;
  close: () => void;
  toggleHistory: () => void;
}

const Ctx = createContext<CardFlip | null>(null);

export function CardFlipProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<FlipTarget | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [thread, setThread] = useState<ThreadEntry[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [apptContext, setApptContext] = useState<AppointmentContext | null>(null);
  const [apptLoading, setApptLoading] = useState(false);
  const [apptError, setApptError] = useState<string | null>(null);
  // Bumped to force a re-fetch of the current appointment without changing the
  // selection (used after linking a contact, so the related items appear).
  const [apptRefreshTick, setApptRefreshTick] = useState(0);
  const refreshAppt = useCallback(() => setApptRefreshTick((t) => t + 1), []);

  // Task-plan flip: local, editable copy of the steps + which one is active.
  // Seeded from the target when a task-plan opens; mutations persist to the
  // task's subitems (best-effort) and stay in sync here for instant UI.
  const [planSteps, setPlanSteps] = useState<TaskStep[]>([]);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [planTaskId, setPlanTaskId] = useState<string | null>(null);
  const [draftingStepIds, setDraftingStepIds] = useState<Set<string>>(new Set());
  const [planConfirmed, setPlanConfirmed] = useState(false);
  // Mirror of planSteps so the auto-draft effect can read the current steps
  // without depending on planSteps (which would re-fire it on every draft).
  const planStepsRef = useRef<TaskStep[]>([]);
  useEffect(() => {
    planStepsRef.current = planSteps;
  }, [planSteps]);

  const open = useCallback((t: FlipTarget) => {
    setTarget(t);
    // Each new selection starts with the thread closed; the row's history icon opens it.
    setHistoryOpen(false);
    if (t.kind === 'task-plan') {
      setPlanSteps(t.plan.steps);
      setPlanTaskId(t.plan.taskId);
      setPlanConfirmed(t.plan.confirmed);
      // Start on the first still-open step, else the first step.
      const firstOpen = t.plan.steps.find((s) => s.status === 'open') ?? t.plan.steps[0] ?? null;
      setActiveStepId(firstOpen?.id ?? null);
      // Spinners only once the plan is confirmed — before that the AI is still
      // reviewing the plan, so we hold off drafting (effect below gates on it).
      setDraftingStepIds(
        t.plan.confirmed
          ? new Set(t.plan.steps.filter(isAutoDraftable).map((s) => s.id))
          : new Set(),
      );
    } else {
      setPlanSteps([]);
      setPlanTaskId(null);
      setActiveStepId(null);
      setDraftingStepIds(new Set());
      setPlanConfirmed(false);
    }
  }, []);
  const close = useCallback(() => {
    setTarget(null);
    setHistoryOpen(false);
    setPlanSteps([]);
    setActiveStepId(null);
    setPlanTaskId(null);
    setDraftingStepIds(new Set());
    setPlanConfirmed(false);
  }, []);

  // Confirm the plan (button path): persist, then flip drafting on by seeding
  // the spinner set for every still-undrafted AI-able step. The auto-draft
  // effect (keyed on planConfirmed) does the actual drafting.
  const confirmPlan = useCallback(() => {
    if (!planTaskId) return;
    setPlanConfirmed(true);
    setDraftingStepIds(new Set(planSteps.filter(isAutoDraftable).map((s) => s.id)));
    void confirmTaskPlan(planTaskId);
  }, [planTaskId, planSteps]);

  // Apply an AI plan edit (update_task_steps tool result). Replaces the steps;
  // if the AI confirmed in the same call, flip drafting on too.
  const applyPlanUpdate = useCallback(
    (update: { steps: TaskStep[]; confirmed: boolean }) => {
      setPlanSteps(update.steps);
      // Keep the active step valid; default to first open/first.
      setActiveStepId((prev) => (update.steps.some((s) => s.id === prev) ? prev : update.steps.find((s) => s.status === 'open')?.id ?? update.steps[0]?.id ?? null));
      if (update.confirmed) {
        setPlanConfirmed(true);
        setDraftingStepIds(new Set(update.steps.filter(isAutoDraftable).map((s) => s.id)));
      }
    },
    [],
  );

  const setActiveStep = useCallback((stepId: string) => setActiveStepId(stepId), []);

  const toggleStepDone = useCallback(
    (stepId: string) => {
      setPlanSteps((prev) => {
        const next = prev.map((s) => (s.id === stepId ? { ...s, status: s.status === 'done' ? ('open' as const) : ('done' as const) } : s));
        // Persist best-effort; UI already reflects the change.
        if (planTaskId) void setTaskSteps(planTaskId, next);
        return next;
      });
    },
    [planTaskId],
  );
  const toggleHistory = useCallback(() => setHistoryOpen((v) => !v), []);

  // Load the conversation thread once per selection. Both the left history
  // panel (full transcript) and the right reply editor (latest message) read
  // from this single fetch.
  useEffect(() => {
    if (!target || target.kind === 'appointment' || target.kind === 'compose' || target.kind === 'task-plan') {
      // Appointments, composes, and task plans don't have a message thread —
      // clear any leftover thread state. (Appointment context loads in the
      // effect below; compose/task-plan carry everything in the target.)
      setThread([]);
      setThreadLoading(false);
      setThreadError(null);
      return;
    }
    const who =
      target.kind === 'email'
        ? target.contactName ?? target.fromName ?? target.fromAddress
        : target.contactName ?? target.fromPhone;

    let cancelled = false;
    setThreadLoading(true);
    setThreadError(null);
    setThread([]);

    const load = async (): Promise<ThreadEntry[]> => {
      if (target.kind === 'email') {
        const res = await fetch(`/api/inbox/${encodeURIComponent(target.id)}/thread`);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        return Array.isArray(data.entries) ? (data.entries as ThreadEntry[]) : [];
      }
      if (!target.contactId) return [];
      const res = await fetch(`/api/texts/${encodeURIComponent(target.contactId)}/messages`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const rows: TextMessageRow[] = Array.isArray(data.messages) ? data.messages : [];
      return rows.map((m) => ({
        id: m.id,
        direction: m.direction,
        who: m.direction === 'outbound' ? 'You' : who,
        at: m.createdAt,
        body: m.body,
      }));
    };

    load()
      .then((list) => {
        if (!cancelled) setThread(list);
      })
      .catch(() => {
        if (!cancelled) setThreadError('Couldn’t load the conversation.');
      })
      .finally(() => {
        if (!cancelled) setThreadLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [target]);

  // Load the appointment's related context once per selection. Mirrors the
  // calendar page's detail panel, hitting the same endpoint.
  useEffect(() => {
    if (!target || target.kind !== 'appointment') {
      setApptContext(null);
      setApptLoading(false);
      setApptError(null);
      return;
    }
    const id = target.id;
    let cancelled = false;
    setApptContext(null);
    setApptError(null);
    setApptLoading(true);
    fetch(`/api/organizer/appointments/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as AppointmentContext;
      })
      .then((data) => {
        // Guard against a stale response if the user clicked another event
        // while this request was in flight.
        if (!cancelled) setApptContext((prev) => (prev && prev.appointment.id !== id ? prev : data));
      })
      .catch(() => {
        if (!cancelled) setApptError('Could not load appointment details.');
      })
      .finally(() => {
        if (!cancelled) setApptLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target, apptRefreshTick]);

  // Auto-draft AI-able steps — but ONLY after the plan is confirmed (before
  // that the AI is reviewing the plan with the user). Fires one draftStep per
  // undrafted step IN PARALLEL; each resolves independently → spinner clears
  // and its draft drops into planSteps. Drafts persist server-side, so a
  // confirmed task reopens with everything already drafted (no re-run).
  //
  // Keyed on (planTaskId, planConfirmed): it runs when a confirmed task opens,
  // and when an unconfirmed task gets confirmed. We snapshot the to-draft list
  // from the steps at fire time and guard each call so a status toggle (which
  // also mutates planSteps) can't re-trigger drafting.
  useEffect(() => {
    if (!planTaskId || !planConfirmed) return;
    const taskId = planTaskId;
    let cancelled = false;
    // Read current steps from the ref so this effect doesn't depend on
    // planSteps (which would re-fire it on every draft landing).
    const todo = planStepsRef.current.filter(isAutoDraftable);
    if (todo.length === 0) return;

    for (const step of todo) {
      void draftStep(taskId, step.id)
        .then((r) => {
          if (cancelled) return;
          if (r.ok && r.draft) {
            setPlanSteps((prev) => prev.map((s) => (s.id === step.id ? { ...s, draft: r.draft } : s)));
          }
        })
        .finally(() => {
          if (cancelled) return;
          setDraftingStepIds((prev) => {
            const next = new Set(prev);
            next.delete(step.id);
            return next;
          });
        });
    }

    return () => {
      cancelled = true;
    };
  }, [planTaskId, planConfirmed]);

  const lastMessage = thread.length > 0 ? thread[thread.length - 1] : null;

  return (
    <Ctx.Provider
      value={{
        target,
        historyOpen,
        thread,
        threadLoading,
        threadError,
        lastMessage,
        apptContext,
        apptLoading,
        apptError,
        refreshAppt,
        planSteps,
        activeStepId,
        setActiveStep,
        toggleStepDone,
        draftingStepIds,
        planConfirmed,
        confirmPlan,
        applyPlanUpdate,
        open,
        close,
        toggleHistory,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useCardFlip(): CardFlip {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCardFlip must be used within CardFlipProvider');
  return ctx;
}
