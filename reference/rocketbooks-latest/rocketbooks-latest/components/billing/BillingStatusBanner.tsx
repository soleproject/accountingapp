import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizationBilling } from '@/db/schema/schema';

/**
 * Renders a top-of-app banner when the org's billing status is past_due
 * (amber warning) or locked (red, writes are blocked). Mounted in the
 * (app) layout so it shows on every authenticated page.
 *
 * Returns null for active / inactive / canceled — those don't need a
 * banner. canceled orgs that want to resubscribe land at /billing via
 * the sidebar.
 */
export async function BillingStatusBanner({ orgId }: { orgId: string }) {
  const [row] = await db
    .select({ status: organizationBilling.status })
    .from(organizationBilling)
    .where(eq(organizationBilling.organizationId, orgId))
    .limit(1);

  const status = row?.status ?? 'inactive';

  if (status === 'past_due') {
    return (
      <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
        <strong className="font-medium">Payment past due.</strong>{' '}
        Stripe is retrying — update your card to avoid losing access.{' '}
        <Link href="/billing" className="font-medium underline underline-offset-2">
          Update payment
        </Link>
      </div>
    );
  }

  if (status === 'locked') {
    return (
      <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
        <strong className="font-medium">Subscription paused.</strong>{' '}
        Writes are temporarily blocked. Update payment to restore access.{' '}
        <Link href="/billing" className="font-medium underline underline-offset-2">
          Manage billing
        </Link>
      </div>
    );
  }

  return null;
}
