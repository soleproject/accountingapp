'use client';

import dynamic from 'next/dynamic';
import type { AgingBuckets, CashSeriesRow, DailyRow } from '../_data/loader';

const CardLoading = () => (
  <section className="flex h-56 items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
    Loading chart…
  </section>
);

const CashFlowCard = dynamic(() => import('./CashFlowCard').then((m) => m.CashFlowCard), { ssr: false, loading: CardLoading });
const IncomeExpenseCard = dynamic(() => import('./IncomeExpenseCard').then((m) => m.IncomeExpenseCard), { ssr: false, loading: CardLoading });
const ProfitLossCard = dynamic(() => import('./ProfitLossCard').then((m) => m.ProfitLossCard), { ssr: false, loading: CardLoading });
const AgingCard = dynamic(() => import('./AgingCard').then((m) => m.AgingCard), { ssr: false, loading: CardLoading });
const TopCategoriesCard = dynamic(() => import('./TopCategoriesCard').then((m) => m.TopCategoriesCard), { ssr: false, loading: CardLoading });

interface Props {
  days: number;
  withExtrapolation: boolean;
  today: string;
  cashSeries: CashSeriesRow[];
  cashNow: number;
  projectedCash: number;
  daily: DailyRow[];
  arAging: AgingBuckets;
  apAging: AgingBuckets;
  topCategories: Array<{ name: string; amount: number }>;
}

export function PulseCharts({
  days,
  withExtrapolation,
  today,
  cashSeries,
  cashNow,
  projectedCash,
  daily,
  arAging,
  apAging,
  topCategories,
}: Props) {
  return (
    <>
      <div data-tour="pulse-cash-flow">
        <CashFlowCard
          windowDays={days}
          cashSeries={cashSeries}
          cashNow={cashNow}
          projectedCash={projectedCash}
          withExtrapolation={withExtrapolation}
          today={today}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div data-tour="pulse-income-expense">
          <IncomeExpenseCard daily={daily} windowDays={days} />
        </div>
        <div data-tour="pulse-profit-loss">
          <ProfitLossCard daily={daily} windowDays={days} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div data-tour="pulse-ar-aging">
          <AgingCard kind="ar" aging={arAging} windowDays={days} />
        </div>
        <div data-tour="pulse-ap-aging">
          <AgingCard kind="ap" aging={apAging} windowDays={days} />
        </div>
      </div>

      <div data-tour="pulse-top-categories">
        <TopCategoriesCard categories={topCategories} windowDays={days} />
      </div>
    </>
  );
}
