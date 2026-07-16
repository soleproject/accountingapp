import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { overdueInvoicesByCustomer, overdueInvoicesMissingEmail } from '@/lib/enterprise/ar-collections';
import { FollowUpClient } from './_components/FollowUpClient';
import { MissingEmailList } from './_components/MissingEmailList';

export const dynamic = 'force-dynamic';

export default async function InvoiceFollowUpPage() {
  const orgId = await getCurrentOrgId();
  if (!orgId) notFound();

  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const [customers, missingEmail] = await Promise.all([
    overdueInvoicesByCustomer(orgId),
    overdueInvoicesMissingEmail(orgId),
  ]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 p-6">
      <div>
        <Link href="/invoices" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
          ← Invoices
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Follow up on overdue invoices</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Pick which invoices to chase, review the AI-drafted reminder for each customer, then send — they go out from {org?.name?.trim() || 'your business'} with replies coming back to you.
        </p>
      </div>
      <FollowUpClient customers={customers} businessName={org?.name?.trim() || 'your business'} />
      <MissingEmailList customers={missingEmail} />
    </div>
  );
}
