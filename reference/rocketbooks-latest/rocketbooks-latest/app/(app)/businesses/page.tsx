import Link from 'next/link';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, onboardingState } from '@/db/schema/schema';
import { getCurrentOrgId, listAccessibleOrgs } from '@/lib/auth/org';
import { SwitchBusinessButton } from './_components/SwitchBusinessButton';
import { DeleteBusinessButton } from './_components/DeleteBusinessButton';

export default async function BusinessesPage() {
  const [currentOrgId, orgs] = await Promise.all([getCurrentOrgId(), listAccessibleOrgs()]);

  const ids = orgs.map((o) => o.id);
  // CRITICAL: filter by `ids` — without inArray() this scans every org in the DB.
  const meta = ids.length > 0
    ? await db
        .select({
          id: organizations.id,
          name: organizations.name,
          businessDescription: organizations.businessDescription,
          accountingMethod: organizations.accountingMethod,
          phase: onboardingState.phase,
          completed: onboardingState.completed,
        })
        .from(organizations)
        .leftJoin(onboardingState, eq(onboardingState.orgId, organizations.id))
        .where(inArray(organizations.id, ids))
    : [];

  const metaById = new Map(meta.map((m) => [m.id, m]));

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Businesses</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {orgs.length} business{orgs.length === 1 ? '' : 'es'} you have access to
          </p>
        </div>
      </header>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Name</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">What it does</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Role</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Accounting</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Onboarding</th>
              <th className="px-4 py-2 text-right"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {orgs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                  No businesses yet.
                </td>
              </tr>
            )}
            {orgs.map((o) => {
              const m = metaById.get(o.id);
              const isCurrent = o.id === currentOrgId;
              const phaseLabel = m?.completed ? 'Complete' : m?.phase ? m.phase.replace(/_/g, ' ') : 'Not started';
              return (
                <tr key={o.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">{o.name}</span>
                      {isCurrent && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                          Current
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="max-w-md px-4 py-2 text-xs text-zinc-600 dark:text-zinc-400">
                    {m?.businessDescription ? (
                      <span className="line-clamp-2">{m.businessDescription}</span>
                    ) : (
                      <em className="text-zinc-400">—</em>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-zinc-500">{o.role}</td>
                  <td className="px-4 py-2">
                    {(() => {
                      const method = m?.accountingMethod === 'cash' ? 'cash' : 'accrual';
                      return (
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${
                            method === 'cash'
                              ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
                              : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                          }`}
                        >
                          {method}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        m?.completed
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                          : 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'
                      }`}
                    >
                      {phaseLabel}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {!isCurrent && <SwitchBusinessButton orgId={o.id} />}
                      {isCurrent && (
                        <Link
                          href="/dashboard"
                          className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                        >
                          Open
                        </Link>
                      )}
                      {o.role === 'owner' && (
                        <Link
                          href={`/businesses/${o.id}/edit`}
                          title="Edit business"
                          aria-label={`Edit ${o.name}`}
                          className="rounded p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
                          </svg>
                        </Link>
                      )}
                      {o.role === 'owner' && (
                        <DeleteBusinessButton
                          orgId={o.id}
                          orgName={o.name}
                          isCurrent={isCurrent}
                          isOnlyOrg={orgs.length <= 1}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
