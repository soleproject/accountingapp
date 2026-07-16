import Link from 'next/link';
import { requirePermission } from '@/lib/auth/permissions';
import { getCurrentOrgId } from '@/lib/auth/org';
import { listCommunications, type CommThread } from '@/lib/communications/list';

/**
 * Communications — the in-app log of every email between the AI/system and the
 * client: each outbound request (contact inquiry, IRS docs, review reminder,
 * monthly report, …) threaded with the client's replies, searchable, and linked
 * to the transactions the conversation is about. Read-only; org-scoped.
 */

const ISSUE_LABELS: Record<string, string> = {
  contact_inquiry: 'Unknown contact — who is this?',
  substantiation_request: 'IRS documentation request',
  review_request: 'Transaction review request',
  monthly_report: 'Monthly report',
  overdue_invoices: 'Overdue invoices',
  overdue_bills: 'Overdue bills',
  broken_bank: 'Bank reconnection',
  to_review: 'Transactions to review',
  meeting_followup: 'Meeting follow-up',
  onboarding: 'Onboarding',
  recon_off: 'Reconciliation',
  reply: 'Client reply',
};

const STATUS_TONE: Record<string, string> = {
  resolved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  sent: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  awaiting_response: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  received: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  drafted: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

function issueLabel(t: string | null | undefined): string {
  if (!t) return 'Other';
  return ISSUE_LABELS[t] ?? t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function Thread({ t }: { t: CommThread }) {
  const first = t.messages[0];
  const last = t.messages[t.messages.length - 1];
  const subject = first?.subject || issueLabel(t.issueType);
  const preview = (last?.body || last?.subject || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const count = t.messages.length;
  return (
    <details className="group overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 [&::-webkit-details-marker]:hidden">
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform group-open:rotate-90">
          <path fillRule="evenodd" d="M7 5l6 5-6 5V5z" clipRule="evenodd" />
        </svg>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[t.status] ?? STATUS_TONE.drafted}`}>{(t.status ?? 'drafted').replace(/_/g, ' ')}</span>
        {count > 1 && <span className="shrink-0 text-[11px] text-zinc-400">{count}</span>}
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">{subject}</span>
          {preview && <span className="text-zinc-500 dark:text-zinc-400"> — {preview}</span>}
        </span>
        <span className="shrink-0 text-xs text-zinc-400">{fmtWhen(t.lastAt)}</span>
      </summary>

      {t.transactions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-zinc-100 px-4 py-2 dark:border-zinc-800">
          <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">Linked:</span>
          {t.transactions.map((x) => (
            <Link
              key={x.id}
              href={`/transactions/${x.id}?back=/connections/communications&backLabel=Communications`}
              className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-600 hover:border-blue-300 hover:text-blue-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-blue-300"
            >
              {x.label}
            </Link>
          ))}
        </div>
      )}

      <div className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
        {t.messages.map((m, i) => {
          const out = m.direction === 'outbound';
          const sender = out ? 'RocketBooks AI' : m.from || 'Client';
          const initial = out ? 'AI' : (m.from || 'C').trim().charAt(0).toUpperCase();
          return (
            <div key={i} className="flex gap-3 px-4 py-3">
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                  out ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200'
                }`}
              >
                {initial}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <div className="text-sm">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">{sender}</span>
                    <span className="text-xs text-zinc-400"> {out ? 'to client' : 'to RocketBooks'}</span>
                  </div>
                  <span className="text-xs text-zinc-400">{fmtWhen(m.at)}</span>
                </div>
                {m.subject && <div className="mt-0.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">{m.subject}</div>}
                {m.body && (
                  <div className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{m.body}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function hrefWith(params: { q?: string; type?: string }): string {
  const sp = new URLSearchParams();
  if (params.q) sp.set('q', params.q);
  if (params.type) sp.set('type', params.type);
  const s = sp.toString();
  return s ? `/connections/communications?${s}` : '/connections/communications';
}

export default async function CommunicationsPage({ searchParams }: { searchParams: Promise<{ q?: string; type?: string }> }) {
  await requirePermission('accounting.transactions.view');
  const orgId = await getCurrentOrgId();
  const { q, type } = await searchParams;
  const query = (q ?? '').trim();
  const activeType = (type ?? '').trim();

  const all = await listCommunications(orgId, query);

  // Type counts come from the search-matched set, so the pills reflect the
  // current search; the active-type filter then narrows what we render.
  const counts = new Map<string, number>();
  for (const t of all) counts.set(t.issueType, (counts.get(t.issueType) ?? 0) + 1);
  const types = [...counts.entries()].sort((a, b) => b[1] - a[1] || issueLabel(a[0]).localeCompare(issueLabel(b[0])));

  const threads = activeType ? all.filter((t) => t.issueType === activeType) : all;

  // Group by calendar week / calendar month / older. Threads are already sorted
  // newest-first, so each bucket stays in order. (Server time = UTC on Vercel.)
  const now = new Date();
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const sow = new Date(now);
  sow.setHours(0, 0, 0, 0);
  sow.setDate(sow.getDate() - sow.getDay()); // back up to Sunday
  const startWeek = sow.getTime();
  const bucketOf = (iso: string | null): 0 | 1 | 2 => {
    const t = iso ? new Date(iso).getTime() : NaN;
    if (Number.isNaN(t)) return 2;
    if (t >= startWeek) return 0;
    if (t >= startMonth) return 1;
    return 2;
  };
  const groups: { key: string; label: string; items: typeof threads }[] = [
    { key: 'week', label: 'This week', items: [] },
    { key: 'month', label: 'Earlier this month', items: [] },
    { key: 'older', label: 'Older', items: [] },
  ];
  for (const t of threads) groups[bucketOf(t.lastAt)].items.push(t);
  const filledGroups = groups.filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Communications</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Every email between the assistant and the client — outreach and replies, threaded and linked to the transactions they’re about.
        </p>
      </header>

      <form method="get" className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search subject, body, sender, or transaction…"
          className="w-full max-w-md rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 dark:border-zinc-700 dark:bg-zinc-900"
        />
        {activeType && <input type="hidden" name="type" value={activeType} />}
        <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
          Search
        </button>
        {(query || activeType) && (
          <Link href="/connections/communications" className="rounded-md px-3 py-1.5 text-sm text-zinc-500 hover:underline">
            Clear
          </Link>
        )}
      </form>

      {types.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Link
            href={hrefWith({ q: query })}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${!activeType ? 'border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950/40 dark:text-blue-300' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900'}`}
          >
            All ({all.length})
          </Link>
          {types.map(([t, n]) => (
            <Link
              key={t}
              href={hrefWith({ q: query, type: t })}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${activeType === t ? 'border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950/40 dark:text-blue-300' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900'}`}
            >
              {issueLabel(t)} ({n})
            </Link>
          ))}
        </div>
      )}

      {threads.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          {query || activeType ? 'No communications match your filters.' : 'No communications yet. When the assistant emails a client (and they reply), the conversation shows up here.'}
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {filledGroups.map((g) => (
            <details key={g.key} open={g.key !== 'older'} className="group">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold uppercase tracking-wide text-zinc-500 select-none [&::-webkit-details-marker]:hidden">
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform group-open:rotate-90">
                  <path fillRule="evenodd" d="M7 5l6 5-6 5V5z" clipRule="evenodd" />
                </svg>
                {g.label} <span className="font-normal text-zinc-400">({g.items.length})</span>
              </summary>
              <div className="mt-3 flex flex-col gap-3">
                {g.items.map((t) => (
                  <Thread key={t.id} t={t} />
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
