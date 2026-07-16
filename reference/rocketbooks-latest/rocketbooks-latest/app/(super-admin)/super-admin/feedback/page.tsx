import Link from 'next/link';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { feedbackReports, feedbackReportComments } from '@/db/schema/feedback';
import { users, organizations } from '@/db/schema/schema';
import { AdminPage, Panel, Badge } from '@/components/admin/AdminPage';
import { statusTone, statusLabel, kindLabel, kindTone, type FeedbackStatus, type FeedbackKindStr } from './_components/labels';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface SearchParams {
  page?: string;
  status?: string;
  kind?: string;
}

function buildHref(base: SearchParams, override: Partial<SearchParams>): string {
  const merged = { ...base, ...override };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v && v !== '') p.set(k, String(v));
  }
  const qs = p.toString();
  return qs ? `/super-admin/feedback?${qs}` : '/super-admin/feedback';
}

export default async function SuperAdminFeedbackPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const status = (sp.status ?? '').trim();
  const kind = (sp.kind ?? '').trim();

  const conds: ReturnType<typeof eq>[] = [];
  if (status) conds.push(eq(feedbackReports.status, status));
  if (kind) conds.push(eq(feedbackReports.kind, kind));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const baseQ = db
    .select({
      id: feedbackReports.id,
      kind: feedbackReports.kind,
      title: feedbackReports.title,
      status: feedbackReports.status,
      createdAt: feedbackReports.createdAt,
      updatedAt: feedbackReports.updatedAt,
      reporterEmail: users.email,
      reporterName: users.fullName,
      orgName: organizations.name,
      commentCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${feedbackReportComments}
        WHERE ${feedbackReportComments.reportId} = ${feedbackReports.id}
      )`.as('comment_count'),
    })
    .from(feedbackReports)
    .leftJoin(users, eq(feedbackReports.reporterUserId, users.id))
    .leftJoin(organizations, eq(feedbackReports.organizationId, organizations.id))
    .orderBy(desc(feedbackReports.updatedAt));

  const filtered = where ? baseQ.where(where) : baseQ;

  const [rows, statusCountsRaw, kindCountsRaw] = await Promise.all([
    filtered.limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE),
    db
      .select({ status: feedbackReports.status, n: count() })
      .from(feedbackReports)
      .groupBy(feedbackReports.status),
    db
      .select({ kind: feedbackReports.kind, n: count() })
      .from(feedbackReports)
      .groupBy(feedbackReports.kind),
  ]);

  const statusCounts = new Map(statusCountsRaw.map((r) => [r.status, Number(r.n)]));
  const kindCounts = new Map(kindCountsRaw.map((r) => [r.kind, Number(r.n)]));
  const totalAll = statusCountsRaw.reduce((s, r) => s + Number(r.n), 0);
  const hasFilters = !!(status || kind);

  return (
    <AdminPage
      title="Feedback"
      crumbs={[{ label: 'SuperAdmin', href: '/super-admin/dashboard' }, { label: 'Feedback' }]}
    >
      <Panel>
        <div className="flex flex-wrap items-center gap-4">
          <FilterPills
            label="Status"
            name="status"
            current={status}
            sp={sp}
            options={[
              { value: '', label: `All (${totalAll})` },
              { value: 'open', label: `Open (${statusCounts.get('open') ?? 0})` },
              { value: 'in_progress', label: `In progress (${statusCounts.get('in_progress') ?? 0})` },
              { value: 'resolved', label: `Resolved (${statusCounts.get('resolved') ?? 0})` },
              { value: 'closed', label: `Closed (${statusCounts.get('closed') ?? 0})` },
            ]}
          />
          <FilterPills
            label="Kind"
            name="kind"
            current={kind}
            sp={sp}
            options={[
              { value: '', label: 'All' },
              { value: 'bug', label: `Bugs (${kindCounts.get('bug') ?? 0})` },
              { value: 'recommendation', label: `Recommendations (${kindCounts.get('recommendation') ?? 0})` },
            ]}
          />
          {hasFilters && (
            <Link
              href="/super-admin/feedback"
              className="ml-auto rounded-md border border-zinc-300 px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Reset
            </Link>
          )}
        </div>
      </Panel>

      <Panel>
        <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2.5">Kind</th>
                <th className="px-4 py-2.5">Title</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Reporter</th>
                <th className="px-4 py-2.5">Workspace</th>
                <th className="px-4 py-2.5 text-right">Comments</th>
                <th className="px-4 py-2.5">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-zinc-500">
                    {hasFilters ? 'No reports match these filters.' : 'No feedback yet.'}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/40">
                    <td className="px-4 py-2">
                      <Badge tone={kindTone(r.kind as FeedbackKindStr)}>{kindLabel(r.kind as FeedbackKindStr)}</Badge>
                    </td>
                    <td className="px-4 py-2 font-medium">
                      <Link href={`/super-admin/feedback/${r.id}`} className="hover:underline">
                        {r.title}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <Badge tone={statusTone(r.status as FeedbackStatus)}>{statusLabel(r.status as FeedbackStatus)}</Badge>
                    </td>
                    <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                      <div className="truncate">{r.reporterName ?? '—'}</div>
                      <div className="truncate text-xs text-zinc-500">{r.reporterEmail ?? ''}</div>
                    </td>
                    <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.orgName ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{r.commentCount}</td>
                    <td className="px-4 py-2 text-xs tabular-nums text-zinc-500">
                      {r.updatedAt ? new Date(r.updatedAt).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <nav className="mt-3 flex items-center justify-end gap-2 text-sm">
          {page > 1 && (
            <Link
              href={buildHref(sp, { page: String(page - 1) })}
              className="rounded-md border border-zinc-300 px-3 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              ← Previous
            </Link>
          )}
          {rows.length === PAGE_SIZE && (
            <Link
              href={buildHref(sp, { page: String(page + 1) })}
              className="rounded-md border border-zinc-300 px-3 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Next →
            </Link>
          )}
        </nav>
      </Panel>
    </AdminPage>
  );
}

function FilterPills({
  label,
  name,
  current,
  options,
  sp,
}: {
  label: string;
  name: 'status' | 'kind';
  current: string;
  options: { value: string; label: string }[];
  sp: SearchParams;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium uppercase text-zinc-500">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => {
          const active = current === o.value;
          const href = buildHref(sp, { [name]: o.value, page: undefined });
          return (
            <Link
              key={o.value || '_all'}
              href={href}
              className={`rounded-full border px-2.5 py-1 text-xs ${
                active
                  ? 'border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950/40 dark:text-blue-300'
                  : 'border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900'
              }`}
            >
              {o.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
