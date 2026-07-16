import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { listAccessibleOrgs } from '@/lib/auth/org';
import { LogoSlot } from '@/components/org/LogoSlot';
import { BusinessEditForm } from './_components/BusinessEditForm';
import { updateBusiness } from '../_actions/updateBusiness';

interface PageProps { params: Promise<{ id: string }>; }

export default async function EditBusinessPage({ params }: PageProps) {
  const { id } = await params;

  const orgs = await listAccessibleOrgs();
  const access = orgs.find((o) => o.id === id);
  if (!access) notFound();

  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      businessDescription: organizations.businessDescription,
      accountingMethod: organizations.accountingMethod,
      logoUrl: organizations.logoUrl,
      logoUrlDark: organizations.logoUrlDark,
      logoIconUrl: organizations.logoIconUrl,
      logoIconDarkUrl: organizations.logoIconDarkUrl,
      address: organizations.address,
      website: organizations.website,
      phone: organizations.phone,
      fax: organizations.fax,
      email: organizations.email,
    })
    .from(organizations)
    .where(eq(organizations.id, id))
    .limit(1);
  if (!org) notFound();

  const addr = (org.address ?? {}) as Record<string, unknown>;

  const boundUpdate = updateBusiness.bind(null, id);

  return (
    <div className="flex flex-col gap-6">
      <Link href="/businesses" className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        ← Back to businesses
      </Link>

      <header>
        <h1 className="text-2xl font-semibold">Edit business</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {org.name}
          {access.role !== 'owner' && (
            <> · <span className="text-amber-700 dark:text-amber-400">read-only (you&apos;re a {access.role})</span></>
          )}
        </p>
      </header>

      <section className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Logo
        </h2>
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
          The light logo is used on printable invoices and on light backgrounds. The dark
          variants and icons are used in the sidebar (dark mode and when collapsed). PNG, JPG,
          WEBP, or SVG up to 1MB each. Only the light logo is required.
        </p>
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Logo · light</span>
            <LogoSlot logoUrl={org.logoUrl} size="lg" slot="light" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Logo · dark</span>
            <LogoSlot logoUrl={org.logoUrlDark} size="lg" slot="dark" dark />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Icon · light</span>
            <LogoSlot logoUrl={org.logoIconUrl} size="md" slot="icon" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Icon · dark</span>
            <LogoSlot logoUrl={org.logoIconDarkUrl} size="md" slot="iconDark" dark />
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Details
        </h2>
        <BusinessEditForm
          action={boundUpdate}
          initial={{
            name: org.name,
            businessDescription: org.businessDescription ?? '',
            accountingMethod: (org.accountingMethod === 'cash' ? 'cash' : 'accrual'),
            email: org.email ?? '',
            phone: org.phone ?? '',
            fax: org.fax ?? '',
            website: org.website ?? '',
            address: {
              line1: typeof addr.line1 === 'string' ? addr.line1 : '',
              line2: typeof addr.line2 === 'string' ? addr.line2 : '',
              city: typeof addr.city === 'string' ? addr.city : '',
              state: typeof addr.state === 'string' ? addr.state : '',
              postal: typeof addr.postal === 'string' ? addr.postal : '',
              country: typeof addr.country === 'string' ? addr.country : '',
            },
          }}
          readOnly={access.role !== 'owner'}
        />
      </section>
    </div>
  );
}
