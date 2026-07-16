import { redirect, notFound } from 'next/navigation';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  organizations,
  organizationSubscriptions,
  transactions,
} from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ org?: string }>;
}

/**
 * Stripe cancel_url lands here when the user bails out of the
 * pay-first new-business checkout. Clean up the placeholder org row
 * created right before checkout so we don't leak empty workspaces.
 * Only delete when the org is genuinely empty (no subscription, no
 * transactions) so this can't take out a real workspace if someone
 * crafts the URL by hand.
 */
export default async function CanceledNewBusinessPage({ searchParams }: PageProps) {
  await requireSession();
  const userId = await getEffectiveUserId();
  const { org } = await searchParams;
  if (!org) redirect('/dashboard?new_business=canceled');

  const [row] = await db
    .select({ id: organizations.id, ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1);
  if (!row || row.ownerUserId !== userId) notFound();

  const [{ n: subCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(organizationSubscriptions)
    .where(eq(organizationSubscriptions.organizationId, row.id));
  const [{ n: txnCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(eq(transactions.organizationId, row.id));

  if (subCount === 0 && txnCount === 0) {
    await db.delete(organizations).where(and(eq(organizations.id, row.id), eq(organizations.ownerUserId, userId)));
    logger.info({ orgId: row.id, userId }, 'cleaned up placeholder org after canceled checkout');
  } else {
    logger.warn(
      { orgId: row.id, userId, subCount, txnCount },
      'skipped cleanup — org has subs/transactions',
    );
  }

  redirect('/dashboard?new_business=canceled');
}
