import 'server-only';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  tasks,
  taskLinks,
  taskArtifacts,
  contacts,
  notes,
  appointments,
  inboxMessages,
  textMessages,
} from '@/db/schema/schema';
import {
  TASK_LINK_TYPES,
  type LinkableEntityOption,
  type LinkedTask,
  type ResolvedTaskLink,
  type TaskContextPack,
  type TaskLinkEntityType,
} from './types';

const PICKER_LIMIT = 25;

/** Max characters of any single linked body folded into a context pack — keeps
 *  the whole pack within a few hundred tokens so it fits in the system prompt. */
const PACK_BODY_LIMIT = 800;

function clamp(s: string | null | undefined, n = PACK_BODY_LIMIT): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function snippet(s: string | null | undefined, n = 70): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Contact ids stored on the task's assigned_to_contacts json array. */
async function getTaskContactIds(orgId: string, taskId: string): Promise<string[]> {
  const [row] = await db
    .select({ assigned: tasks.assignedToContacts })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, orgId)))
    .limit(1);
  const raw = row?.assigned;
  return Array.isArray(raw) ? (raw as unknown[]).filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Resolve every link on a task (contacts from assigned_to_contacts + the four
 * task_links types) into display-ready rows, grouped/ordered by type.
 */
export async function getTaskLinks(orgId: string, taskId: string): Promise<ResolvedTaskLink[]> {
  const [contactIds, linkRows] = await Promise.all([
    getTaskContactIds(orgId, taskId),
    db
      .select({ entityType: taskLinks.entityType, entityId: taskLinks.entityId })
      .from(taskLinks)
      .where(and(eq(taskLinks.organizationId, orgId), eq(taskLinks.taskId, taskId)))
      .orderBy(asc(taskLinks.createdAt)),
  ]);

  // Bucket task_links ids by type, preserving order.
  const idsByType: Record<TaskLinkEntityType, string[]> = {
    contact: contactIds,
    note: [],
    appointment: [],
    inbox_message: [],
    text_message: [],
  };
  for (const r of linkRows) {
    if (r.entityType in idsByType) idsByType[r.entityType as TaskLinkEntityType].push(r.entityId);
  }

  // Build label maps per type (only query tables we have ids for).
  const labels = new Map<string, { label: string; sublabel: string | null }>(); // key = `${type}:${id}`
  const key = (t: TaskLinkEntityType, id: string) => `${t}:${id}`;

  const jobs: Promise<void>[] = [];
  if (idsByType.contact.length) {
    jobs.push(
      db
        .select({ id: contacts.id, name: contacts.contactName, company: contacts.companyName })
        .from(contacts)
        .where(and(eq(contacts.organizationId, orgId), inArray(contacts.id, idsByType.contact)))
        .then((rows) => {
          for (const r of rows) labels.set(key('contact', r.id), { label: r.company ?? r.name, sublabel: r.company ? r.name : null });
        }),
    );
  }
  if (idsByType.note.length) {
    jobs.push(
      db
        .select({ id: notes.id, body: notes.body })
        .from(notes)
        .where(and(eq(notes.organizationId, orgId), inArray(notes.id, idsByType.note)))
        .then((rows) => {
          for (const r of rows) labels.set(key('note', r.id), { label: snippet(r.body) || 'Note', sublabel: null });
        }),
    );
  }
  if (idsByType.appointment.length) {
    jobs.push(
      db
        .select({ id: appointments.id, title: appointments.title, startsAt: appointments.startsAt })
        .from(appointments)
        .where(and(eq(appointments.organizationId, orgId), inArray(appointments.id, idsByType.appointment)))
        .then((rows) => {
          for (const r of rows) labels.set(key('appointment', r.id), { label: r.title, sublabel: r.startsAt });
        }),
    );
  }
  if (idsByType.inbox_message.length) {
    jobs.push(
      db
        .select({ id: inboxMessages.id, subject: inboxMessages.subject, fromName: inboxMessages.fromName, fromAddress: inboxMessages.fromAddress })
        .from(inboxMessages)
        .where(and(eq(inboxMessages.organizationId, orgId), inArray(inboxMessages.id, idsByType.inbox_message)))
        .then((rows) => {
          for (const r of rows) labels.set(key('inbox_message', r.id), { label: r.subject || '(no subject)', sublabel: r.fromName ?? r.fromAddress });
        }),
    );
  }
  if (idsByType.text_message.length) {
    jobs.push(
      db
        .select({ id: textMessages.id, body: textMessages.body, direction: textMessages.direction })
        .from(textMessages)
        .where(and(eq(textMessages.organizationId, orgId), inArray(textMessages.id, idsByType.text_message)))
        .then((rows) => {
          for (const r of rows) labels.set(key('text_message', r.id), { label: snippet(r.body) || 'Text', sublabel: r.direction });
        }),
    );
  }
  await Promise.all(jobs);

  const result: ResolvedTaskLink[] = [];
  for (const type of TASK_LINK_TYPES) {
    for (const id of idsByType[type]) {
      const meta = labels.get(key(type, id));
      // Skip links whose target was deleted (no label resolved).
      if (!meta) continue;
      result.push({ type, id, label: meta.label, sublabel: meta.sublabel });
    }
  }
  return result;
}

/**
 * Resolve a task's full grounding context — the task itself plus the actual
 * bodies of everything linked to it (contacts, notes, emails, texts, meetings).
 * Feeds the Task Workspace so the AI drafts from real data, not just the title.
 *
 * Returns null if the task doesn't exist in the org. Bodies are clamped to
 * PACK_BODY_LIMIT chars each; links whose target was deleted are dropped.
 */
export async function getTaskContextPack(
  orgId: string,
  taskId: string,
): Promise<TaskContextPack | null> {
  const [taskRow] = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      dueDate: tasks.dueDate,
      priority: tasks.priority,
      module: tasks.module,
      assigned: tasks.assignedToContacts,
    })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, orgId)))
    .limit(1);
  if (!taskRow) return null;

  const contactIds = Array.isArray(taskRow.assigned)
    ? (taskRow.assigned as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  const linkRows = await db
    .select({ entityType: taskLinks.entityType, entityId: taskLinks.entityId })
    .from(taskLinks)
    .where(and(eq(taskLinks.organizationId, orgId), eq(taskLinks.taskId, taskId)))
    .orderBy(asc(taskLinks.createdAt));

  const idsByType: Record<Exclude<TaskLinkEntityType, 'contact'>, string[]> = {
    note: [],
    appointment: [],
    inbox_message: [],
    text_message: [],
  };
  for (const r of linkRows) {
    if (r.entityType !== 'contact' && r.entityType in idsByType) {
      idsByType[r.entityType as Exclude<TaskLinkEntityType, 'contact'>].push(r.entityId);
    }
  }

  const pack: TaskContextPack = {
    task: {
      id: taskRow.id,
      title: taskRow.title,
      description: taskRow.description,
      dueDate: taskRow.dueDate,
      priority: taskRow.priority,
      module: taskRow.module,
    },
    contacts: [],
    notes: [],
    emails: [],
    texts: [],
    meetings: [],
  };

  const jobs: Promise<void>[] = [];
  if (contactIds.length) {
    jobs.push(
      db
        .select({ id: contacts.id, name: contacts.contactName, company: contacts.companyName, email: contacts.email, phone: contacts.phone })
        .from(contacts)
        .where(and(eq(contacts.organizationId, orgId), inArray(contacts.id, contactIds)))
        .then((rows) => {
          pack.contacts = rows.map((r) => ({ id: r.id, name: r.name, company: r.company, email: r.email, phone: r.phone }));
        }),
    );
  }
  if (idsByType.note.length) {
    jobs.push(
      db
        .select({ id: notes.id, body: notes.body, createdAt: notes.createdAt })
        .from(notes)
        .where(and(eq(notes.organizationId, orgId), inArray(notes.id, idsByType.note)))
        .then((rows) => {
          pack.notes = rows.map((r) => ({ id: r.id, body: clamp(r.body), createdAt: r.createdAt }));
        }),
    );
  }
  if (idsByType.inbox_message.length) {
    jobs.push(
      db
        .select({ id: inboxMessages.id, subject: inboxMessages.subject, fromName: inboxMessages.fromName, fromAddress: inboxMessages.fromAddress, body: inboxMessages.body, receivedAt: inboxMessages.receivedAt })
        .from(inboxMessages)
        .where(and(eq(inboxMessages.organizationId, orgId), inArray(inboxMessages.id, idsByType.inbox_message)))
        .then((rows) => {
          pack.emails = rows.map((r) => ({ id: r.id, subject: r.subject, from: r.fromName ?? r.fromAddress, body: clamp(r.body), receivedAt: r.receivedAt }));
        }),
    );
  }
  if (idsByType.text_message.length) {
    jobs.push(
      db
        .select({ id: textMessages.id, body: textMessages.body, direction: textMessages.direction, createdAt: textMessages.createdAt })
        .from(textMessages)
        .where(and(eq(textMessages.organizationId, orgId), inArray(textMessages.id, idsByType.text_message)))
        .then((rows) => {
          pack.texts = rows.map((r) => ({ id: r.id, body: clamp(r.body), direction: r.direction, createdAt: r.createdAt }));
        }),
    );
  }
  if (idsByType.appointment.length) {
    jobs.push(
      db
        .select({ id: appointments.id, title: appointments.title, description: appointments.description, startsAt: appointments.startsAt, location: appointments.location })
        .from(appointments)
        .where(and(eq(appointments.organizationId, orgId), inArray(appointments.id, idsByType.appointment)))
        .then((rows) => {
          pack.meetings = rows.map((r) => ({ id: r.id, title: r.title, description: r.description ? clamp(r.description) : null, startsAt: r.startsAt, location: r.location }));
        }),
    );
  }
  await Promise.all(jobs);

  return pack;
}

export interface SavedTaskArtifact {
  kind: string;
  title: string;
  body: string;
}

/** The saved draft for a task's workspace canvas, or null if none yet. */
export async function getTaskArtifact(orgId: string, taskId: string): Promise<SavedTaskArtifact | null> {
  if (!taskId) return null;
  const [row] = await db
    .select({ kind: taskArtifacts.kind, title: taskArtifacts.title, body: taskArtifacts.body })
    .from(taskArtifacts)
    .where(and(eq(taskArtifacts.organizationId, orgId), eq(taskArtifacts.taskId, taskId)))
    .limit(1);
  return row ?? null;
}

/** Tasks linked to a given entity (reverse direction). Open tasks first. */
export async function getLinkedTasksFor(
  orgId: string,
  entityType: TaskLinkEntityType,
  entityId: string,
): Promise<LinkedTask[]> {
  const order = [sql`${tasks.status} = 'DONE'`, sql`${tasks.dueDate} IS NULL`, asc(tasks.dueDate), desc(tasks.createdAt)] as const;
  const cols = { id: tasks.id, title: tasks.title, status: tasks.status, dueDate: tasks.dueDate, priority: tasks.priority };

  if (entityType === 'contact') {
    return db
      .select(cols)
      .from(tasks)
      .where(and(eq(tasks.organizationId, orgId), sql`${tasks.assignedToContacts}::jsonb @> ${JSON.stringify([entityId])}::jsonb`))
      .orderBy(...order)
      .limit(50);
  }

  return db
    .select(cols)
    .from(tasks)
    .innerJoin(taskLinks, eq(taskLinks.taskId, tasks.id))
    .where(and(eq(taskLinks.organizationId, orgId), eq(taskLinks.entityType, entityType), eq(taskLinks.entityId, entityId)))
    .orderBy(...order)
    .limit(50);
}

/**
 * How many tasks link to each of the given entities — for the "🔗 N" badges on
 * note / appointment / text rows. Only supports task_links-backed types.
 */
export async function linkedTaskCounts(
  orgId: string,
  entityType: Exclude<TaskLinkEntityType, 'contact'>,
  ids: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({ entityId: taskLinks.entityId, n: sql<number>`count(distinct ${taskLinks.taskId})::int` })
    .from(taskLinks)
    .where(and(eq(taskLinks.organizationId, orgId), eq(taskLinks.entityType, entityType), inArray(taskLinks.entityId, ids)))
    .groupBy(taskLinks.entityId);
  for (const r of rows) map.set(r.entityId, Number(r.n) || 0);
  return map;
}

/**
 * Options for the "add link" picker. `userId` null = no user filter (demo org
 * is shared); matches the dashboard's `userScope = demo ? undefined : userId`.
 */
export async function listLinkableEntities(
  orgId: string,
  type: TaskLinkEntityType,
  userId: string | null,
  query?: string,
): Promise<LinkableEntityOption[]> {
  const q = query?.trim().toLowerCase();
  const like = q ? `%${q}%` : null;

  switch (type) {
    case 'contact': {
      const rows = await db
        .select({ id: contacts.id, name: contacts.contactName, company: contacts.companyName })
        .from(contacts)
        .where(
          and(
            eq(contacts.organizationId, orgId),
            eq(contacts.isActive, true),
            like ? sql`lower(${contacts.contactName}) like ${like}` : undefined,
          ),
        )
        .orderBy(asc(contacts.contactName))
        .limit(PICKER_LIMIT);
      return rows.map((r) => ({ id: r.id, label: r.company ?? r.name, sublabel: r.company ? r.name : null }));
    }
    case 'note': {
      const rows = await db
        .select({ id: notes.id, body: notes.body, createdAt: notes.createdAt })
        .from(notes)
        .where(
          and(
            eq(notes.organizationId, orgId),
            userId ? eq(notes.userId, userId) : undefined,
            like ? sql`lower(${notes.body}) like ${like}` : undefined,
          ),
        )
        .orderBy(desc(notes.createdAt))
        .limit(PICKER_LIMIT);
      return rows.map((r) => ({ id: r.id, label: snippet(r.body) || 'Note', sublabel: null }));
    }
    case 'appointment': {
      const rows = await db
        .select({ id: appointments.id, title: appointments.title, startsAt: appointments.startsAt })
        .from(appointments)
        .where(
          and(
            eq(appointments.organizationId, orgId),
            userId ? eq(appointments.userId, userId) : undefined,
            like ? sql`lower(${appointments.title}) like ${like}` : undefined,
          ),
        )
        .orderBy(desc(appointments.startsAt))
        .limit(PICKER_LIMIT);
      return rows.map((r) => ({ id: r.id, label: r.title, sublabel: r.startsAt }));
    }
    case 'inbox_message': {
      const rows = await db
        .select({ id: inboxMessages.id, subject: inboxMessages.subject, fromName: inboxMessages.fromName, fromAddress: inboxMessages.fromAddress, receivedAt: inboxMessages.receivedAt })
        .from(inboxMessages)
        .where(
          and(
            eq(inboxMessages.organizationId, orgId),
            userId ? eq(inboxMessages.userId, userId) : undefined,
            like ? sql`(lower(${inboxMessages.subject}) like ${like} or lower(${inboxMessages.fromAddress}) like ${like})` : undefined,
          ),
        )
        .orderBy(desc(inboxMessages.receivedAt))
        .limit(PICKER_LIMIT);
      return rows.map((r) => ({ id: r.id, label: r.subject || '(no subject)', sublabel: r.fromName ?? r.fromAddress }));
    }
    case 'text_message': {
      // text_messages are org-scoped (no user column).
      const rows = await db
        .select({ id: textMessages.id, body: textMessages.body, direction: textMessages.direction, createdAt: textMessages.createdAt })
        .from(textMessages)
        .where(and(eq(textMessages.organizationId, orgId), like ? sql`lower(${textMessages.body}) like ${like}` : undefined))
        .orderBy(desc(textMessages.createdAt))
        .limit(PICKER_LIMIT);
      return rows.map((r) => ({ id: r.id, label: snippet(r.body) || 'Text', sublabel: r.direction }));
    }
    default:
      return [];
  }
}

/** Validate that an entity exists in the org (used before creating a link). */
export async function entityExistsInOrg(orgId: string, type: TaskLinkEntityType, entityId: string): Promise<boolean> {
  const table = {
    contact: contacts,
    note: notes,
    appointment: appointments,
    inbox_message: inboxMessages,
    text_message: textMessages,
  }[type];
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, entityId), eq(table.organizationId, orgId)))
    .limit(1);
  return !!row;
}
