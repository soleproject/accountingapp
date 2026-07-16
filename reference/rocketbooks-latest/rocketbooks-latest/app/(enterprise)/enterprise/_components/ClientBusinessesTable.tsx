import Link from 'next/link';
import { Badge } from '@/components/admin/AdminPage';
import { ClientActionIcons } from './ClientActionIcons';
import { OpenBooksButton } from './OpenBooksButton';
import { ClientTimelineToggle } from './ClientTimelineToggle';
import { MonthlyTimeline } from '@/components/timeline/MonthlyTimeline';
import type { ClientHealth } from '@/lib/enterprise/client-health';

function statusOf(c: ClientHealth): { tone: 'red' | 'amber' | 'blue' | 'green'; label: string } {
  if (c.blockingCount > 0) return { tone: 'red', label: 'Action needed' };
  if (c.needsAttentionCount > 0) return { tone: 'amber', label: 'Review' };
  if (c.onboardingIncomplete) return { tone: 'blue', label: 'Setup' };
  return { tone: 'green', label: 'Current' };
}

const periodLabel = () => new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

/** A single business as a shadowed card with its monthly timeline. Shared by the
 * Alphabetical cards-view and the Grouped-by-owner cards-view. */
function BusinessCard({ c, isDemo }: { c: ClientHealth; isDemo: boolean }) {
  const isSuper = c.ownerRole === 'super_admin' || c.ownerRole === 'superadmin';
  const status = statusOf(c);
  return (
    <div
      data-search={`${c.orgName} ${c.ownerName ?? ''} ${c.ownerEmail ?? ''}`}
      className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 text-sm">
        <div className="min-w-[160px] flex-1">
          <div className="font-medium">
            <Link href={`/enterprise/clients/${c.ownerUserId}/bookkeeping?org=${c.orgId}`} className="hover:underline">
              {c.orgName}
            </Link>
          </div>
          <div className="mt-0.5 text-xs">
            <Link href={`/enterprise/clients/${c.ownerUserId}`} className="text-blue-700 hover:underline dark:text-blue-300">
              {c.ownerName ?? c.ownerEmail}
            </Link>
            {c.ownerName && <span className="ml-1.5 text-zinc-500">{c.ownerEmail}</span>}
          </div>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
        <div className="flex flex-col items-start">
          <span className="text-[10px] uppercase tracking-wide text-zinc-400">To review</span>
          {c.toReview > 0 ? (
            <span className="font-medium tabular-nums text-amber-700 dark:text-amber-300">{c.toReview}</span>
          ) : (
            <span className="tabular-nums text-zinc-400">0</span>
          )}
        </div>
        <div className="flex flex-col items-start">
          <span className="text-[10px] uppercase tracking-wide text-zinc-400">Bank</span>
          {c.brokenBankFeeds > 0 ? <Badge tone="red">Reconnect</Badge> : <span className="text-xs text-zinc-400">OK</span>}
        </div>
        <div className="flex flex-col items-start">
          <span className="text-[10px] uppercase tracking-wide text-zinc-400">Open tasks</span>
          <span className="tabular-nums text-zinc-600 dark:text-zinc-400">{c.openTasks}</span>
        </div>
        <div className="flex flex-col items-start">
          <span className="text-[10px] uppercase tracking-wide text-zinc-400">Last activity</span>
          <span className="tabular-nums text-zinc-600 dark:text-zinc-400">{c.lastActivityAt ? c.lastActivityAt.toLocaleDateString() : '—'}</span>
        </div>
        <div className="ml-auto">
          {isDemo ? (
            <span className="text-xs text-zinc-400">Demo</span>
          ) : (
            <div className="flex items-center gap-2">
              <OpenBooksButton userId={c.ownerUserId} orgId={c.orgId} compact />
              <ClientActionIcons
                userId={c.ownerUserId}
                orgId={c.orgId}
                userLabel={c.ownerName ?? c.ownerEmail ?? 'this user'}
                isActive={true}
                isSuper={isSuper}
                onboardingIncomplete={c.onboardingIncomplete}
                editHref={`/enterprise/businesses/${c.orgId}/edit`}
                editLabel={c.orgName}
              />
            </div>
          )}
        </div>
      </div>
      <div className="border-t border-zinc-100 bg-zinc-50/40 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/30">
        <MonthlyTimeline steps={c.timelineSteps} periodLabel={periodLabel()} defaultOrientation="horizontal" openBooksAs={{ ownerUserId: c.ownerUserId, orgId: c.orgId }} />
      </div>
    </div>
  );
}

/**
 * The firm's client-businesses list: a compact table that toggles into shadowed
 * per-client cards (each with a monthly timeline). Business name → the client's
 * bookkeeping view; owner name → the User Details admin page. Shared by the
 * enterprise dashboard and the dedicated Client Businesses page.
 */
export function ClientBusinessesTable({
  clients,
  isDemo,
  sort = 'alpha',
}: {
  clients: ClientHealth[];
  isDemo: boolean;
  sort?: 'alpha' | 'owner';
}) {
  if (clients.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
        No active client businesses for this enterprise yet.
      </div>
    );
  }

  if (sort === 'owner') {
    return <OwnerGroupedBusinesses clients={clients} isDemo={isDemo} />;
  }

  const ordered = [...clients].sort((a, b) => a.orgName.localeCompare(b.orgName));

  return (
    <ClientTimelineToggle>
      {/* Compact table — shown when the monthly-timeline toggle is OFF. */}
      <div className="ent-table-view overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2.5">Business</th>
              <th className="px-4 py-2.5">Owner</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5 text-right">To review</th>
              <th className="px-4 py-2.5">Bank</th>
              <th className="px-4 py-2.5 text-right">Open tasks</th>
              <th className="px-4 py-2.5">Last activity</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((c) => {
              const isSuper = c.ownerRole === 'super_admin' || c.ownerRole === 'superadmin';
              const status = statusOf(c);
              return (
                <tr
                  key={c.orgId}
                  data-search={`${c.orgName} ${c.ownerName ?? ''} ${c.ownerEmail ?? ''}`}
                  className="border-t border-zinc-100 dark:border-zinc-800"
                >
                  <td className="px-4 py-2.5 font-medium">
                    <Link href={`/enterprise/clients/${c.ownerUserId}/bookkeeping?org=${c.orgId}`} className="hover:underline">
                      {c.orgName}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <Link href={`/enterprise/clients/${c.ownerUserId}`} className="text-blue-700 hover:underline dark:text-blue-300">
                      {c.ownerName ?? c.ownerEmail}
                    </Link>
                    {c.ownerName && <span className="ml-2 text-xs text-zinc-500">{c.ownerEmail}</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {c.toReview > 0 ? (
                      <span className="font-medium text-amber-700 dark:text-amber-300">{c.toReview}</span>
                    ) : (
                      <span className="text-zinc-400">0</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {c.brokenBankFeeds > 0 ? <Badge tone="red">Reconnect</Badge> : <span className="text-xs text-zinc-400">OK</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{c.openTasks}</td>
                  <td className="px-4 py-2.5 tabular-nums text-zinc-600 dark:text-zinc-400">
                    {c.lastActivityAt ? c.lastActivityAt.toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    {isDemo ? (
                      <span className="inline-flex justify-end text-xs text-zinc-400">Demo</span>
                    ) : (
                      <div className="flex items-center justify-end gap-2">
                        <OpenBooksButton userId={c.ownerUserId} orgId={c.orgId} compact />
                        <ClientActionIcons
                          userId={c.ownerUserId}
                          orgId={c.orgId}
                          userLabel={c.ownerName ?? c.ownerEmail ?? 'this user'}
                          isActive={true}
                          isSuper={isSuper}
                          onboardingIncomplete={c.onboardingIncomplete}
                          editHref={`/enterprise/businesses/${c.orgId}/edit`}
                          editLabel={c.orgName}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Shadowed cards with each client's timeline — shown when the toggle is ON. */}
      <div className="ent-cards-view flex flex-col gap-3">
        {ordered.map((c) => (
          <BusinessCard key={c.orgId} c={c} isDemo={isDemo} />
        ))}
      </div>
    </ClientTimelineToggle>
  );
}

/** Collapsible group header (chevron + owner link + business count). */
function OwnerSummary({ ownerId, name, email, count }: { ownerId: string; name: string; email: string | null; count: number }) {
  return (
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900">
      <div className="flex min-w-0 items-center gap-2">
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-zinc-400 transition-transform group-open:rotate-90"
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <Link href={`/enterprise/clients/${ownerId}`} className="truncate font-medium text-blue-700 hover:underline dark:text-blue-300">
          {name}
        </Link>
        {email && <span className="truncate text-xs text-zinc-500">{email}</span>}
      </div>
      <span className="shrink-0 text-xs text-zinc-400">
        {count} {count === 1 ? 'business' : 'businesses'}
      </span>
    </summary>
  );
}

/** Businesses grouped under their owner (owners A–Z, businesses A–Z), each group
 * a native collapsible <details>. The "Show monthly timeline" toggle switches
 * each group between a compact table and timeline cards. */
function OwnerGroupedBusinesses({ clients, isDemo }: { clients: ClientHealth[]; isDemo: boolean }) {
  const groups = new Map<string, { name: string; email: string | null; items: ClientHealth[] }>();
  for (const c of clients) {
    const g = groups.get(c.ownerUserId);
    if (g) g.items.push(c);
    else groups.set(c.ownerUserId, { name: c.ownerName ?? c.ownerEmail ?? 'Unknown owner', email: c.ownerEmail, items: [c] });
  }
  const ordered = [...groups.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  for (const [, g] of ordered) g.items.sort((a, b) => a.orgName.localeCompare(b.orgName));

  return (
    <ClientTimelineToggle>
      {/* Compact tables per owner — shown when the monthly-timeline toggle is OFF. */}
      <div className="ent-table-view flex flex-col gap-3">
        {ordered.map(([ownerId, g]) => (
          <details
            key={ownerId}
            open
            data-search={`${g.name} ${g.email ?? ''} ${g.items.map((i) => i.orgName).join(' ')}`}
            className="group overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
          >
            <OwnerSummary ownerId={ownerId} name={g.name} email={g.email} count={g.items.length} />
            <div className="overflow-x-auto border-t border-zinc-100 dark:border-zinc-800">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                  <tr>
                    <th className="px-4 py-2">Business</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2 text-right">To review</th>
                    <th className="px-4 py-2">Bank</th>
                    <th className="px-4 py-2 text-right">Open tasks</th>
                    <th className="px-4 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map((c) => {
                    const isSuper = c.ownerRole === 'super_admin' || c.ownerRole === 'superadmin';
                    const status = statusOf(c);
                    return (
                      <tr
                        key={c.orgId}
                        data-search={`${c.orgName} ${g.name} ${g.email ?? ''}`}
                        className="border-t border-zinc-100 dark:border-zinc-800"
                      >
                        <td className="px-4 py-2 font-medium">
                          <Link href={`/enterprise/clients/${c.ownerUserId}/bookkeeping?org=${c.orgId}`} className="hover:underline">
                            {c.orgName}
                          </Link>
                        </td>
                        <td className="px-4 py-2">
                          <Badge tone={status.tone}>{status.label}</Badge>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {c.toReview > 0 ? (
                            <span className="font-medium text-amber-700 dark:text-amber-300">{c.toReview}</span>
                          ) : (
                            <span className="text-zinc-400">0</span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          {c.brokenBankFeeds > 0 ? <Badge tone="red">Reconnect</Badge> : <span className="text-xs text-zinc-400">OK</span>}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{c.openTasks}</td>
                        <td className="px-4 py-2">
                          {isDemo ? (
                            <span className="inline-flex justify-end text-xs text-zinc-400">Demo</span>
                          ) : (
                            <div className="flex items-center justify-end gap-2">
                              <OpenBooksButton userId={c.ownerUserId} orgId={c.orgId} compact />
                              <ClientActionIcons
                                userId={c.ownerUserId}
                                orgId={c.orgId}
                                userLabel={c.ownerName ?? c.ownerEmail ?? 'this user'}
                                isActive={true}
                                isSuper={isSuper}
                                onboardingIncomplete={c.onboardingIncomplete}
                                editHref={`/enterprise/businesses/${c.orgId}/edit`}
                                editLabel={c.orgName}
                              />
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        ))}
      </div>

      {/* Timeline cards per owner — shown when the monthly-timeline toggle is ON. */}
      <div className="ent-cards-view flex flex-col gap-3">
        {ordered.map(([ownerId, g]) => (
          <details
            key={ownerId}
            open
            data-search={`${g.name} ${g.email ?? ''} ${g.items.map((i) => i.orgName).join(' ')}`}
            className="group overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
          >
            <OwnerSummary ownerId={ownerId} name={g.name} email={g.email} count={g.items.length} />
            <div className="flex flex-col gap-3 border-t border-zinc-100 bg-zinc-50/40 p-3 dark:border-zinc-800 dark:bg-zinc-900/30">
              {g.items.map((c) => (
                <BusinessCard key={c.orgId} c={c} isDemo={isDemo} />
              ))}
            </div>
          </details>
        ))}
      </div>
    </ClientTimelineToggle>
  );
}
