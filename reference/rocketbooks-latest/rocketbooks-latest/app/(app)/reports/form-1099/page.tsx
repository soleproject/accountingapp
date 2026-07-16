import Link from 'next/link';
import { requirePermission, hasAnyPermission } from '@/lib/auth/permissions';
import { getCurrentOrgId } from '@/lib/auth/org';
import { loadForm1099Summary } from '@/lib/reports/form-1099-data';
import { requestW9, requestAllW9 } from './_actions/requestW9';
import { runSuggestions, acceptSuggestion, dismissSuggestion } from './_actions/suggest';
import { NotifyActionButton } from '@/components/ai-assistant/NotifyActionButton';

interface PageProps {
  searchParams: Promise<{ year?: string }>;
}

const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

const W9_LABEL: Record<string, string> = {
  not_requested: 'Not requested',
  requested: 'Requested',
  on_file: 'On file',
};
const W9_TONE: Record<string, string> = {
  on_file: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  requested: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  not_requested: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

export default async function Form1099Page({ searchParams }: PageProps) {
  await requirePermission('accounting.reports.view');
  const orgId = await getCurrentOrgId();
  const { year: yearParam } = await searchParams;
  const thisYear = new Date().getFullYear();
  const parsedYear = Number(yearParam);
  const year = Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= thisYear + 1 ? parsedYear : thisYear;

  const [data, canRequest] = await Promise.all([
    loadForm1099Summary(orgId, year),
    hasAnyPermission(['accounting.transactions.accountant_review', 'enterprise.dashboard.view', 'enterprise.clients.view']),
  ]);
  const years = [thisYear, thisYear - 1, thisYear - 2];
  const eligibleMissing = data.rows.filter((r) => r.eligible && r.w9Status !== 'on_file' && r.hasEmail).length;
  const fileable = data.rows.filter((r) => r.eligible && r.meetsThreshold).length;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">1099 Summary</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Vendors paid in {year} — who needs a 1099-NEC and who’s missing a W-9
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canRequest && (
            <form action={runSuggestions}>
              <input type="hidden" name="year" value={String(year)} />
              <button type="submit" className="rounded-md border border-violet-300 px-3 py-1 text-sm font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/30" title="Use AI to suggest which vendors likely need a 1099-NEC (you confirm each)">
                ✨ Suggest eligibility (AI)
              </button>
            </form>
          )}
          {canRequest && eligibleMissing > 0 && (
            <NotifyActionButton
              action={requestAllW9}
              message={`Sent W-9 requests to ${eligibleMissing} 1099-eligible vendor${eligibleMissing === 1 ? '' : 's'}. I'll watch for the forms to come back, and once they're on file we can generate the 1099-NECs.`}
              className="rounded-md border border-blue-300 px-3 py-1 text-sm font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/30"
              title="Email all 1099-eligible vendors (with an email, not yet on file) for their W-9"
            >
              ✉️ Request W-9 from {eligibleMissing} vendor{eligibleMissing === 1 ? '' : 's'}
            </NotifyActionButton>
          )}
          {canRequest && fileable > 0 && (
            <a
              href={`/api/reports/form-1099/pdf?year=${year}`}
              className="rounded-md border border-emerald-300 px-3 py-1 text-sm font-medium text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
              title="Generate a 1099-NEC PDF (one page per confirmed-eligible vendor paid ≥ $600)"
            >
              ⬇ 1099-NEC PDF ({fileable})
            </a>
          )}
          <form className="flex items-center gap-2">
            <label className="text-xs text-zinc-500">Tax year</label>
            <select name="year" defaultValue={String(year)} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900">
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
            <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">Apply</button>
          </form>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Vendors listed" value={String(data.totals.vendors)} />
        <Stat label={`Paid ≥ ${fmt(data.threshold)}`} value={String(data.totals.overThreshold)} />
        <Stat label="Missing W-9 / TIN" value={String(data.totals.missingPaperwork)} tone={data.totals.missingPaperwork > 0 ? 'amber' : undefined} />
        <Stat label="Total reportable" value={fmt(data.totals.totalReportable)} />
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Vendor</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Paid in {year}</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">1099?</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">W-9</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">TIN</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500" />
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-zinc-500">No 1099 vendors yet. Mark a contact “1099-eligible,” or anyone paid ≥ {fmt(data.threshold)} in expenses will appear here.</td></tr>
            )}
            {data.rows.map((r) => (
              <tr key={r.contactId} className={`border-t border-zinc-100 dark:border-zinc-800 ${r.needsAttention ? 'bg-amber-50/40 dark:bg-amber-950/10' : ''}`}>
                <td className="px-4 py-2">
                  <Link href={`/contacts/${r.contactId}`} className="font-medium text-zinc-900 hover:underline dark:text-zinc-100">{r.name}</Link>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.totalPaid)}</td>
                <td className="px-4 py-2">
                  {r.eligible ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">Eligible</span>
                  ) : r.aiSuggestion === true && canRequest ? (
                    <div className="flex flex-col gap-1">
                      <span className="w-fit rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-800 dark:bg-violet-900/40 dark:text-violet-300" title={r.aiReason ?? ''}>✨ Likely 1099</span>
                      <div className="flex items-center gap-2 text-[11px]">
                        <form action={acceptSuggestion} className="inline">
                          <input type="hidden" name="contactId" value={r.contactId} />
                          <button type="submit" className="font-medium text-emerald-700 hover:underline dark:text-emerald-400">Accept</button>
                        </form>
                        <form action={dismissSuggestion} className="inline">
                          <input type="hidden" name="contactId" value={r.contactId} />
                          <button type="submit" className="text-zinc-400 hover:underline">Dismiss</button>
                        </form>
                      </div>
                      {r.aiReason && <span className="text-[10px] text-zinc-400">{r.aiReason}</span>}
                    </div>
                  ) : r.aiSuggestion === false ? (
                    <span className="text-xs text-zinc-400" title={r.aiReason ?? 'AI: likely exempt'}>Likely exempt</span>
                  ) : r.meetsThreshold ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">Review</span>
                  ) : (
                    <span className="text-xs text-zinc-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${W9_TONE[r.w9Status] ?? W9_TONE.not_requested}`}>{W9_LABEL[r.w9Status] ?? r.w9Status}</span>
                </td>
                <td className="px-4 py-2 text-xs">{r.hasTaxId ? <span className="text-emerald-600 dark:text-emerald-400">On file</span> : <span className="text-zinc-400">Missing</span>}</td>
                <td className="px-4 py-2 text-right">
                  {r.w9Status !== 'on_file' && (
                    canRequest && r.hasEmail ? (
                      <form action={requestW9} className="inline">
                        <input type="hidden" name="contactId" value={r.contactId} />
                        <button type="submit" className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-400" title="Email this vendor for their W-9">
                          {r.w9Status === 'requested' ? 'Resend W-9 ↻' : 'Request W-9 ✉️'}
                        </button>
                      </form>
                    ) : (
                      <Link href={`/contacts/${r.contactId}`} className="text-xs font-medium text-amber-700 hover:underline dark:text-amber-400">Add W-9 →</Link>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-zinc-400">
        Totals come from expense transactions categorized to each contact for the year. Card payments are excluded from 1099s (the processor files a 1099-K), and payment method isn’t tracked here — so confirm eligibility per vendor. <strong>Suggest eligibility (AI)</strong> reads each vendor’s name + expense categories to guess who likely needs a 1099-NEC (corporations, retailers, and goods/SaaS are flagged exempt); it only suggests — you Accept to confirm. Highlighted rows are paid ≥ {fmt(data.threshold)} (or flagged) but missing a W-9 or TIN.
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'amber' }) {
  return (
    <div className={`rounded-lg border p-4 ${tone === 'amber' ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30' : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950'}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${tone === 'amber' ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-900 dark:text-zinc-100'}`}>{value}</div>
    </div>
  );
}
