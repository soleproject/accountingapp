import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, enterpriseClients } from '@/db/schema/schema';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { AdminPage, Panel } from '@/components/admin/AdminPage';
import { LogoSlot } from '@/components/org/LogoSlot';
import { EntityTypeOnboardingToggle } from '@/components/org/EntityTypeOnboardingToggle';
import { ClientPlanVisibility } from '@/components/enterprise/ClientPlanVisibility';
import { listGatedProducts, getEnterpriseAllowedProductIds } from '@/lib/enterprise/client-products';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { UpdatePasswordForm } from '../_components/UpdatePasswordForm';
import { ThemeStudio } from '../_components/ThemeStudio';
import { SubdomainCard } from '../_components/SubdomainCard';
import { PRIVATE_LABEL_ROOT } from '@/lib/enterprise/subdomain';
import { DEMO_ENTERPRISE_ID } from '@/lib/enterprise/demo';
import { firmHasPaymentMethod } from '@/lib/stripe/firm-billing';
import { startFirmBillingSetupAction } from '../_actions/firmBilling';
import { EnterpriseDefaultsForm } from '../_components/EnterpriseDefaultsForm';
import { TASK_CATALOG, parseResponsibilities, defaultOwnerFor } from '@/lib/enterprise/task-catalog';
import {
  setEnterpriseDefaultResponsibilitiesAction,
  applyFirmDefaultToClientAction,
} from '../_actions/enterpriseSettings';

export const dynamic = 'force-dynamic';

export default async function EnterpriseSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ saved?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const current = await getCurrentEnterprise();
  if (!current) notFound();

  const [[org], gatedProducts, allowedIds] = await Promise.all([
    db.select().from(organizations).where(eq(organizations.id, current.id)).limit(1),
    listGatedProducts(),
    getEnterpriseAllowedProductIds(current.id),
  ]);
  const enterpriseDefaults = parseResponsibilities(org?.enterpriseDefaultResponsibilities);
  const defaultBooks = org?.enterpriseDefaultBooksManagedBy ?? 'both';

  // Clients that DIFFER from the firm defaults on a task (a stored override that
  // no longer matches the current firm default). The firm can apply the default
  // per task, or leave the client on its custom setting.
  const TASK_BY_KEY = new Map(TASK_CATALOG.map((t) => [t.key, t]));
  const clientLinks = await db
    .select({ clientUserId: enterpriseClients.clientUserId })
    .from(enterpriseClients)
    .where(eq(enterpriseClients.enterpriseId, current.id));
  const clientUserIds = [...new Set(clientLinks.map((c) => c.clientUserId).filter(Boolean))];
  const clientOrgs = clientUserIds.length
    ? await db
        .select({
          id: organizations.id,
          name: organizations.name,
          taskResponsibilities: organizations.taskResponsibilities,
          booksManagedBy: organizations.booksManagedBy,
        })
        .from(organizations)
        .where(and(inArray(organizations.ownerUserId, clientUserIds), eq(organizations.planType, 'pro')))
    : [];
  const overrideClients = clientOrgs
    .map((o) => {
      const ov = parseResponsibilities(o.taskResponsibilities);
      const books = o.booksManagedBy === 'firm' || o.booksManagedBy === 'client' ? o.booksManagedBy : null;
      const diffs = Object.entries(ov)
        .map(([key, val]) => {
          const t = TASK_BY_KEY.get(key);
          if (!t) return null;
          const firmDefault = enterpriseDefaults[key] ?? defaultOwnerFor(t, books);
          return val !== firmDefault ? { key, label: t.label, clientValue: val, firmDefault } : null;
        })
        .filter((d): d is { key: string; label: string; clientValue: 'pro' | 'client'; firmDefault: 'pro' | 'client' } => !!d);
      return diffs.length ? { orgId: o.id, name: o.name, diffs } : null;
    })
    .filter((c): c is { orgId: string; name: string; diffs: { key: string; label: string; clientValue: 'pro' | 'client'; firmDefault: 'pro' | 'client' }[] } => !!c);

  // Firm billing card status — only relevant (and only hits Stripe) when the
  // firm covers its clients.
  const isFirmPays = org?.clientBillingMode === 'firm_pays' && current.id !== DEMO_ENTERPRISE_ID;
  const firmCardOnFile = isFirmPays ? await firmHasPaymentMethod(current.id) : false;

  return (
    <AdminPage
      title="Settings"
      crumbs={[{ label: 'Enterprise' }, { label: 'Settings' }]}
    >
      <Panel title="Enterprise Information">
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase text-zinc-500">Name</dt>
            <dd className="font-medium">{org?.name ?? current.name}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">Domain</dt>
            <dd>{org?.domain ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">Website</dt>
            <dd>{org?.website ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">Email</dt>
            <dd>{org?.email ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">Plan</dt>
            <dd>{org?.planType ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">Your Role</dt>
            <dd>{current.role}</dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Firm Setup">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Answers from your AI-guided firm setup. Re-run it anytime to change them.
          </p>
          <Link
            href="/enterprise/onboarding"
            className="shrink-0 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Edit setup
          </Link>
        </div>
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase text-zinc-500">Private label</dt>
            <dd className="font-medium">{org?.privateLabelEnabled ? 'Yes ($95/mo)' : 'No'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">AI assistant name</dt>
            <dd>{org?.aiAssistantName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">Brand color</dt>
            <dd className="flex items-center gap-2">
              {org?.brandColorHex ? (
                <>
                  <span className="inline-block h-4 w-4 rounded border border-zinc-300 dark:border-zinc-700" style={{ backgroundColor: org.brandColorHex }} />
                  {org.brandColorHex}
                  <span className="text-xs text-zinc-400">(applied later)</span>
                </>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">Sending email</dt>
            <dd>{org?.sendingFromEmail ?? 'accountingapp.ai'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">Who pays</dt>
            <dd>{org?.clientBillingMode === 'firm_pays' ? 'Firm pays' : org?.clientBillingMode === 'client_pays' ? 'Clients pay' : '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">Client pricing</dt>
            <dd>{org?.clientPriceMode === 'discount_69' ? '$69 discount' : org?.clientPriceMode === 'standard_referral' ? '$89 + referral' : '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">New-client setup</dt>
            <dd>{org?.clientOnboardingHandoff === 'meeting' ? 'AI books a meeting' : org?.clientOnboardingHandoff === 'self' ? 'Self-serve' : org?.clientOnboardingHandoff === 'pro' ? 'I set up clients' : '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">Client backend login</dt>
            <dd>{org?.clientBackendLoginEnabled ? 'Enabled' : 'Disabled'}</dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Default task responsibilities">
        {sp.saved === 'responsibilities' && (
          <div className="mb-3 rounded-md border border-emerald-300 bg-emerald-50 p-2.5 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
            Default responsibilities saved — all inheriting clients updated.
            {overrideClients.length > 0
              ? ` ${overrideClients.length} client${overrideClients.length === 1 ? '' : 's'} have custom settings (below) and kept theirs — review if you want them to match.`
              : ''}
          </div>
        )}
        <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
          Your firm-wide default for who owns each recurring task — your team or the client. Every
          client inherits these unless you override a task on its Edit business page. This drives which
          dashboard tab (Pro vs Client Attention) each item lands in.
        </p>
        <form action={setEnterpriseDefaultResponsibilitiesAction} className="flex flex-col gap-4">
          <EnterpriseDefaultsForm defaults={enterpriseDefaults} initialBooks={defaultBooks} />
          <div className="flex items-center justify-end border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <button
              type="submit"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
            >
              Save defaults
            </button>
          </div>
        </form>
      </Panel>

      <Panel title="Client-specific overrides">
        <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
          These clients differ from your firm defaults on specific tasks — they keep their custom
          setting even when you change a default. Apply the firm default to make a client inherit it
          again (this also re-routes that client&apos;s tasks).
        </p>
        {overrideClients.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No clients have custom settings — everyone inherits your firm defaults.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {overrideClients.map((c) => (
              <div key={c.orgId} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium">{c.name}</span>
                  <Link
                    href={`/enterprise/businesses/${c.orgId}/edit`}
                    className="text-xs text-blue-700 hover:underline dark:text-blue-300"
                  >
                    Edit business →
                  </Link>
                </div>
                <ul className="flex flex-col gap-1.5">
                  {c.diffs.map((d) => (
                    <li key={d.key} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-zinc-600 dark:text-zinc-400">
                        {d.label}:{' '}
                        <span className="font-medium text-zinc-800 dark:text-zinc-200">
                          {d.clientValue === 'pro' ? 'Accounting Pro' : 'Client'}
                        </span>
                        <span className="text-zinc-400">
                          {' '}· firm default = {d.firmDefault === 'pro' ? 'Accounting Pro' : 'Client'}
                        </span>
                      </span>
                      <form action={applyFirmDefaultToClientAction}>
                        <input type="hidden" name="orgId" value={c.orgId} />
                        <input type="hidden" name="taskKey" value={d.key} />
                        <button
                          type="submit"
                          className="shrink-0 rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                        >
                          Use firm default
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Branding">
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">Logo</div>
          <div className="text-xs text-zinc-500">
            Shown in the sidebar in place of &ldquo;RocketSuite&rdquo; for your staff and clients.
            The light logo is the default; dark variants and icons are used in dark mode and when
            the sidebar is collapsed. Only the light logo is required.
          </div>
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Logo · light</span>
              <LogoSlot logoUrl={org?.logoUrl ?? null} size="lg" slot="light" uploadUrl={`/api/enterprise/logo?enterpriseId=${current.id}`} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Logo · dark</span>
              <LogoSlot logoUrl={org?.logoUrlDark ?? null} size="lg" slot="dark" dark uploadUrl={`/api/enterprise/logo?enterpriseId=${current.id}`} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Icon · light</span>
              <LogoSlot logoUrl={org?.logoIconUrl ?? null} size="md" slot="icon" uploadUrl={`/api/enterprise/logo?enterpriseId=${current.id}`} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Icon · dark</span>
              <LogoSlot logoUrl={org?.logoIconDarkUrl ?? null} size="md" slot="iconDark" dark uploadUrl={`/api/enterprise/logo?enterpriseId=${current.id}`} />
            </div>
          </div>
        </div>
      </Panel>

      {org?.privateLabelEnabled && (
        <Panel title="Sign-in address">
          <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
            Give your clients a branded sign-in URL — they log in at your own subdomain with no
            RocketBooks branding. Works instantly once saved (no DNS setup on your end).
          </p>
          <SubdomainCard current={org?.subdomain ?? null} root={PRIVATE_LABEL_ROOT} />
        </Panel>
      )}

      <Panel title="Theme">
        <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
          Customize your colors across the app — accents, sidebar, topbar, and chat. Anything left as
          &ldquo;default&rdquo; uses the RocketBooks look.
        </p>
        <ThemeStudio
          initial={(org?.themeConfig as Record<string, string> | null) ?? null}
          brandColorHex={org?.brandColorHex ?? null}
          privateLabel={org?.privateLabelEnabled ?? false}
          logoUrl={org?.logoUrl ?? null}
        />
      </Panel>

      {isFirmPays && (
        <Panel title="Firm billing">
          <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
            You cover your clients&rsquo; subscriptions ($69/mo each). Add a card and we&rsquo;ll bill it as you add or
            import clients. Your card is stored securely by Stripe — never on our servers.
          </p>
          <div className="flex items-center gap-3">
            <span className={`text-sm font-medium ${firmCardOnFile ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>
              {firmCardOnFile ? 'Card on file ✓' : 'No card on file yet'}
            </span>
            <form action={startFirmBillingSetupAction}>
              <input type="hidden" name="returnPath" value="/enterprise/settings" />
              <button
                type="submit"
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
              >
                {firmCardOnFile ? 'Update card' : 'Add a card'}
              </button>
            </form>
          </div>
        </Panel>
      )}

      <Panel title="Features">
        <div className="flex flex-col gap-2">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <div className="text-sm font-medium">Entity Type Onboarding</div>
              <div className="text-xs text-zinc-500">
                When enabled, your clients are asked to identify their entity type
                (LLC, Corp, beneficial trust, etc.) during onboarding. Selecting a
                trust entity activates trust-specific chart of accounts and posting
                rules for that client&rsquo;s organization. When disabled, your
                clients see the standard onboarding flow with no entity-type step.
              </div>
            </div>
            <EntityTypeOnboardingToggle
              enabled={org?.entityTypeOnboardingEnabled ?? false}
              endpoint={`/api/enterprise/entity-type-onboarding?enterpriseId=${current.id}`}
            />
          </div>
        </div>
      </Panel>

      <Panel title="Billing plans for clients">
        <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
          Choose which custom plans your clients can see and purchase on their billing page. Built-in
          plans (base subscription, year unlocks) are always available. If nothing is listed, no custom
          plans have been set up for you yet.
        </p>
        <ClientPlanVisibility
          enterpriseId={current.id}
          products={gatedProducts}
          initialSelected={[...allowedIds]}
        />
      </Panel>

      <Panel title="Password">
        <UpdatePasswordForm />
      </Panel>
    </AdminPage>
  );
}
