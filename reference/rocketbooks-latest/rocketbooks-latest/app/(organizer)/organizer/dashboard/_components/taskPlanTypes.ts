/**
 * Shared types for the dashboard task step-plan flip. Kept in a plain module
 * (not the 'use server' action, which may only export async functions, and not
 * a 'use client' component) so both server and client can import them.
 */

/** What kind of work a single step is — drives which runner the right card shows. */
export type TaskStepType = 'document' | 'email' | 'text' | 'manual';

/** The artifact kind a `document` step seeds the canvas with. */
export type StepDocKind = 'letter' | 'email' | 'text' | 'resolution' | 'deck';

export interface TaskStep {
  id: string;
  title: string;
  type: TaskStepType;
  status: 'open' | 'done';
  /** For document steps: the canvas kind to start in (letter/resolution/deck/…). */
  docKind?: StepDocKind;
  /** AI-generated draft for this step, persisted in the plan so reopening is
   *  instant (no re-draft). Documents/emails/texts only; manual steps have none. */
  draft?: { title?: string; body: string };
}

/** Recipient resolved from the task's linked contacts, for email/text steps. */
export interface TaskPlanContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

/**
 * Everything the flipped card needs to render the checklist (left) and run the
 * active step (right) without further round-trips. Returned by getTaskPlan.
 */
export interface TaskPlanData {
  ok: boolean;
  taskId: string;
  taskTitle: string;
  /** Whether the user has reviewed + confirmed the step plan. Until true, the
   *  AI reviews the plan and auto-drafting is held off. First-confirm sticks. */
  confirmed: boolean;
  steps: TaskStep[];
  /** Recipient for email/text steps (first linked contact), if any. */
  contact: TaskPlanContact | null;
  /** The user's first name, so the assistant can address them personally. */
  userFirstName: string | null;
  /** Canvas bootstrap (document steps) — mirrors the full Task Workspace. */
  grounding: Record<string, unknown>;
  initialArtifact: { kind: string; title: string; body: string } | null;
  branding: import('@/lib/documents/layout').DocBranding;
  error?: string;
}
