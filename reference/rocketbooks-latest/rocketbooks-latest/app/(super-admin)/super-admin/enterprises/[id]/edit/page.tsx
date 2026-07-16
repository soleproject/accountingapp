import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { AdminPage, Panel } from '@/components/admin/AdminPage';
import { ClientPlanVisibility } from '@/components/enterprise/ClientPlanVisibility';
import { listGatedProducts, getEnterpriseAllowedProductIds } from '@/lib/enterprise/client-products';
import { updateEnterpriseAction, deleteEnterpriseAction } from '../../../_actions/admin';

export const dynamic = 'force-dynamic';

export default async function EnterpriseEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [org] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  if (!org) notFound();

  const [gatedProducts, allowedIds] = await Promise.all([
    listGatedProducts(),
    getEnterpriseAllowedProductIds(id),
  ]);

  return (
    <AdminPage
      title={`Edit ${org.name}`}
      crumbs={[
        { label: 'SuperAdmin', href: '/super-admin/dashboard' },
        { label: 'Enterprises', href: '/super-admin/enterprises' },
        { label: org.name, href: `/super-admin/enterprises/${id}` },
        { label: 'Edit' },
      ]}
    >
      <Panel title="Details">
        <form action={updateEnterpriseAction} className="flex flex-col gap-4">
          <input type="hidden" name="id" value={id} />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Name <span className="text-red-500">*</span></span>
              <input
                type="text"
                name="name"
                required
                defaultValue={org.name}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Plan</span>
              <select
                name="planType"
                defaultValue={org.planType}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="enterprise">enterprise</option>
                <option value="pro">pro</option>
                <option value="free">free</option>
                <option value="archived">archived</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Domain</span>
              <input
                type="text"
                name="domain"
                defaultValue={org.domain ?? ''}
                placeholder="example.com"
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">White-label subdomain</span>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  name="subdomain"
                  defaultValue={org.subdomain ?? ''}
                  placeholder="acme"
                  className="w-40 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                />
                <span className="text-zinc-500">.accountingapp.ai</span>
              </div>
              <span className="text-xs text-zinc-500">Branded sign-in host for this firm. Blank to clear.</span>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Website</span>
              <input
                type="url"
                name="website"
                defaultValue={org.website ?? ''}
                placeholder="https://example.com"
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Email</span>
              <input
                type="email"
                name="email"
                defaultValue={org.email ?? ''}
                placeholder="contact@example.com"
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Phone</span>
              <input
                type="tel"
                name="phone"
                defaultValue={org.phone ?? ''}
                placeholder="+1 (555) 123-4567"
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
          </div>

          {/* Features */}
          <fieldset className="flex flex-col gap-2 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
            <legend className="px-1 text-sm font-medium">Features</legend>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="entityTypeOnboardingEnabled"
                defaultChecked={org.entityTypeOnboardingEnabled}
                className="mt-1"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">Entity Type Onboarding</span>
                <span className="text-xs text-zinc-500">
                  When enabled, this enterprise&rsquo;s clients are asked to identify
                  their entity type (LLC, Corp, beneficial trust, etc.) during
                  onboarding. Selecting a trust entity activates trust-specific
                  chart of accounts and posting rules for that client&rsquo;s
                  organization. When disabled, clients see the standard onboarding
                  flow with no entity-type step.
                </span>
              </span>
            </label>
          </fieldset>

          {/* Logo */}
          <fieldset className="flex flex-col gap-2 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
            <legend className="px-1 text-sm font-medium">Logo</legend>
            <div className="flex items-center gap-4">
              <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
                {org.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={org.logoUrl} alt={`${org.name} logo`} className="h-full w-full object-contain" />
                ) : (
                  <span className="text-xs text-zinc-400">No logo</span>
                )}
              </div>
              <div className="flex flex-1 flex-col gap-2">
                <input
                  type="file"
                  name="logo"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-zinc-200 dark:file:bg-zinc-800 dark:hover:file:bg-zinc-700"
                />
                <span className="text-xs text-zinc-500">PNG, JPG, SVG, or WEBP. Max 5MB.</span>
                {org.logoUrl && (
                  <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                    <input type="checkbox" name="removeLogo" />
                    <span>Remove the current logo (uncheck to keep)</span>
                  </label>
                )}
              </div>
            </div>
          </fieldset>

          <div className="flex items-center justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <Link
              href={`/super-admin/enterprises/${id}`}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Cancel
            </Link>
            <button
              type="submit"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
            >
              Save changes
            </button>
          </div>
        </form>
      </Panel>

      <Panel title="Client plan visibility">
        <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
          Custom billing plans are hidden from clients by default. Check the ones this enterprise&rsquo;s
          clients should see (and be able to buy) on their <span className="font-mono text-xs">/billing</span> page.
          Built-in plans (base subscription, year unlocks) are always available and aren&rsquo;t listed here.
        </p>
        <ClientPlanVisibility
          enterpriseId={id}
          products={gatedProducts}
          initialSelected={[...allowedIds]}
        />
      </Panel>

      <Panel title="Danger Zone">
        <form action={deleteEnterpriseAction} className="flex items-center justify-between gap-4">
          <input type="hidden" name="id" value={id} />
          <div>
            <div className="text-sm font-medium">Archive this enterprise</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              Sets plan to <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs dark:bg-zinc-800">archived</code>. Staff and clients are kept; the enterprise stops appearing in lists.
            </div>
          </div>
          <button
            type="submit"
            className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
          >
            Archive
          </button>
        </form>
      </Panel>
    </AdminPage>
  );
}
