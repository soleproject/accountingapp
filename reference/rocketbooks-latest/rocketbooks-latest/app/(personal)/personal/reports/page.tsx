import { requireSession } from '@/lib/auth/session';
import { getCategoryBreakdown, getMonthlyTrends } from '@/lib/personal/reports';
import { ReportsView } from './_components/ReportsView';

export const dynamic = 'force-dynamic';

export default async function PersonalReportsPage() {
  const user = await requireSession();
  const now = new Date();
  const [initialBreakdown, trends] = await Promise.all([
    getCategoryBreakdown(user.id, { kind: 'preset', period: 'this_month' }, now),
    getMonthlyTrends(user.id, now, 12),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Trends, income vs expense, and spending by category — click a category to drill in</p>
      </header>
      <ReportsView initialBreakdown={initialBreakdown} trends={trends} />
    </div>
  );
}
