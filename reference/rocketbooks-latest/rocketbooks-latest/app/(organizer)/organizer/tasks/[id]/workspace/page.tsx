import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getTaskContextPack, getTaskArtifact } from '@/lib/task-links/queries';
import { getOrgBranding } from '@/lib/documents/branding';
import type { TaskContextPack } from '@/lib/task-links/types';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { tasks } from '@/db/schema/schema';
import { loadDebriefView } from '@/lib/meetings/debrief-view';
import { DebriefView } from '@/app/(organizer)/organizer/meetings/[id]/debrief/_components/DebriefView';
import { WorkspaceHeader } from './_components/WorkspaceHeader';
import { TaskWorkspaceClient } from './_components/TaskWorkspaceClient';
import { WorkspaceOpener } from './_components/WorkspaceOpener';

interface PageProps {
  params: Promise<{ id: string }>;
}

function snip(s: string | null | undefined, n = 200): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Server-side date math for the hero chip (kept out of the component so it
 *  stays pure). `now` is passed in so a single timestamp drives both values. */
function dueDisplay(due: string | null, now: number): { label: string | null; overdue: boolean } {
  if (!due) return { label: null, overdue: false };
  const dueMs = Date.parse(due);
  if (Number.isNaN(dueMs)) return { label: null, overdue: false };
  const diffDays = Math.floor((dueMs - now) / 86_400_000);
  const overdue = dueMs < now - 86_400_000;
  let label: string;
  if (diffDays < -1) label = `${Math.abs(diffDays)} days overdue`;
  else if (diffDays === -1) label = 'Overdue by 1 day';
  else if (diffDays === 0) label = 'Due today';
  else if (diffDays === 1) label = 'Due tomorrow';
  else if (diffDays <= 7) label = `Due in ${diffDays} days`;
  else label = new Date(dueMs).toLocaleDateString();
  return { label, overdue };
}

/** Compact, plain-data grounding payload for the assistant's page context.
 *  Trimmed so the whole thing stays within a few hundred tokens. */
function buildGrounding(pack: TaskContextPack): Record<string, unknown> {
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
    related_emails: pack.emails.slice(0, 4).map((e) => ({
      subject: e.subject,
      from: e.from,
      snippet: snip(e.body),
    })),
    related_texts: pack.texts.slice(0, 4).map((t) => ({ direction: t.direction, snippet: snip(t.body) })),
    related_meetings: pack.meetings.slice(0, 4).map((m) => ({
      title: m.title,
      when: m.startsAt,
      about: snip(m.description),
    })),
  };
}

export default async function TaskWorkspacePage({ params }: PageProps) {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const { id } = await params;

  // A meeting Call Debrief task renders a bespoke debrief view in the canvas
  // (left: summary/decisions/transcript · right: AI / you / others buckets)
  // instead of the default artifact editor.
  const [taskRow] = await db
    .select({
      title: tasks.title,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      entityType: tasks.entityType,
      entityId: tasks.entityId,
    })
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.organizationId, orgId)))
    .limit(1);

  if (taskRow?.entityType === 'meeting_debrief' && taskRow.entityId) {
    const [debrief, debriefBranding] = await Promise.all([
      loadDebriefView(orgId, taskRow.entityId),
      getOrgBranding(orgId),
    ]);
    if (debrief) {
      const d = dueDisplay(taskRow.dueDate, new Date().getTime());
      return (
        <div className="flex flex-col gap-4">
          <WorkspaceHeader title={taskRow.title} priority={taskRow.priority} dueLabel={d.label} isOverdue={d.overdue} />
          <DebriefView data={debrief} branding={debriefBranding} />
        </div>
      );
    }
  }

  const [pack, savedArtifact, branding] = await Promise.all([
    getTaskContextPack(orgId, id),
    getTaskArtifact(orgId, id),
    getOrgBranding(orgId),
  ]);
  if (!pack) notFound();

  const grounding = buildGrounding(pack);
  const due = dueDisplay(pack.task.dueDate, new Date().getTime());

  return (
    <div className="flex flex-col gap-4">
      <WorkspaceOpener taskTitle={pack.task.title} hasDraft={!!savedArtifact} />
      <WorkspaceHeader
        title={pack.task.title}
        priority={pack.task.priority}
        dueLabel={due.label}
        isOverdue={due.overdue}
      />
      <TaskWorkspaceClient
        taskId={pack.task.id}
        pageTitle={`Task Workspace — ${pack.task.title}`}
        route={`/organizer/tasks/${pack.task.id}/workspace`}
        grounding={grounding}
        initialArtifact={savedArtifact}
        branding={branding}
      />
    </div>
  );
}
