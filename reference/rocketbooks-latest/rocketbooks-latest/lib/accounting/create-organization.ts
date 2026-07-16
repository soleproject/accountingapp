import 'server-only';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { seedDefaultCoa } from './seed-default-coa';
import { logger } from '@/lib/logger';

/**
 * Inserts a fresh organization owned by the given user, seeded with the
 * default chart of accounts so AI categorization has expense/revenue
 * accounts to assign to. Used both when the user deletes their last
 * business (auto-creates a replacement) and when they explicitly add
 * a new business from the org switcher.
 */
export async function createFreshOrganization(args: {
  ownerUserId: string;
  name?: string;
}): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  const name = args.name?.trim() || 'My Business';
  await db.insert(organizations).values({
    id,
    name,
    ownerUserId: args.ownerUserId,
    planType: 'pro',
    accountingMethod: 'accrual',
    processingMode: 'batched',
    onboardingMode: 'simple',
    autoApplyRecommendations: false,
    autoApplyTypes: [],
    beneficiaries: [],
    poweredByEnabled: true,
  });
  try {
    await seedDefaultCoa({ organizationId: id });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, orgId: id }, 'seed default COA failed for fresh org');
  }
  return { id, name };
}
