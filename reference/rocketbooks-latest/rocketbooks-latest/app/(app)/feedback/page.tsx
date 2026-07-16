import Link from 'next/link';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { feedbackReports, feedbackReportComments } from '@/db/schema/feedback';
import { requireSession } from '@/lib/auth/session';
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

export default async function MyFeedbackPage() {
  const user = await requireSession();

  const rows = await db
    .select({
      id: feedbackReports.id,
      kind: feedbackReports.kind,
      title: feedbackReports.title,
      status: feedbackReports.status,
      createdAt: feedbackReports.createdAt,
      updatedAt: feedbackReports.updatedAt,
      commentCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${feedbackReportComments}
        WHERE ${feedbackReportComments.reportId} = ${feedbackReports.id}
      )`.as('comment_count'),
    })
    .from(feedbackReports)
    .where(eq(feedbackReports.reporterUserId, user.id))
    .orderBy(desc(feedbackReports.updatedAt))
    .limit(200);

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">My feedback</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Bugs and recommendations you&apos;ve sent in. Use the <strong>Feedback</strong> button in the top bar to add another.
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 p-12 text-center text-sm text-zinc-500 dark:border-zinc-800">
          You haven&apos;t submitted any feedback yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2.5">Kind</th>
                <th className="px-4 py-2.5">Title</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Replies</th>
                <th className="px-4 py-2.5">Last update</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/40">
                  <td className="px-4 py-2">
                    <Badge tone={kindTone(r.kind as FeedbackKindStr)}>{kindLabel(r.kind as FeedbackKindStr)}</Badge>
                  </td>
                  <td className="px-4 py-2 font-medium">
                    <Link href={`/feedback/${r.id}`} className="hover:underline">
                      {r.title}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <Badge tone={statusTone(r.status as FeedbackStatus)}>{statusLabel(r.status as FeedbackStatus)}</Badge>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{r.commentCount}</td>
                  <td className="px-4 py-2 text-xs tabular-nums text-zinc-500">
                    {r.updatedAt ? new Date(r.updatedAt).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
