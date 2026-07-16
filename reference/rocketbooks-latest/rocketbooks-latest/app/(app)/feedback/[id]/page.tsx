import Link from 'next/link';
import { notFound } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { feedbackReports, feedbackReportComments } from '@/db/schema/feedback';
import { users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { isSuperAdmin } from '@/lib/auth/org';
import { addFeedbackCommentAction } from '@/app/(app)/feedback/_actions/feedback';
import { CommentForm } from '@/app/(super-admin)/super-admin/feedback/_components/CommentForm';
import {
  statusLabel,
  statusTone,
  kindLabel,
  kindTone,
  type FeedbackStatus,
  type FeedbackKindStr,
} from '@/app/(super-admin)/super-admin/feedback/_components/labels';

export const dynamic = 'force-dynamic';

function Badge({
  tone,
  children,
}: {
  tone: 'green' | 'amber' | 'red' | 'blue' | 'zinc';
  children: React.ReactNode;
}) {
  const map = {
    green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
    red: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
    blue: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
    zinc: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300',
  } as const;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${map[tone]}`}>
      {children}
    </span>
  );
}

export default async function MyFeedbackDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await params;
  const admin = await isSuperAdmin();

  const [report] = await db
    .select()
    .from(feedbackReports)
    .where(eq(feedbackReports.id, id))
    .limit(1);

  if (!report) notFound();
  // Reporters can only see their own; super admins should use the super-admin
  // detail page (which has the status changer). Send them there.
  if (report.reporterUserId !== user.id) {
    if (admin) {
      const { redirect } = await import('next/navigation');
      redirect(`/super-admin/feedback/${id}`);
    }
    notFound();
  }

  const comments = await db
    .select({
      id: feedbackReportComments.id,
      body: feedbackReportComments.body,
      isAdmin: feedbackReportComments.isAdmin,
      createdAt: feedbackReportComments.createdAt,
      authorEmail: users.email,
      authorName: users.fullName,
    })
    .from(feedbackReportComments)
    .leftJoin(users, eq(feedbackReportComments.authorUserId, users.id))
    .where(eq(feedbackReportComments.reportId, id))
    .orderBy(asc(feedbackReportComments.createdAt));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <nav className="text-sm">
        <Link href="/feedback" className="text-blue-600 hover:underline dark:text-blue-400">
          ← All my feedback
        </Link>
      </nav>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={kindTone(report.kind as FeedbackKindStr)}>{kindLabel(report.kind as FeedbackKindStr)}</Badge>
          <Badge tone={statusTone(report.status as FeedbackStatus)}>{statusLabel(report.status as FeedbackStatus)}</Badge>
          <span className="text-xs text-zinc-500">
            Submitted {report.createdAt ? new Date(report.createdAt).toLocaleString() : ''}
          </span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{report.title}</h1>
      </header>

      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <p className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{report.description}</p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Activity ({comments.length})
        </h2>
        {comments.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-800">
            No replies yet. An admin will follow up here.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {comments.map((c) => (
              <li
                key={c.id}
                className={`rounded-md border p-3 ${
                  c.isAdmin
                    ? 'border-blue-200 bg-blue-50/40 dark:border-blue-900 dark:bg-blue-950/20'
                    : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950'
                }`}
              >
                <div className="mb-1 flex items-center justify-between gap-3 text-xs text-zinc-500">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    {c.isAdmin ? 'Admin' : (c.authorName ?? c.authorEmail ?? 'You')}
                  </span>
                  <span className="tabular-nums">{c.createdAt ? new Date(c.createdAt).toLocaleString() : ''}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{c.body}</p>
              </li>
            ))}
          </ul>
        )}

        <CommentForm reportId={report.id} action={addFeedbackCommentAction} placeholder="Add a follow-up…" />
      </section>
    </div>
  );
}
