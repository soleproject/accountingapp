import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { scanAgents, type AgentSession, type GitState } from '@/lib/agents/scan';
import { AdminPage, MetricTile, Panel, EmptyHint, Badge, StatusDot } from '@/components/admin/AdminPage';

export const dynamic = 'force-dynamic';

const OWNER_EMAIL = 'michael@bigsaas.ai';

function fmtTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function repoName(cwd: string | null): string {
  if (!cwd) return '—';
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

function truncate(s: string | null, n: number): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

const STATUS_DOT = { active: 'ok', idle: 'warn', dormant: 'unknown' } as const;

function SyncBadge({ repo }: { repo: GitState }) {
  if (!repo.isRepo) return <span className="text-zinc-400">not a repo</span>;
  if (!repo.hasUpstream) return <Badge tone="zinc">no upstream</Badge>;
  if (repo.ahead && repo.ahead > 0) return <Badge tone="blue">{repo.ahead} unpushed</Badge>;
  if (repo.behind && repo.behind > 0) return <Badge tone="amber">{repo.behind} behind</Badge>;
  return <Badge tone="green">pushed</Badge>;
}

export default async function SuperAdminAgentsPage() {
  // Belt-and-suspenders: the (super-admin) layout already gates on isSuperAdmin(),
  // but this board surfaces the local machine's Claude Code history, so lock it
  // to the single owner account explicitly.
  const user = await requireSession();
  if ((user.email ?? '').toLowerCase() !== OWNER_EMAIL) redirect('/super-admin/dashboard');

  const scan = await scanAgents();
  const { sessions, repos } = scan;

  const active = sessions.filter((s) => s.status === 'active').length;
  const totalUnpushed = repos.reduce((n, r) => n + (r.ahead ?? 0), 0);
  const totalDirty = repos.reduce((n, r) => n + r.dirtyCount, 0);

  return (
    <AdminPage
      title="Agents"
      crumbs={[{ label: 'SuperAdmin' }, { label: 'Agents' }]}
      actions={
        <>
          <Link
            href="/super-admin/agents/console"
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
          >
            Live Console →
          </Link>
          <Link
            href="/super-admin/agents"
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
          >
            Refresh
          </Link>
        </>
      }
    >
      {!scan.storeExists ? (
        <Panel>
          <EmptyHint>
            No Claude Code store found at <code className="mx-1 font-mono">{scan.storePath}</code>. This board only
            shows data on the machine where the agents run (localhost).
          </EmptyHint>
        </Panel>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <MetricTile label="Agents" value={sessions.length} />
            <MetricTile label="Active (<5m)" value={active} />
            <MetricTile label="Repos Tracked" value={repos.filter((r) => r.isRepo).length} />
            <MetricTile label="Unpushed Commits" value={totalUnpushed} />
            <MetricTile label="Uncommitted Files" value={totalDirty} />
          </div>

          <Panel title="Working Trees">
            {repos.length === 0 ? (
              <EmptyHint>No git working trees detected among active sessions.</EmptyHint>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                    <tr>
                      <th className="py-2">Repo</th>
                      <th className="py-2">Branch</th>
                      <th className="py-2">Changes</th>
                      <th className="py-2">Sync</th>
                      <th className="py-2">Last commit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {repos.map((r) => (
                      <tr key={r.cwd}>
                        <td className="py-2 font-medium" title={r.cwd}>
                          {repoName(r.cwd)}
                        </td>
                        <td className="py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                          {r.branch ?? '—'}
                        </td>
                        <td className="py-2">
                          {r.dirtyCount === 0 ? (
                            <Badge tone="green">clean</Badge>
                          ) : (
                            <Badge tone="amber">{r.dirtyCount} uncommitted</Badge>
                          )}
                        </td>
                        <td className="py-2">
                          <SyncBadge repo={r} />
                        </td>
                        <td className="py-2 text-zinc-600 dark:text-zinc-400">{truncate(r.lastCommit, 60) || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title={`Sessions (${sessions.length})`}>
            {sessions.length === 0 ? (
              <EmptyHint>No agent sessions found.</EmptyHint>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                    <tr>
                      <th className="py-2">Agent</th>
                      <th className="py-2">Repo · branch</th>
                      <th className="py-2">Model</th>
                      <th className="py-2 text-right">Msgs</th>
                      <th className="py-2 text-right">Subs</th>
                      <th className="py-2">Last activity</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {sessions.map((s: AgentSession) => (
                      <tr key={s.sessionId} className="align-top">
                        <td className="max-w-md py-2">
                          <div className="font-medium">{truncate(s.title, 70)}</div>
                          {s.lastPrompt && s.lastPrompt !== s.title && (
                            <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                              {truncate(s.lastPrompt, 90)}
                            </div>
                          )}
                          <div className="mt-0.5 font-mono text-[10px] text-zinc-400 dark:text-zinc-600">
                            {s.sessionId.slice(0, 8)}
                          </div>
                        </td>
                        <td className="py-2 text-zinc-600 dark:text-zinc-400">
                          <span title={s.cwd ?? undefined}>{repoName(s.cwd)}</span>
                          {s.branch && <span className="font-mono text-xs"> · {s.branch}</span>}
                        </td>
                        <td className="py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                          {s.model ?? '—'}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {s.userMessages}/{s.assistantMessages}
                        </td>
                        <td className="py-2 text-right tabular-nums">{s.subAgents || '—'}</td>
                        <td className="py-2 whitespace-nowrap">
                          <StatusDot status={STATUS_DOT[s.status]} label={fmtTimeAgo(s.lastActivity)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <p className="text-xs text-zinc-400 dark:text-zinc-600">
            Read-only · status inferred from transcript recency (active &lt;5m · idle &lt;2h · dormant older) ·
            Msgs = your turns / assistant turns · generated {fmtTimeAgo(scan.generatedAt)}. Live status, chat, and
            recall arrive in Phase 1.
          </p>
        </>
      )}
    </AdminPage>
  );
}
