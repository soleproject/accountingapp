import 'server-only';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts, pfcOrgOverrides } from '@/db/schema/schema';
import { getPfcMapping, reviewedByDefault, type PfcClassification, type PfcMapping } from './pfc-coa-mapping';

export interface ResolvedPfc {
  /** chart_of_accounts.id to write into transactions.categoryAccountId, or null if no slot exists. */
  categoryAccountId: string | null;
  classification: PfcClassification;
  /** Maps to transactions.reviewed at promote time. */
  reviewedByDefault: boolean;
  mapping: PfcMapping;
  /** Tracks whether we landed via per-org override, the canonical slot, the uncategorized fallback, or had no path. */
  source: 'override' | 'primary' | 'fallback_uncategorized' | 'unmapped';
}

interface OrgCoaSlot {
  id: string;
  account_name: string | null;
  account_type: string | null;
  detail_type: string | null;
}

/**
 * True when the resolved CoA row is one of the "Uncategorized" buckets —
 * QB Uncategorized Expense/Income/Asset, the seed's uncategorized rows,
 * or any other account whose name or detail_type signals it. Landing here
 * means the categorization is provisional and the row should always go
 * to the review queue (reviewed=false), no matter what confidence the
 * PFC mapping carries.
 */
function isUncategorizedAccount(accountName: string | null, detailType: string | null): boolean {
  if (accountName && /uncategori[sz]ed/i.test(accountName)) return true;
  if (detailType && /^uncategori[sz]ed/i.test(detailType)) return true;
  return false;
}

/**
 * For a Plaid PFCv2 detailed code, return the org's CoA id to assign and
 * whether the row should be auto-marked reviewed.
 *
 * Lookup order:
 *   0. pfc_org_overrides — per-org pin from the AI mapper (or a user
 *      override). When present, short-circuits the rest. This is the path
 *      taken by orgs that have connected QuickBooks and let the post-sync
 *      AI mapper assign each PFC to a specific QB account; without it the
 *      slot lookup would pick the wrong row (e.g. seed instead of the QB
 *      account carrying the historical balance).
 *   1. Slot lookup — org has a CoA row matching the canonical
 *      (account_type, detail_type) pair from pfc-coa-mapping. Covers orgs
 *      without QB. With UNIQUE(org, gaap, detail) dropped (migration
 *      0024) the slot can match multiple rows; we prefer the seed default
 *      (system_generated=true) for determinism, but QB-connected orgs
 *      should already have an override and never reach this branch.
 *   2. Fallback to uncategorized (other_expense/uncategorized_expense or
 *      other_income/uncategorized_income depending on direction). Forces
 *      reviewed=false so the row lands in the review queue.
 *   3. No PFC mapping at all (legacy data missing PFC, or unmapped code) →
 *      categoryAccountId=null, reviewedByDefault=false.
 */
export async function resolvePfcCoa(args: {
  organizationId: string;
  pfcDetailed: string | null | undefined;
  /** The bank account being categorized. Never resolve the category to it —
   *  a self-referential category produces a self-cancelling JE. */
  bankAccountId?: string | null;
}): Promise<ResolvedPfc | null> {
  if (!args.pfcDetailed) return null;
  const mapping = getPfcMapping(args.pfcDetailed);
  if (!mapping) {
    return null;
  }

  const reviewed = reviewedByDefault(mapping.classification);

  // 0. Per-org override — single indexed lookup. Skips the rest when hit.
  const [override] = await db
    .select({
      categoryAccountId: pfcOrgOverrides.categoryAccountId,
      targetAccountName: chartOfAccounts.accountName,
      targetDetailType: chartOfAccounts.detailType,
      targetAccountType: chartOfAccounts.accountType,
    })
    .from(pfcOrgOverrides)
    .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, pfcOrgOverrides.categoryAccountId))
    .where(and(
      eq(pfcOrgOverrides.organizationId, args.organizationId),
      eq(pfcOrgOverrides.pfcDetailed, args.pfcDetailed),
    ))
    .limit(1);
  // Never auto-categorize to a bank account — that's a transfer's contra leg,
  // which can't be auto-determined (the real other account often isn't in the
  // books). Skip such an override and fall through to the uncategorized path so
  // it lands in review instead of dumping into an arbitrary bank account.
  if (override && override.categoryAccountId !== args.bankAccountId && override.targetAccountType !== 'bank') {
    // Even if the PFC's classification would normally auto-clear review
    // (business_expense / business_income / personal / liability_*), force
    // reviewed=false when the resolved account is an "Uncategorized" one.
    // The AI mapper falls back to QB's Uncategorized Expense/Income when
    // it can't find a specific match in the user's CoA — landing there
    // really IS the "user needs to look at this" case, no matter what
    // confidence the PFC carries.
    const uncategorizedTarget = isUncategorizedAccount(override.targetAccountName, override.targetDetailType);
    return {
      categoryAccountId: override.categoryAccountId,
      classification: mapping.classification,
      reviewedByDefault: uncategorizedTarget ? false : reviewed,
      mapping,
      source: 'override',
    };
  }

  // Pull all of the org's COA rows once and resolve in JS — small list (~50
  // rows for a fresh org) and avoids two round-trips when we need to fall back.
  const coa = await db
    .select({
      id: chartOfAccounts.id,
      account_name: chartOfAccounts.accountName,
      account_type: chartOfAccounts.accountType,
      detail_type: chartOfAccounts.detailType,
      system_generated: chartOfAccounts.systemGenerated,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, args.organizationId), eq(chartOfAccounts.isActive, true)));

  const findSlot = (accountType: string, detailType: string): OrgCoaSlot | null => {
    // Exclude the bank account being categorized — resolving the category to it
    // would create a self-cancelling JE.
    // Never resolve a category to a bank account (transfer contra legs — see
    // above). This makes transfer PFC codes (which map to a bank/checking slot)
    // fall through to the uncategorized fallback / review instead of piling into
    // an arbitrary bank account and wrecking Cash on Hand.
    const matches = coa.filter(
      (c) => c.account_type === accountType && c.detail_type === detailType && c.id !== args.bankAccountId && c.account_type !== 'bank',
    );
    if (matches.length === 0) return null;
    return matches.find((c) => c.system_generated === true) ?? matches[0];
  };

  // 1. Primary mapping. Same uncategorized guard as the override path —
  // a primary mapping shouldn't ever resolve to an Uncategorized slot in
  // practice (PFC_COA_MAPPINGS points to specific account types), but
  // defending here keeps the invariant "if categoryAccountId is an
  // Uncategorized row, reviewed=false" universal.
  const primary = findSlot(mapping.accountType, mapping.detailType);
  if (primary) {
    const uncategorizedTarget = isUncategorizedAccount(primary.account_name, primary.detail_type);
    return {
      categoryAccountId: primary.id,
      classification: mapping.classification,
      reviewedByDefault: uncategorizedTarget ? false : reviewed,
      mapping,
      source: 'primary',
    };
  }

  // 2. Fallback to uncategorized based on direction. The PFC told us the
  //    *kind* of thing this is, but the org's CoA doesn't have that slot —
  //    so we land in uncategorized AND force reviewed=false. Anything that
  //    ends up in an uncategorized account belongs in the review queue,
  //    even when the PFC classification would normally be high-confidence.
  const goesToIncomeSide =
    mapping.classification === 'business_income' ||
    mapping.classification === 'liability_increase' ||
    (mapping.classification === 'asset_movement' && mapping.pfcPrimary === 'TRANSFER_IN') ||
    (mapping.classification === 'transfer_review' && mapping.pfcPrimary === 'TRANSFER_IN');

  const fallback = goesToIncomeSide
    ? findSlot('other_income', 'uncategorized_income')
    : findSlot('other_expense', 'uncategorized_expense');

  if (fallback) {
    return {
      categoryAccountId: fallback.id,
      classification: mapping.classification,
      reviewedByDefault: false,
      mapping,
      source: 'fallback_uncategorized',
    };
  }

  // 3. Org doesn't even have the uncategorized slots — leave unset, force review.
  return {
    categoryAccountId: null,
    classification: mapping.classification,
    reviewedByDefault: false,
    mapping,
    source: 'unmapped',
  };
}
