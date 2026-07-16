import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { db } from '@/db/client';
import { billingProducts } from '@/db/schema/schema';
import { AdminPage, Panel } from '@/components/admin/AdminPage';
import { ProductForm } from '../../_components/ProductForm';
import { StripeSyncButton } from '../../_components/StripeSyncButton';
import { updateProductAction, syncProductToStripeAction, updateStripePriceAction } from '../../_actions/products';

export const dynamic = 'force-dynamic';

// Stripe Dashboard URL helper. Always test-mode unless the key clearly is
// live — keeps the link out of the live dashboard for prod-keyed dev work.
function stripeDashboardProductUrl(productId: string): string {
  const live = (process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_live_');
  return live
    ? `https://dashboard.stripe.com/products/${productId}`
    : `https://dashboard.stripe.com/test/products/${productId}`;
}

export default async function EditBillingProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [row] = await db.select().from(billingProducts).where(eq(billingProducts.id, id)).limit(1);
  if (!row) notFound();

  const fullyLinked = Boolean(row.stripeProductId && row.stripePriceId);
  const partiallyLinked = Boolean(row.stripeProductId || row.stripePriceId) && !fullyLinked;

  return (
    <AdminPage
      title={`Edit: ${row.name}`}
      crumbs={[
        { label: 'SuperAdmin', href: '/super-admin/dashboard' },
        { label: 'Billing Products', href: '/super-admin/products' },
        { label: row.name },
      ]}
    >
      <Panel className="p-5">
        <ProductForm
          action={updateProductAction}
          submitLabel="Save Changes"
          initial={{
            id: row.id,
            name: row.name,
            description: row.description,
            featureKey: row.featureKey,
            kind: row.kind,
            periodYear: row.periodYear,
            unitAmountCents: row.unitAmountCents,
            currency: row.currency,
            active: row.active,
          }}
        />
      </Panel>

      <Panel className="p-5">
        <h2 className="text-base font-semibold">Stripe link</h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Stripe is the source of truth for billing. Click below and we&apos;ll create the matching Product and Price in
          Stripe using the values above, then store the IDs here automatically.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Stripe Product ID</div>
            <div className="mt-1 font-mono text-sm">
              {row.stripeProductId ? (
                <a
                  href={stripeDashboardProductUrl(row.stripeProductId)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-700 hover:underline dark:text-blue-300"
                >
                  {row.stripeProductId}
                </a>
              ) : (
                <span className="text-zinc-500 dark:text-zinc-400">— not linked —</span>
              )}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Stripe Price ID</div>
            <div className="mt-1 font-mono text-sm">
              {row.stripePriceId ? (
                row.stripePriceId
              ) : (
                <span className="text-zinc-500 dark:text-zinc-400">— not linked —</span>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            {fullyLinked ? (
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                Fully linked
              </span>
            ) : (
              <StripeSyncButton
                action={syncProductToStripeAction}
                id={row.id}
                label={partiallyLinked ? 'Finish Stripe link' : 'Create in Stripe'}
              />
            )}
            {partiallyLinked && (
              <span className="text-xs text-amber-700 dark:text-amber-300">
                Partial: {row.stripeProductId ? 'Price missing' : 'Product missing'} — click to create it.
              </span>
            )}
          </div>
          {fullyLinked && (
            <div className="flex flex-wrap items-center gap-3">
              <StripeSyncButton
                action={updateStripePriceAction}
                id={row.id}
                label="Sync price to Stripe"
                variant="secondary"
              />
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Stripe Prices are immutable. Save the unit amount above first, then click to create a new Stripe Price at that amount and archive the old one.
              </span>
            </div>
          )}
        </div>
      </Panel>
    </AdminPage>
  );
}
