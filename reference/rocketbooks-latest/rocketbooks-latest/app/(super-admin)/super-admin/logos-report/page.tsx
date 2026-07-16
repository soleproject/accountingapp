import Link from 'next/link';
import { sql, desc, eq, ilike, or } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, users } from '@/db/schema/schema';
import { AdminPage, Badge, Panel } from '@/components/admin/AdminPage';
import { deleteEnterpriseLogoAction } from '../_actions/admin';

export const dynamic = 'force-dynamic';

interface SearchParams {
  q?: string;
}

function initials(name?: string | null): string {
  if (!name) return '—';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || (name[0] ?? '?').toUpperCase();
}

export default async function LogosReportPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { q } = await searchParams;
  const search = (q ?? '').trim();

  // Only enterprise user types: plan_type='enterprise' OR has staff/client rows.
  const whereParts = [
    sql`(${organizations.planType} = 'enterprise'
      or ${organizations.id} in (select enterprise_id from enterprise_staff)
      or ${organizations.id} in (select enterprise_id from enterprise_clients))`,
  ];

  if (search) {
    whereParts.push(
      or(
        ilike(organizations.name, `%${search}%`),
        ilike(users.fullName, `%${search}%`),
        ilike(users.email, `%${search}%`),
      )!,
    );
  }

  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      logoUrl: organizations.logoUrl,
      poweredByText: organizations.poweredByText,
      poweredByEnabled: organizations.poweredByEnabled,
      domain: organizations.domain,
      ownerId: organizations.ownerUserId,
      ownerName: users.fullName,
      ownerEmail: users.email,
    })
    .from(organizations)
    .leftJoin(users, eq(users.id, organizations.ownerUserId))
    .where(sql.join(whereParts, sql` and `))
    .orderBy(desc(organizations.createdAt));

  return (
    <AdminPage
      title="Enterprise Logos Report"
      crumbs={[{ label: 'SuperAdmin', href: '/super-admin/dashboard' }, { label: 'Logos Report' }]}
    >
      <Panel>
        <form className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            name="q"
            defaultValue={search}
            placeholder="Search by enterprise name, owner name, or email..."
            className="flex-1 bg-transparent outline-none placeholder:text-zinc-400"
          />
          {search && (
            <Link href="/super-admin/logos-report" className="text-xs text-zinc-500 hover:underline">
              Clear
            </Link>
          )}
        </form>
      </Panel>

      <Panel>
        <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-3">Logo</th>
                <th className="px-4 py-3">Enterprise</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3">Branding</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-zinc-500">
                    {search ? 'No enterprises match your search.' : 'No enterprises yet.'}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-4 py-3">
                      <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
                        {r.logoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={r.logoUrl} alt={`${r.name} logo`} className="h-full w-full object-contain" />
                        ) : (
                          <span className="text-xs font-semibold text-zinc-400">{initials(r.name)}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500">
                          <rect x="4" y="2" width="16" height="20" rx="1" />
                          <path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h.01M15 16h.01" />
                        </svg>
                        <span className="font-medium">{r.name}</span>
                      </div>
                      <div className="ml-6 mt-0.5 font-mono text-xs text-zinc-500">
                        ID: {r.id.slice(0, 8)}…
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500">
                          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                          <circle cx="12" cy="7" r="4" />
                        </svg>
                        <span className="font-medium">{r.ownerName ?? '—'}</span>
                      </div>
                      <div className="ml-6 mt-0.5 text-xs text-zinc-500">{r.ownerEmail ?? '—'}</div>
                    </td>
                    <td className="px-4 py-3">
                      {r.poweredByEnabled ? (
                        <Badge tone="blue">Powered By: {r.poweredByText ?? 'Powered by RocketSuite'}</Badge>
                      ) : (
                        <span className="text-sm text-zinc-500">Disabled</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {r.logoUrl ? (
                          <a
                            href={r.logoUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                          >
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                              <polyline points="15 3 21 3 21 9" />
                              <line x1="10" y1="14" x2="21" y2="3" />
                            </svg>
                            View Logo
                          </a>
                        ) : (
                          <span className="rounded-md border border-dashed border-zinc-300 px-3 py-1.5 text-xs text-zinc-400 dark:border-zinc-700">
                            No logo
                          </span>
                        )}
                        <Link
                          href={`/super-admin/enterprises/${r.id}`}
                          className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                        >
                          View Enterprise
                        </Link>
                        {r.logoUrl && (
                          <form action={deleteEnterpriseLogoAction} className="inline">
                            <input type="hidden" name="id" value={r.id} />
                            <button
                              type="submit"
                              className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
                            >
                              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
                              </svg>
                              Delete Logo
                            </button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Showing 1 to {rows.length} of {rows.length} results
        </div>
      </Panel>
    </AdminPage>
  );
}
