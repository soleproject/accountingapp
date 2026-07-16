import { BillingClient } from './_components/BillingClient';

interface PageProps {
  searchParams: Promise<{ checkout?: string; unlock?: string; year?: string; tab?: string }>;
}

export const dynamic = 'force-dynamic';

export default async function BillingPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const query = new URLSearchParams();
  if (sp.tab) query.set('tab', sp.tab);
  const queryString = query.toString() ? `?${query.toString()}` : '';

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Manage your Rocket Suite subscription.</p>
      </header>

      {sp.checkout === 'success' && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
          Payment received. Your subscription is being activated — it should appear below within a few seconds.
        </div>
      )}
      {sp.checkout === 'cancel' && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          Checkout canceled — no charge was made. Click Subscribe whenever you&apos;re ready.
        </div>
      )}
      {sp.unlock === 'success' && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
          Unlock {sp.year ? `for ${sp.year}` : ''} purchased. It should appear under Year unlocks within a few seconds.
        </div>
      )}
      {sp.unlock === 'cancel' && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          Unlock checkout canceled — no charge was made.
        </div>
      )}

      <BillingClient query={queryString} />
    </div>
  );
}
