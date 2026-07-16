/**
 * Task link entity types — the kinds of things an organizer task can be linked
 * to. Shared by the server queries, the server actions, the manual link UI, and
 * the AI tools so there's a single source of truth for the catalog.
 *
 * Storage note: 'contact' links live on `tasks.assigned_to_contacts` (a json
 * array, already wired into the AI tools / contact drill-in / dashboard company
 * filter). The other four live in the polymorphic `task_links` table. Callers
 * go through lib/task-links so this split stays an implementation detail.
 */

export type TaskLinkEntityType = 'contact' | 'note' | 'appointment' | 'inbox_message' | 'text_message';

/** The four types that live in the task_links table (everything except contact). */
export const TASK_LINK_TABLE_TYPES = ['note', 'appointment', 'inbox_message', 'text_message'] as const;

/** All linkable types, in display order. */
export const TASK_LINK_TYPES: TaskLinkEntityType[] = ['contact', 'note', 'appointment', 'inbox_message', 'text_message'];

export interface TaskLinkTypeMeta {
  type: TaskLinkEntityType;
  /** Singular label, e.g. "Meeting". */
  label: string;
  /** Plural label, e.g. "Meetings". */
  plural: string;
  /** Tailwind accent token used by the link chips (matches the nav palette). */
  accent: string;
  /** Where this type is stored. */
  store: 'task_links' | 'assigned_to_contacts';
}

export const TASK_LINK_META: Record<TaskLinkEntityType, TaskLinkTypeMeta> = {
  contact: { type: 'contact', label: 'Contact', plural: 'Contacts', accent: 'pink', store: 'assigned_to_contacts' },
  note: { type: 'note', label: 'Note', plural: 'Notes', accent: 'blue', store: 'task_links' },
  appointment: { type: 'appointment', label: 'Meeting', plural: 'Meetings', accent: 'sky', store: 'task_links' },
  inbox_message: { type: 'inbox_message', label: 'Email', plural: 'Emails', accent: 'amber', store: 'task_links' },
  text_message: { type: 'text_message', label: 'Text', plural: 'Texts', accent: 'emerald', store: 'task_links' },
};

export function isTaskLinkEntityType(s: string): s is TaskLinkEntityType {
  return s === 'contact' || s === 'note' || s === 'appointment' || s === 'inbox_message' || s === 'text_message';
}

/** A link resolved to a human-readable label for display. */
export interface ResolvedTaskLink {
  type: TaskLinkEntityType;
  id: string;
  label: string;
  sublabel: string | null;
}

/** An option offered in the "add link" picker. */
export interface LinkableEntityOption {
  id: string;
  label: string;
  sublabel: string | null;
}

/** A task linked to some entity (reverse direction). */
export interface LinkedTask {
  id: string;
  title: string;
  status: string;
  dueDate: string | null;
  priority: string | null;
}

/**
 * The full grounding context for a single task, used by the Task Workspace so
 * the AI can draft an artifact from real linked data (the right contact name,
 * the email it's replying to, the note that spawned the task) rather than from
 * the task title alone.
 *
 * Unlike [[ResolvedTaskLink]] (labels only, for chips), this carries the actual
 * bodies — capped per item so the whole pack stays within a few hundred tokens.
 */
export interface TaskContextPack {
  task: {
    id: string;
    title: string;
    description: string | null;
    dueDate: string | null;
    priority: string | null;
    module: string | null;
  };
  contacts: Array<{
    id: string;
    name: string;
    company: string | null;
    email: string | null;
    phone: string | null;
  }>;
  notes: Array<{ id: string; body: string; createdAt: string | null }>;
  emails: Array<{
    id: string;
    subject: string | null;
    from: string | null;
    body: string;
    receivedAt: string | null;
  }>;
  texts: Array<{ id: string; body: string; direction: string; createdAt: string | null }>;
  meetings: Array<{
    id: string;
    title: string;
    description: string | null;
    startsAt: string | null;
    location: string | null;
  }>;
}
