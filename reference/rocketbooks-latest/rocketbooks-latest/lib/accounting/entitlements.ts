import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, plaidAccounts } from '@/db/schema/schema';
import {
  type AccountingTierKey,
  type AccountingTierCapabilities,
  maybeGetAccountingTier,
} from './tiers';

/**
 * Per-org accounting-tier ENTITLEMENTS — the runtime counterpart to the
 * permission sets. Permission sets gate page *visibility* (sidebar + per-page
 * guards via hasPermission); this module gates the things permissions can't:
 * numeric caps (bank connections, seats) and non-page behaviours (QBO
 * migration, entity packs, AI collections, …).
 *
 * Source of truth = the capability/limit maps in lib/accounting/tiers.ts.
 *
 * GRANDFATHERING: an org whose accounting_tier is NULL is a legacy flat-$89
 * client. Legacy = the old all-you-can-eat plan, so it resolves to ALL
 * capabilities true and UNLIMITED caps. Never treat NULL as "no plan / nothing
 * allowed" — that would silently downgrade every existing customer.
 */

export type AccountingCapability = keyof AccountingTierCapabilities;

const LEGACY_FULL_CAPABILITIES: AccountingTierCapabilities = {
  reconciliation: true,
  apBills: true,
  aiCollections: true,
  fullAiAssistant: true,
  tagsDimensions: true,
  recurring: true,
  inventory: true,
  entityPacks: true,
  advancedReporting: true,
  multiEntity: true,
};

export interface OrgEntitlements {
  /** Resolved tier key, or null for a grandfathered flat-$89 client. */
  tier: AccountingTierKey | null;
  isLegacy: boolean;
  capabilities: AccountingTierCapabilities;
  /** `null` = unlimited. */
  limits: { bankConnections: number | null; seats: number | null };
}

/** Resolve an org's effective entitlements. NULL tier → legacy full access. */
export async function getOrgEntitlements(orgId: string): Promise<OrgEntitlements> {
  const [org] = await db
    .select({ tier: organizations.accountingTier })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const tier = maybeGetAccountingTier(org?.tier);
  if (!tier) {
    return {
      tier: null,
      isLegacy: true,
      capabilities: { ...LEGACY_FULL_CAPABILITIES },
      limits: { bankConnections: null, seats: null },
    };
  }
  return {
    tier: tier.key,
    isLegacy: false,
    capabilities: tier.capabilities,
    limits: tier.limits,
  };
}

export async function orgHasCapability(
  orgId: string,
  cap: AccountingCapability,
): Promise<boolean> {
  const e = await getOrgEntitlements(orgId);
  return e.capabilities[cap];
}

/** Thrown by requireOrgCapability. `code` lets API routes map it to a 403. */
export class AccountingTierError extends Error {
  readonly code = 'accounting_tier_required';
  readonly capability: AccountingCapability;
  constructor(capability: AccountingCapability, message: string) {
    super(message);
    this.name = 'AccountingTierError';
    this.capability = capability;
  }
}

export async function requireOrgCapability(
  orgId: string,
  cap: AccountingCapability,
  message = "This feature isn't included in your current plan. Upgrade to unlock it.",
): Promise<void> {
  if (!(await orgHasCapability(orgId, cap))) {
    throw new AccountingTierError(cap, message);
  }
}

// ── Numeric caps ───────────────────────────────────────────────────────────

/** Distinct bank/credit-card connections (Plaid *items*) linked to an org.
 *  Counted by distinct plaid_item_id so a multi-account institution = 1. */
export async function countOrgBankConnections(orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${plaidAccounts.plaidItemId})` })
    .from(plaidAccounts)
    .where(eq(plaidAccounts.linkedOrganizationId, orgId));
  return Number(row?.n ?? 0);
}

export interface CapCheck {
  allowed: boolean;
  /** `null` = unlimited. */
  limit: number | null;
  current: number;
}

/** Whether the org may add ONE more bank connection under its tier cap.
 *  Pre-exchange-safe: counts existing connections only. */
export async function canAddBankConnection(orgId: string): Promise<CapCheck> {
  const { limits } = await getOrgEntitlements(orgId);
  const limit = limits.bankConnections;
  if (limit === null) return { allowed: true, limit: null, current: 0 };
  const current = await countOrgBankConnections(orgId);
  return { allowed: current < limit, limit, current };
}

/**
 * Seat cap for an org. There is no in-app teammate-invite flow for client orgs
 * yet, so there's nothing to enforce against today — this exposes the limit so
 * the future invite flow can call canAddSeat(orgId, currentSeatCount). Once a
 * seat/membership source exists, add a counter here mirroring bank connections.
 */
export async function orgSeatLimit(orgId: string): Promise<number | null> {
  const { limits } = await getOrgEntitlements(orgId);
  return limits.seats;
}

export async function canAddSeat(orgId: string, currentSeatCount: number): Promise<CapCheck> {
  const limit = await orgSeatLimit(orgId);
  if (limit === null) return { allowed: true, limit: null, current: currentSeatCount };
  return { allowed: currentSeatCount < limit, limit, current: currentSeatCount };
}
