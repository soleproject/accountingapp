'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Panel, EmptyHint } from '@/components/admin/AdminPage';
import { fmtUsd, fmtNum, type RangeKey } from '../_lib/format';

export interface EntUser {
  userId: string | null;
  email: string | null;
  events: number;
  cost: number;
}

export interface EntGroup {
  key: string;
  name: string;
  events: number;
  cost: number;
  users: EntUser[];
  /** The system / background pseudo-group (null-user events). */
  isSystem?: boolean;
}

/**
 * Usage rolled up by enterprise, with a user search box. Each enterprise is a
 * collapsible group: the summary shows its total events + cost; expanding
 * reveals its individual users (linked to their per-user usage page). Groups +
 * users are pre-sorted by cost on the server.
 *
 * Search filters users by email (or matches an enterprise name to show all of
 * its users); matching groups auto-expand. With an empty box, groups collapse
 * and expand manually. Openness is fully controlled so there's no
 * controlled/uncontrolled <details> churn.
 */
export function EnterpriseUsageSection({ groups, range }: { groups: EntGroup[]; range: RangeKey }) {
  const [query, setQuery] = useState('');
  const [manualOpen, setManualOpen] = useState<Set<string>>(new Set());
  const q = query.trim().toLowerCase();

  const visible = useMemo(() => {
    return groups
      .map((g) => {
        if (!q) return { group: g, users: g.users };
        const nameMatch = g.name.toLowerCase().includes(q);
        const users = nameMatch
          ? g.users
          : g.users.filter((u) => (u.email ?? '').toLowerCase().includes(q));
        return { group: g, users };
      })
      .filter(({ users }) => !q || users.length > 0);
  }, [groups, q]);

  const matchedUserCount = q ? visible.reduce((n, v) => n + v.users.length, 0) : 0;

  return (
    <Panel title="Usage by Enterprise">
      <div className="mb-3">
        <div className="relative">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="9" cy="9" r="6" />
            <path d="M14 14l4 4" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search users by email…"
            className="w-full rounded-md border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-zinc-800 dark:bg-zinc-950 dark:focus:ring-blue-950"
          />
        </div>
        {q && (
          <div className="mt-1.5 text-xs text-zinc-500">
            {matchedUserCount} user{matchedUserCount === 1 ? '' : 's'} in {visible.length} enterprise
            {visible.length === 1 ? '' : 's'}
          </div>
        )}
      </div>

      {groups.length === 0 ? (
        <EmptyHint>No usage in this range.</EmptyHint>
      ) : visible.length === 0 ? (
        <EmptyHint>No users match “{query}”.</EmptyHint>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map(({ group: g, users }) => {
            const open = q ? true : manualOpen.has(g.key);
            return (
              <details
                key={g.key}
                open={open}
                onToggle={(e) => {
                  if (q) return; // openness is forced while searching
                  const isOpen = (e.currentTarget as HTMLDetailsElement).open;
                  setManualOpen((prev) => {
                    const next = new Set(prev);
                    if (isOpen) next.add(g.key);
                    else next.delete(g.key);
                    return next;
                  });
                }}
                className="group rounded-md border border-zinc-200 dark:border-zinc-800"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900">
                  <span className="flex items-center gap-2 truncate">
                    <svg
                      className="h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform group-open:rotate-90"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path d="M7 5l6 5-6 5z" />
                    </svg>
                    <span className="truncate font-medium">{g.name}</span>
                    {!g.isSystem && (
                      <span className="shrink-0 text-xs text-zinc-400">
                        {users.length} user{users.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-6 text-sm">
                    <span className="tabular-nums text-zinc-500">{fmtNum(g.events)} events</span>
                    <span className="w-24 text-right font-semibold tabular-nums">{fmtUsd(g.cost)}</span>
                  </span>
                </summary>
                <div className="border-t border-zinc-100 px-4 py-1 dark:border-zinc-800">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                      <tr>
                        <th className="py-1.5">User</th>
                        <th className="py-1.5 text-right">Events</th>
                        <th className="py-1.5 text-right">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                      {users.map((u) => (
                        <tr key={u.userId ?? 'system'}>
                          <td className="py-1.5">
                            {u.userId ? (
                              <Link
                                href={`/super-admin/ai-usage/${u.userId}?range=${range}`}
                                className="text-blue-600 hover:underline dark:text-blue-400"
                              >
                                {u.email ?? `${u.userId.slice(0, 8)}…`}
                              </Link>
                            ) : (
                              <span className="text-zinc-500">system / background</span>
                            )}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">{fmtNum(u.events)}</td>
                          <td className="py-1.5 text-right font-medium tabular-nums">{fmtUsd(u.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
