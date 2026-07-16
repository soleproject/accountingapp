import { requirePermission } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

// Inventory is a Pro-tier feature (lib/accounting/tiers.ts → accounting.inventory.view,
// granted only by the Pro permission set). The gate hides this from Starter/Plus;
// the full module (items, stock, COGS, valuation, purchase orders) ships later, so
// this page is an intentional "coming soon" stub for Pro users today.
export default async function InventoryPage() {
  await requirePermission('accounting.inventory.view');

  const features = [
    { title: 'Stock tracking', desc: 'Track quantities on hand across items and locations.' },
    { title: 'COGS & valuation', desc: 'Cost of goods sold and inventory valuation flow into your books automatically.' },
    { title: 'Purchase orders', desc: 'Create POs, receive stock, and reconcile against bills.' },
    { title: 'Low-stock alerts', desc: 'Know when to reorder before you run out.' },
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Inventory</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Track stock, COGS, and valuation — built right into your accounting.
          </p>
        </div>
        <span className="rounded-full bg-teal-100 px-2.5 py-1 text-xs font-medium text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
          Pro plan
        </span>
      </header>

      <section className="rounded-lg border border-dashed border-zinc-300 bg-white px-6 py-10 text-center dark:border-zinc-700 dark:bg-zinc-950">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-teal-100 text-teal-600 dark:bg-teal-950/60 dark:text-teal-300">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
            <line x1="12" y1="22.08" x2="12" y2="12" />
          </svg>
        </div>
        <h2 className="mt-4 text-lg font-semibold">Inventory is coming soon</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">
          You&rsquo;re on the Pro plan, so inventory is included. We&rsquo;re putting the
          finishing touches on it — here&rsquo;s what&rsquo;s on the way.
        </p>
      </section>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {features.map((f) => (
          <div
            key={f.title}
            className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
          >
            <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{f.title}</h3>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{f.desc}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
