import { countAllPendingByYear } from '@/lib/billing/plaid-pending';
import { resolveUnlockProduct } from '@/lib/billing/entitlements';
import { startUnlockCheckoutAction } from '@/app/(app)/billing/_actions/billing';

/**
 * Amber section listing per-year pending import counts with Buy buttons.
 * Mounted on /billing AND /imports so customers see the CTA in whichever
 * surface they hit first after Plaid sync / Veryfi PDF upload finds rows
 * outside their coverage.
 *
 * Returns null when there's nothing pending OR the org isn't subscribed
 * (the count helper short-circuits to [] for unsubscribed orgs by design).
 */
function formatCurrency(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

export async function PendingImportsSection({ orgId }: { orgId: string }) {
  const pending = await countAllPendingByYear(orgId);
  if (pending.length === 0) return null;

  const currentYear = new Date().getUTCFullYear();
  const offers = await Promise.all(
    pending.map(async (p) => {
      const sku = await resolveUnlockProduct(
        p.year === currentYear ? 'current_year_unlock' : 'prior_year',
        p.year,
      );
      return { year: p.year, count: p.count, sku };
    }),
  );

  return (
    <section className="overflow-hidden rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30">
      <header className="border-b border-amber-200 bg-amber-100 px-4 py-2 dark:border-amber-900/60 dark:bg-amber-950/50">
        <h2 className="text-sm font-medium uppercase tracking-wide text-amber-900 dark:text-amber-200">Imports waiting on a year unlock</h2>
      </header>
      <div className="px-4 py-4">
        <p className="text-xs text-amber-900 dark:text-amber-200">
          These bank transactions came in via Plaid sync or a PDF bank-statement upload, but couldn&apos;t be imported because your subscription doesn&apos;t cover their year yet. Buy the matching unlock and we&apos;ll import them automatically.
        </p>
        <ul className="mt-4 flex flex-col gap-2">
          {offers.map((p) => (
            <li key={p.year} className="flex flex-wrap items-center gap-3">
              <span className="text-sm">
                <strong className="font-medium">{p.count.toLocaleString()}</strong> transaction{p.count === 1 ? '' : 's'} in <strong className="font-medium">{p.year}</strong>
              </span>
              {p.sku?.stripeReady ? (
                <form action={startUnlockCheckoutAction}>
                  <input type="hidden" name="billingProductId" value={p.sku.id} />
                  <button
                    type="submit"
                    className="rounded-md border border-blue-300 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-900 dark:bg-zinc-950 dark:text-blue-200 dark:hover:bg-blue-950/40"
                  >
                    Buy {p.year} unlock — {formatCurrency(p.sku.unitAmountCents, p.sku.currency)}
                  </button>
                </form>
              ) : (
                <span className="text-xs italic text-amber-900/70 dark:text-amber-200/70">
                  No {p.year} unlock product configured — ask a super-admin to add it.
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
