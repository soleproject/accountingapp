import Link from 'next/link';
import { requirePermission } from '@/lib/auth/permissions';
import { getCurrentOrgId } from '@/lib/auth/org';
import { loadYearEndClose, type CloseItem } from '@/lib/accounting/year-end-close';
import { toggleCloseItem } from './_actions/toggleItem';

interface PageProps {
  searchParams: Promise<{ year?: string }>;
}

export default async function YearEndClosePage({ searchParams }: PageProps) {
  await requirePermission('accounting.reports.view');
  const orgId = await getCurrentOrgId();
  const { year: yearParam } = await searchParams;
  const thisYear = new Date().getFullYear();
  const py = Number(yearParam);
  const year = Number.isInteger(py) && py >= 2000 && py <= thisYear + 1 ? py : thisYear - 1;

  const data = await loadYearEndClose(orgId, year);
  const years = [thisYear, thisYear - 1, thisYear - 2];
  const pct = data.total > 0 ? Math.round((data.done / data.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Year-End Close</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Everything to button up the {year} books</p>
        </div>
        <form className="flex items-center gap-2">
          <label className="text-xs text-zinc-500">Year</label>
          <select name="year" defaultValue={String(year)} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">Apply</button>
        </form>
      </header>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">{data.done} of {data.total} complete</span>
          <span className="text-zinc-500">{pct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div className={`h-full rounded-full ${pct === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {data.items.map((item) => (
          <Item key={item.key} item={item} year={year} />
        ))}
      </div>

      <p className="text-xs text-zinc-400">
        Auto items reflect your books live. Manual items are checked off here and saved per year. Pure-info items (e.g. adjusting-entry count) don’t count toward progress.
      </p>
    </div>
  );
}

const STATUS_ICON: Record<string, { glyph: string; cls: string }> = {
  done: { glyph: '✓', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  attention: { glyph: '!', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  info: { glyph: 'i', cls: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400' },
};

function Item({ item, year }: { item: CloseItem; year: number }) {
  const icon = STATUS_ICON[item.status] ?? STATUS_ICON.info;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${icon.cls}`}>{icon.glyph}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.title}</span>
          {item.kind === 'manual' && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800">Manual</span>}
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{item.description}</div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className={`text-xs ${item.status === 'attention' ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-zinc-500'}`}>{item.detail}</span>
        {item.href && (
          <Link href={item.href} className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400">Open →</Link>
        )}
        {item.kind === 'manual' && (
          <form action={toggleCloseItem}>
            <input type="hidden" name="itemKey" value={item.key} />
            <input type="hidden" name="year" value={String(year)} />
            <input type="hidden" name="done" value={item.manualDone ? 'false' : 'true'} />
            <button type="submit" className={`rounded-md border px-2.5 py-1 text-xs font-medium ${item.manualDone ? 'border-zinc-300 text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900' : 'border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30'}`}>
              {item.manualDone ? 'Undo' : 'Mark done'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
