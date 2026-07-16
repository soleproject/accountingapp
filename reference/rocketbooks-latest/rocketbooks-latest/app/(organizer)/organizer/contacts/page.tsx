import Link from 'next/link';
import { eq, and, asc, count, ilike, or, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';

const PAGE_SIZE = 50;

const VALID_STATUS = ['active', 'archived', 'all'] as const;
type StatusFilter = (typeof VALID_STATUS)[number];

interface PageProps {
  searchParams: Promise<{ page?: string; q?: string; status?: string }>;
}

export default async function OrganizerContactsList({ searchParams }: PageProps) {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const q = sp.q?.trim() || null;
  const status: StatusFilter = (VALID_STATUS as readonly string[]).includes(sp.status ?? '')
    ? (sp.status as StatusFilter)
    : 'active';

  const conditions = [eq(contacts.organizationId, orgId)];
  if (q) {
    const pattern = `%${q}%`;
    conditions.push(
      or(
        ilike(contacts.contactName, pattern),
        ilike(contacts.companyName, pattern),
        ilike(contacts.email, pattern),
      )!,
    );
  }
  // is_active is nullable in legacy rows — treat null as active.
  if (status === 'active') {
    conditions.push(or(eq(contacts.isActive, true), isNull(contacts.isActive))!);
  } else if (status === 'archived') {
    conditions.push(eq(contacts.isActive, false));
  }
  const where = conditions.length > 1 ? and(...conditions) : conditions[0];

  const [[total], rows, [statusCounts]] = await Promise.all([
    db.select({ n: count() }).from(contacts).where(where),
    db
      .select({
        id: contacts.id,
        contactName: contacts.contactName,
        companyName: contacts.companyName,
        email: contacts.email,
        phone: contacts.phone,
        isActive: contacts.isActive,
      })
      .from(contacts)
      .where(where)
      .orderBy(asc(contacts.contactName))
      .limit(PAGE_SIZE)
      .offset(offset),
    db
      .select({
        active: sql<number>`COUNT(*) FILTER (WHERE ${contacts.isActive} = TRUE OR ${contacts.isActive} IS NULL)::int`.as('active'),
        archived: sql<number>`COUNT(*) FILTER (WHERE ${contacts.isActive} = FALSE)::int`.as('archived'),
        all: sql<number>`COUNT(*)::int`.as('all'),
      })
      .from(contacts)
      .where(eq(contacts.organizationId, orgId)),
  ]);

  const totalCount = total?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // Hrefs preserve search + status across pagination + filter switches.
  const buildHref = (overrides: { page?: number; status?: StatusFilter; q?: string | null }) => {
    const parts: string[] = [];
    const p = overrides.page ?? page;
    if (p > 1) parts.push(`page=${p}`);
    const s = overrides.status ?? status;
    if (s !== 'active') parts.push(`status=${s}`);
    const search = overrides.q !== undefined ? overrides.q : q;
    if (search) parts.push(`q=${encodeURIComponent(search)}`);
    return parts.length === 0 ? '?' : `?${parts.join('&')}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Contacts</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {totalCount.toLocaleString()} {q ? 'matching' : status === 'all' ? 'total' : status} · Page {page} of {pageCount}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white p-1 text-xs dark:border-zinc-800 dark:bg-zinc-950">
            {VALID_STATUS.map((s) => {
              const counts = statusCounts ?? { active: 0, archived: 0, all: 0 };
              const n = counts[s];
              const active = status === s;
              return (
                <Link
                  key={s}
                  href={buildHref({ status: s, page: 1 })}
                  className={`rounded px-2 py-1 ${
                    active
                      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                      : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
                  }`}
                >
                  {s} <span className="opacity-60">({n})</span>
                </Link>
              );
            })}
          </div>
          <form method="get" className="flex items-center gap-2">
            {status !== 'active' && <input type="hidden" name="status" value={status} />}
            <input
              type="text"
              name="q"
              defaultValue={q ?? ''}
              placeholder="Search contacts…"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              type="submit"
              className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Search
            </button>
          </form>
        </div>
      </header>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Name</th>
              <th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Company</th>
              <th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Email</th>
              <th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Phone</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-zinc-500">
                  {q ? `No contacts match "${q}".` : 'No contacts on this page.'}
                </td>
              </tr>
            )}
            {rows.map((c) => (
              <tr
                key={c.id}
                className={`border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900 ${
                  c.isActive === false ? 'opacity-50' : ''
                }`}
              >
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                  <Link href={`/organizer/contacts/${c.id}`} className="font-medium hover:underline">
                    {c.contactName}
                  </Link>
                  {c.isActive === false && (
                    <span className="ml-2 inline-block rounded bg-zinc-200 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                      Archived
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{c.companyName ?? '—'}</td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{c.email ?? '—'}</td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{c.phone ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <nav className="flex items-center gap-2 text-sm">
          {page > 1 && (
            <Link
              href={buildHref({ page: page - 1 })}
              className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              ← Previous
            </Link>
          )}
          {page < pageCount && (
            <Link
              href={buildHref({ page: page + 1 })}
              className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Next →
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
