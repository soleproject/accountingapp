import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { imports, receipts, plaidAccounts } from '@/db/schema/schema';
import { hasActiveDemoTrial } from './demo-trial';

export const DEMO_LIMITS = {
  bankStatementPdfs: 1,
  receipts: 5,
  plaidInstitutions: 1,
} as const;

export type DemoBucket = keyof typeof DEMO_LIMITS;

const BUCKET_LABEL: Record<DemoBucket, string> = {
  bankStatementPdfs: 'bank statements',
  receipts: 'receipts',
  plaidInstitutions: 'linked institutions',
};

export class DemoQuotaExceededError extends Error {
  readonly code = 'DEMO_QUOTA_EXCEEDED';
  readonly bucket: DemoBucket;
  readonly limit: number;
  constructor(bucket: DemoBucket) {
    super(
      `Demo limit reached: ${DEMO_LIMITS[bucket]} ${BUCKET_LABEL[bucket]}. Upgrade to add more.`,
    );
    this.bucket = bucket;
    this.limit = DEMO_LIMITS[bucket];
  }
}

async function countBucket(orgId: string, bucket: DemoBucket): Promise<number> {
  if (bucket === 'bankStatementPdfs') {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(imports)
      .where(and(
        eq(imports.organizationId, orgId),
        eq(imports.method, 'veryfi'),
        eq(imports.importMethod, 'bank_statement'),
      ));
    return r?.n ?? 0;
  }
  if (bucket === 'receipts') {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(receipts)
      .where(eq(receipts.organizationId, orgId));
    return r?.n ?? 0;
  }
  // plaidInstitutions: one Plaid Link session creates one plaid_item, which
  // may carry multiple plaid_accounts rows (checking + savings + …). We cap
  // by item, not account, so the user can connect a full bank in one go.
  const [r] = await db
    .select({ n: sql<number>`count(distinct ${plaidAccounts.plaidItemId})::int` })
    .from(plaidAccounts)
    .where(eq(plaidAccounts.linkedOrganizationId, orgId));
  return r?.n ?? 0;
}

/**
 * Enforces per-org demo trial caps. No-op for orgs that aren't on an
 * active demo_full subscription, so this is safe to call from shared
 * upload paths (production orgs stay uncapped here).
 *
 * `incoming` is for batch writes -- Plaid Link can return N accounts in
 * one POST, and the right behavior is to reject the whole batch when it
 * would push the org past the cap rather than partially link N-k of them.
 */
export async function assertDemoQuota(
  orgId: string,
  bucket: DemoBucket,
  incoming = 1,
): Promise<void> {
  if (!(await hasActiveDemoTrial(orgId))) return;
  const used = await countBucket(orgId, bucket);
  if (used + incoming > DEMO_LIMITS[bucket]) {
    throw new DemoQuotaExceededError(bucket);
  }
}
