import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { loadPulse, parseWindow } from './_data/loader';
import { PulseRegistration } from './_components/PulseRegistration';
import { PulseHeader } from './_components/PulseHeader';
import { KpiTiles } from './_components/KpiTiles';
import { PulseCharts } from './_components/PulseCharts';

interface PageProps {
  searchParams: Promise<{ days?: string; ext?: string }>;
}

export default async function PulsePage({ searchParams }: PageProps) {
  const orgId = await getCurrentOrgId();
  const { days: daysParam, ext: extParam } = await searchParams;
  const days = parseWindow(daysParam);
  const withExtrapolation = extParam === '1';

  const [[org], pulse] = await Promise.all([
    db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1),
    loadPulse({ orgId, days, withExtrapolation }),
  ]);
  const orgName = org?.name ?? 'this business';

  return (
    <div className="flex flex-col gap-6">
      <PulseRegistration
        windowDays={days}
        withExtrapolation={withExtrapolation}
        orgName={orgName}
        kpis={pulse.kpis}
      />
      <PulseHeader windowDays={days} withExtrapolation={withExtrapolation} orgName={orgName} />

      <div data-tour="pulse-kpis">
        <KpiTiles kpis={pulse.kpis} windowDays={days} />
      </div>

      <PulseCharts
        days={days}
        withExtrapolation={withExtrapolation}
        today={pulse.window.today}
        cashSeries={pulse.cashSeries}
        cashNow={pulse.kpis.cashNow}
        projectedCash={pulse.kpis.projectedCashAtForwardEnd}
        daily={pulse.daily}
        arAging={pulse.arAging}
        apAging={pulse.apAging}
        topCategories={pulse.topCategories}
      />
    </div>
  );
}
