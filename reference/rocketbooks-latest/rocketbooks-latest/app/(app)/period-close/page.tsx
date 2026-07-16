import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { accountingPeriods, organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId, isSuperAdmin } from '@/lib/auth/org';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { PeriodRow } from './_components/PeriodRow';
import type { PeriodStatus } from './_actions/transitionPeriod';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const BADGE: Record<PeriodStatus, string> = {
  open: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  reviewed: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  closed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
};

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
}

export default async function PeriodClosePage() {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const userId = await getEffectiveUserId();
  const [org] = await db.select({ owner: organizations.ownerUserId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const canManage = (!!org && org.owner === userId) || (await isSuperAdmin());

  const rows = await db
    .select({
      year: accountingPeriods.year,
      month: accountingPeriods.month,
      status: accountingPeriods.status,
      closedAt: accountingPeriods.closedAt,
      reviewedAt: accountingPeriods.reviewedAt,
    })
    .from(accountingPeriods)
    .where(eq(accountingPeriods.organizationId, orgId));
  const byKey = new Map(rows.map((r) => [`${r.year}-${r.month}`, r]));

  // Last 12 months, newest first.
  const now = new Date();
  const months: { year: number; month: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-2 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Close the books</h1>
      </div>
      <p className="mb-6 text-sm text-zinc-500">
        Mark a month <strong>reviewed</strong> once you&apos;ve checked it, then <strong>closed</strong> to lock it.
        A closed month rejects any new posting or edit dated in it until you reopen it.
      </p>

      <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 font-medium">Month</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Detail</th>
              <th className="px-4 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {months.map(({ year, month }) => {
              const row = byKey.get(`${year}-${month}`);
              const status = (row?.status as PeriodStatus) ?? 'open';
              const lastDay = new Date(year, month, 0).getDate();
              const asOf = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
              const detail =
                status === 'closed' ? `Closed ${fmtDate(row?.closedAt ?? null)}`
                : status === 'reviewed' ? `Reviewed ${fmtDate(row?.reviewedAt ?? null)}`
                : '';
              return (
                <tr key={`${year}-${month}`} className="bg-white dark:bg-zinc-950">
                  <td className="px-4 py-3">
                    <Link href={`/reports/trial-balance?asOf=${asOf}`} className="font-medium text-zinc-900 hover:underline dark:text-zinc-100">
                      {MONTHS[month - 1]} {year}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${BADGE[status]}`}>{status}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">{detail}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      <PeriodRow year={year} month={month} status={status} canManage={canManage} />
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
