import Link from 'next/link';
import { notFound } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { feedbackReports, feedbackReportComments } from '@/db/schema/feedback';
import { users, organizations } from '@/db/schema/schema';
import { AdminPage, Panel, Badge } from '@/components/admin/AdminPage';
import {
  setFeedbackStatusAction,
  addFeedbackCommentAction,
} from '@/app/(app)/feedback/_actions/feedback';
import { CommentForm } from '../_components/CommentForm';
import {
  statusLabel,
  statusTone,
  kindLabel,
  kindTone,
  STATUS_OPTIONS,
  type FeedbackStatus,
  type FeedbackKindStr,
} from '../_components/labels';

export const dynamic = 'force-dynamic';

export default async function SuperAdminFeedbackDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [report] = await db
    .select({
      id: feedbackReports.id,
      kind: feedbackReports.kind,
      title: feedbackReports.title,
      description: feedbackReports.description,
      status: feedbackReports.status,
      pageUrl: feedbackReports.pageUrl,
      createdAt: feedbackReports.createdAt,
      updatedAt: feedbackReports.updatedAt,
      reporterEmail: users.email,
      reporterName: users.fullName,
      reporterUserId: feedbackReports.reporterUserId,
      orgName: organizations.name,
      orgId: feedbackReports.organizationId,
    })
    .from(feedbackReports)
    .leftJoin(users, eq(feedbackReports.reporterUserId, users.id))
    .leftJoin(organizations, eq(feedbackReports.organizationId, organizations.id))
    .where(eq(feedbackReports.id, id))
    .limit(1);

  if (!report) notFound();

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
    <AdminPage
      title={report.title}
      crumbs={[
        { label: 'SuperAdmin', href: '/super-admin/dashboard' },
        { label: 'Feedback', href: '/super-admin/feedback' },
        { label: report.title },
      ]}
      actions={
        <div className="flex items-center gap-2">
          <Badge tone={kindTone(report.kind as FeedbackKindStr)}>{kindLabel(report.kind as FeedbackKindStr)}</Badge>
          <Badge tone={statusTone(report.status as FeedbackStatus)}>{statusLabel(report.status as FeedbackStatus)}</Badge>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="flex flex-col gap-5 lg:col-span-2">
          <Panel title="Description">
            <p className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{report.description}</p>
          </Panel>

          <Panel title={`Comments (${comments.length})`}>
            {comments.length === 0 ? (
              <p className="text-sm text-zinc-500">No comments yet. Reply to start the thread — the reporter will see it on their feedback page.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {comments.map((c) => (
                  <li
                    key={c.id}
                    className={`rounded-md border p-3 ${
                      c.isAdmin
                        ? 'border-blue-200 bg-blue-50/40 dark:border-blue-900 dark:bg-blue-950/20'
                        : 'border-zinc-200 dark:border-zinc-800'
                    }`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-3 text-xs text-zinc-500">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        {c.authorName ?? c.authorEmail ?? 'Unknown'}{' '}
                        {c.isAdmin && <span className="ml-1 rounded bg-blue-100 px-1 text-[10px] uppercase tracking-wide text-blue-700 dark:bg-blue-900/60 dark:text-blue-300">admin</span>}
                      </span>
                      <span className="tabular-nums">{c.createdAt ? new Date(c.createdAt).toLocaleString() : ''}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{c.body}</p>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4">
              <CommentForm reportId={report.id} action={addFeedbackCommentAction} placeholder="Reply to the reporter…" />
            </div>
          </Panel>
        </div>

        <div className="flex flex-col gap-5">
          <Panel title="Status">
            <form action={setFeedbackStatusAction} className="flex flex-col gap-2">
              <input type="hidden" name="reportId" value={report.id} />
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium uppercase text-zinc-500">Move to</span>
                <select
                  name="status"
                  defaultValue={report.status}
                  className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="mt-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
              >
                Update status
              </button>
            </form>
          </Panel>

          <Panel title="Reporter">
            <dl className="grid grid-cols-3 gap-y-2 text-sm">
              <dt className="col-span-1 text-zinc-500">Name</dt>
              <dd className="col-span-2 text-zinc-800 dark:text-zinc-200">{report.reporterName ?? '—'}</dd>
              <dt className="col-span-1 text-zinc-500">Email</dt>
              <dd className="col-span-2 text-zinc-800 dark:text-zinc-200">{report.reporterEmail ?? '—'}</dd>
              <dt className="col-span-1 text-zinc-500">Workspace</dt>
              <dd className="col-span-2 text-zinc-800 dark:text-zinc-200">
                {report.orgName ?? (report.orgId ? <code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-900">{report.orgId}</code> : '—')}
              </dd>
              <dt className="col-span-1 text-zinc-500">Submitted</dt>
              <dd className="col-span-2 tabular-nums text-zinc-800 dark:text-zinc-200">
                {report.createdAt ? new Date(report.createdAt).toLocaleString() : '—'}
              </dd>
              <dt className="col-span-1 text-zinc-500">Last activity</dt>
              <dd className="col-span-2 tabular-nums text-zinc-800 dark:text-zinc-200">
                {report.updatedAt ? new Date(report.updatedAt).toLocaleString() : '—'}
              </dd>
              {report.pageUrl && (
                <>
                  <dt className="col-span-1 text-zinc-500">From page</dt>
                  <dd className="col-span-2">
                    <code className="break-all rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-900">{report.pageUrl}</code>
                  </dd>
                </>
              )}
              <dt className="col-span-1 text-zinc-500">Report ID</dt>
              <dd className="col-span-2 break-all font-mono text-xs text-zinc-500">{report.id}</dd>
            </dl>
            <Link
              href="/super-admin/feedback"
              className="mt-3 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
            >
              ← Back to all feedback
            </Link>
          </Panel>
        </div>
      </div>
    </AdminPage>
  );
}
