import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';

export interface ResolvedAccount {
  id: string;
  accountName: string;
  resolvedVia: 'id' | 'accountNumber' | 'accountName';
}

/**
 * Resolve an account "candidate" string against an org's chart of accounts.
 *
 * Three rounds of prompt tightening haven't made gpt-4o-mini reliably pass
 * the UUID id; logs show it sometimes sends the accountNumber ("6040") or
 * the literal accountName. Rather than fight the model, the dispatcher and
 * helpers tolerate either form.
 *
 * Lookup order — first hit wins, all org-scoped:
 *   1. UUID id match (the contract; fast path).
 *   2. accountNumber exact match.
 *   3. accountName case-insensitive exact match.
 *
 * Returns null if none match. Callers log via `logger.info` when a fallback
 * resolves so we can monitor compliance over time — if most resolutions go
 * through the id path, the contract is holding; if most go through the
 * fallback paths, the strict contract is fiction and we plan accordingly.
 */
export async function resolveAccount(
  orgId: string,
  candidate: string,
): Promise<ResolvedAccount | null> {
  if (!candidate) return null;

  // All three lookups require isActive=true so CoA draft rows
  // (is_active=false, is_temporary=true) can never resolve before commit.
  const [byId] = await db
    .select({ id: chartOfAccounts.id, accountName: chartOfAccounts.accountName })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.id, candidate),
        eq(chartOfAccounts.organizationId, orgId),
        eq(chartOfAccounts.isActive, true),
      ),
    )
    .limit(1);
  if (byId) return { id: byId.id, accountName: byId.accountName, resolvedVia: 'id' };

  const [byNumber] = await db
    .select({ id: chartOfAccounts.id, accountName: chartOfAccounts.accountName })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.accountNumber, candidate),
        eq(chartOfAccounts.organizationId, orgId),
        eq(chartOfAccounts.isActive, true),
      ),
    )
    .limit(1);
  if (byNumber) {
    return { id: byNumber.id, accountName: byNumber.accountName, resolvedVia: 'accountNumber' };
  }

  const [byName] = await db
    .select({ id: chartOfAccounts.id, accountName: chartOfAccounts.accountName })
    .from(chartOfAccounts)
    .where(
      and(
        sql`LOWER(${chartOfAccounts.accountName}) = ${candidate.toLowerCase()}`,
        eq(chartOfAccounts.organizationId, orgId),
        eq(chartOfAccounts.isActive, true),
      ),
    )
    .limit(1);
  if (byName) {
    return { id: byName.id, accountName: byName.accountName, resolvedVia: 'accountName' };
  }

  return null;
}
