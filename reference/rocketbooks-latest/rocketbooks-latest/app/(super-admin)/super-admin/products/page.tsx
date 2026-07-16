import Link from 'next/link';
import { asc, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { billingProducts } from '@/db/schema/schema';
import { AdminPage, Panel } from '@/components/admin/AdminPage';
import { deleteProductAction } from './_actions/products';

export const dynamic = 'force-dynamic';

function formatAmount(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function featureLabel(featureKey: string, periodYear: number | null): string {
  if (featureKey === 'base_seat') return 'Base seat';
  if (featureKey === 'current_year_unlock') return 'Current-year unlock';
  if (featureKey === 'prior_year') return `Prior year ${periodYear ?? '?'}`;
  return featureKey;
}

export default async function BillingProductsPage() {
  const rows = await db
    .select()
    .from(billingProducts)
    .orderBy(asc(billingProducts.featureKey), desc(billingProducts.periodYear), asc(billingProducts.name));

  return (
    <AdminPage
      title="Billing Products"
      crumbs={[{ label: 'SuperAdmin', href: '/super-admin/dashboard' }, { label: 'Billing Products' }]}
      actions={
        <Link href="/super-admin/products/new" className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700">
          + Add Product
        </Link>
      }
    >
      <Panel>
        <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Feature</th>
                <th className="px-4 py-2.5">Kind</th>
                <th className="px-4 py-2.5 text-right">Price</th>
                <th className="px-4 py-2.5">Stripe Price ID</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-zinc-500">
                    No products defined. Add one to wire up Stripe.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-4 py-2.5">
                      <Link href={`/super-admin/products/${r.id}/edit`} className="font-medium text-blue-700 hover:underline dark:text-blue-300">
                        {r.name}
                      </Link>
                      {r.description && (
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">{r.description}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">{featureLabel(r.featureKey, r.periodYear)}</td>
                    <td className="px-4 py-2.5 text-xs text-zinc-600 dark:text-zinc-400">{r.kind}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatAmount(r.unitAmountCents, r.currency)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{r.stripePriceId ?? <span className="text-red-600 dark:text-red-400">missing</span>}</td>
                    <td className="px-4 py-2.5">
                      {r.active ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">Active</span>
                      ) : (
                        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">Inactive</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="inline-flex items-center gap-1">
                        <Link href={`/super-admin/products/${r.id}/edit`} className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
                          Edit
                        </Link>
                        <form action={deleteProductAction} className="inline">
                          <input type="hidden" name="id" value={r.id} />
                          <button
                            type="submit"
                            className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
                          >
                            Delete
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Showing {rows.length} {rows.length === 1 ? 'product' : 'products'}
        </div>
      </Panel>
    </AdminPage>
  );
}
