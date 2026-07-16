'use client';

import Link from 'next/link';
import { RowActions } from './RowActions';
import { MergeBar } from './MergeBar';
import { SelectAll } from './SelectAll';

export type StatusFilter = 'active' | 'archived' | 'all';
export type ContactRow = { id: string; contactName: string; companyName: string | null; email: string | null; phone: string | null; isActive: boolean | null; createdByAi: boolean | null };
export type ContactOption = { id: string; contactName: string };
export type ContactsPayload = { page: number; pageCount: number; q: string | null; status: StatusFilter; totalCount: number; rows: ContactRow[]; allContactsForMerge: ContactOption[]; statusCounts: Record<StatusFilter, number> };
const VALID_STATUS: StatusFilter[] = ['active', 'archived', 'all'];

export function ContactsLoaded({ payload }: { payload: ContactsPayload }) {
  const { page, pageCount, q, status, totalCount, rows, allContactsForMerge, statusCounts } = payload;
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
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{totalCount.toLocaleString()} {q ? 'matching' : status === 'all' ? 'total' : status} · Page {page} of {pageCount}</p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white p-1 text-xs dark:border-zinc-800 dark:bg-zinc-950">
            {VALID_STATUS.map((s) => {
              const active = status === s;
              return <Link key={s} href={buildHref({ status: s, page: 1 })} prefetch={false} className={`rounded px-2 py-1 ${active ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'}`}>{s} <span className="opacity-60">({statusCounts[s] ?? 0})</span></Link>;
            })}
          </div>
          <form method="get" className="flex items-center gap-2">
            {status !== 'active' && <input type="hidden" name="status" value={status} />}
            <input type="text" name="q" defaultValue={q ?? ''} placeholder="Search contacts…" className="rounded-md border border-zinc-300 bg-white px-3 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
            <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">Search</button>
          </form>
          <a href="/contacts/new" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">+ New contact</a>
          <a href="/api/contacts/export" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">Export CSV</a>
        </div>
      </div>
      <MergeBar allContacts={allContactsForMerge} currentStatus={status} />
      <ContactsTable rows={rows} q={q} />
      {pageCount > 1 && <nav className="flex items-center gap-2 text-sm">{page > 1 && <a href={buildHref({ page: page - 1 })} className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">← Previous</a>}{page < pageCount && <a href={buildHref({ page: page + 1 })} className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">Next →</a>}</nav>}
    </>
  );
}

function ContactsTable({ rows, q }: { rows: ContactRow[]; q: string | null }) {
  return <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"><table className="w-full text-sm"><thead className="bg-zinc-50 text-left dark:bg-zinc-900"><tr><th className="w-10 px-4 py-2"><SelectAll /></th><th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Name</th><th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Company</th><th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Email</th><th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Phone</th><th className="w-24 px-4 py-2 text-right font-medium text-zinc-600 dark:text-zinc-400"><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-zinc-500">{q ? `No contacts match "${q}".` : 'No contacts on this page.'}</td></tr>}{rows.map((c) => <tr key={c.id} className={`border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900 ${c.isActive === false ? 'opacity-50' : ''}`}><td className="px-4 py-2"><input type="checkbox" name="contactIds" value={c.id} form="contacts-merge-form" className="h-4 w-4" /></td><td className="px-4 py-2 text-zinc-700 dark:text-zinc-300"><a href={`/contacts/${c.id}`} className="hover:underline">{c.contactName}</a>{c.createdByAi && <span className="ml-2 inline-block rounded bg-amber-100 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">AI</span>}{c.isActive === false && <span className="ml-2 inline-block rounded bg-zinc-200 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">Archived</span>}</td><td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{c.companyName ?? '—'}</td><td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{c.email ?? '—'}</td><td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{c.phone ?? '—'}</td><td className="px-4 py-2 text-right"><RowActions id={c.id} contactName={c.contactName} isActive={c.isActive} /></td></tr>)}</tbody></table></div>;
}
