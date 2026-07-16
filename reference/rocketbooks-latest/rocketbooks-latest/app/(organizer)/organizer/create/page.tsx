import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { getOrgBranding } from '@/lib/documents/branding';
import { getDocument } from '@/lib/documents/store';
import { TaskWorkspaceClient } from '@/app/(organizer)/organizer/tasks/[id]/workspace/_components/TaskWorkspaceClient';
import { CreateOpener } from './_components/CreateOpener';

interface PageProps {
  searchParams?: Promise<{ doc?: string }>;
}

/**
 * The task-less "Create" workspace — same canvas as the task workspace, but not
 * tied to any task. The assistant greets the user and asks what to create, then
 * drafts it onto the canvas. Drafts autosave to the standalone documents store
 * (reopen via ?doc=<id> from the documents list).
 */
export default async function CreateWorkspacePage({ searchParams }: PageProps) {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();
  const docId = (await searchParams)?.doc ?? null;

  const [[me], branding, savedDoc] = await Promise.all([
    db.select({ fullName: users.fullName }).from(users).where(eq(users.id, userId)).limit(1),
    getOrgBranding(orgId),
    docId ? getDocument(orgId, docId) : Promise.resolve(null),
  ]);
  const firstName = (me?.fullName ?? '').trim().split(/\s+/)[0] ?? '';

  return (
    <div className="flex flex-col gap-4">
      <CreateOpener firstName={firstName} hasDraft={!!savedDoc} />

      <section className="relative overflow-hidden rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-indigo-50 via-white to-white p-5 shadow-sm dark:border-indigo-900/40 dark:from-indigo-950/30 dark:via-zinc-900 dark:to-zinc-900">
        <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-indigo-400/10 blur-2xl dark:bg-indigo-500/10" aria-hidden="true" />
        <div className="relative flex items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 shadow-sm dark:bg-indigo-900/40 dark:text-indigo-300">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-indigo-700/80 dark:text-indigo-300/80">
            Create
          </h2>
        </div>
        <h1 className="relative mt-3 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          What are we creating?
        </h1>
        <div className="relative mt-1 flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
          <span>The assistant will draft it onto the canvas below.</span>
          <Link href="/organizer/dashboard" className="hover:underline">
            ← Back to dashboard
          </Link>
        </div>
      </section>

      <TaskWorkspaceClient
        taskId={null}
        persistDocument
        initialDocumentId={savedDoc?.id ?? null}
        pageTitle="Create"
        route="/organizer/create"
        grounding={{ surface: 'create', note: 'No task is attached — the user is creating an ad-hoc document that autosaves to their documents.' }}
        initialArtifact={savedDoc ? { kind: savedDoc.kind, title: savedDoc.title, body: savedDoc.body } : null}
        branding={branding}
      />
    </div>
  );
}
