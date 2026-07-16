// Tier → permission-key mapping. Each accounting tier maps to a canonical
// permission set (seeded by scripts/seed-accounting-tier-permission-sets.ts);
// these are the page-visibility keys that set contains. Behaviour gates that
// aren't page keys (numeric caps, feature packs, recurring, AI collections,
// advanced reporting, multi-entity, QBO migration) are enforced in Phase 2
// from the capability flags in tiers.ts — they intentionally do NOT appear
// here.
//
// Keys are validated against lib/permissions/structure.ts. Pure module (no DB)
// so both the seed script (node/tsx) and the assign helper can import it.

import type { AccountingTierKey } from './tiers';
import { ACCOUNTING_TIER_KEYS, ACCOUNTING_TIERS } from './tiers';
import { allPermissionKeys } from '../permissions/structure';

// Baseline every paid tier gets — core double-entry books, basic AR, receipts,
// 1 bank connection (the *cap* is enforced in Phase 2; the page is visible),
// and the AI assistant page (basic categorization; voice is Plus+ below).
const STARTER_KEYS: string[] = [
  'accounting.access',
  'accounting.dashboard.view',
  'accounting.pulse.view',
  'accounting.ai_chat.view',
  'accounting.tasks.view',
  'accounting.transactions.view',
  'accounting.receipts.view',
  'accounting.receipts.ai_button',
  'accounting.invoices.view',
  'accounting.payments.view',
  'accounting.contacts.view',
  'accounting.chart_of_accounts.view',
  'accounting.journal_entries.view',
  'accounting.general_ledger.view',
  'accounting.reports.view',
  'accounting.imports.view',
  'accounting.connect_plaid.view',
  'accounting.plaid_feed.view',
  'accounting.businesses.view',
  'accounting.activity.view',
  'accounting.settings.view',
];

// Plus adds the automation surfaces: reconciliation, AP/bills, and realtime
// voice (the "full AI assistant"). Tags/dimensions, recurring, and AI AR
// collections are behaviours gated in Phase 2, not separate page keys.
const PLUS_ADDED_KEYS: string[] = [
  'accounting.reconciliation.view',
  'accounting.bills.view',
  'ai.realtime_voice',
];

// Pro adds inventory. Entity packs, advanced reporting, and multi-entity are
// feature-pack/behaviour gates (Phase 2), not page keys. (QBO one-time
// migration is available on every tier; QBO Mirror is a separate add-on.)
const PRO_ADDED_KEYS: string[] = [
  'accounting.inventory.view',
];

export const ACCOUNTING_TIER_PERMISSION_KEYS: Record<AccountingTierKey, string[]> = {
  starter: STARTER_KEYS,
  plus: [...STARTER_KEYS, ...PLUS_ADDED_KEYS],
  pro: [...STARTER_KEYS, ...PLUS_ADDED_KEYS, ...PRO_ADDED_KEYS],
};

export function getTierPermissionKeys(tierKey: AccountingTierKey): string[] {
  return ACCOUNTING_TIER_PERMISSION_KEYS[tierKey];
}

/**
 * Dev/seed guard: every key listed above must exist in the permission catalog,
 * otherwise a typo would silently produce a set that grants nothing. Returns
 * the offending keys (empty when all valid).
 */
export function findUnknownTierPermissionKeys(): string[] {
  const known = new Set(allPermissionKeys().map((p) => p.key));
  const all = new Set<string>();
  for (const k of ACCOUNTING_TIER_KEYS) {
    for (const key of ACCOUNTING_TIER_PERMISSION_KEYS[k]) all.add(key);
  }
  return [...all].filter((k) => !known.has(k));
}

/** Convenience: the permission-set name for a tier (mirrors tiers.ts). */
export function tierPermissionSetName(tierKey: AccountingTierKey): string {
  return ACCOUNTING_TIERS[tierKey].permissionSetName;
}
