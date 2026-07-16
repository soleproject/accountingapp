import 'server-only';
import { randomUUID } from 'crypto';
import { and, count, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  chartOfAccounts,
  trustBeneficiaries,
  journalEntries,
  plaidAccounts,
} from '@/db/schema/schema';
import { seedStaticCoa, type SeedCoaResult } from './seed-default-coa';
import { DEFAULT_COA } from './default-coa-data';
import { BENEFICIAL_TRUST_COA } from './beneficial-trust-coa-data';
import { logger } from '@/lib/logger';

export interface SeedBeneficialTrustCoaResult extends SeedCoaResult {
  beneficiarySubAccountsInserted: number;
  defaultCoaWiped: number;
  defaultCoaWipeSkippedReason: string | null;
}

const BENEFICIARY_PARENT_ACCOUNT_NUMBER = '265';
// First numeric account number used for per-beneficiary children of 265.
// 266 matches the source spec ("Subaccounts e.g. 266, 267 per individual").
const BENEFICIARY_FIRST_CHILD_NUMBER = 266;

/**
 * Seed the beneficial-trust chart of accounts, then materialize a 26x
 * sub-account under "Beneficiaries' Demand Notes" (265) for every row in
 * trust_beneficiaries that doesn't yet have one. Each child uses a dynamic
 * detail_type slug (`trust_beneficiary_demand_note__<short-uuid>`) so the
 * UNIQUE(org, gaap_type, detail_type) constraint stays satisfied; that slug
 * intentionally bypasses the canonical taxonomy check.
 *
 * Before seeding, defensively wipes any existing DEFAULT_COA rows that
 * were seeded at org-creation time (lib/accounting/create-organization.ts
 * and the createUser flows all pre-seed the standard COA). Without this,
 * the trust org ends up with a messy mix of default + trust accounts. The
 * wipe only runs when the org is genuinely fresh (no journal entries
 * posted, no Plaid accounts linked) — otherwise it logs a warning and
 * leaves the existing state alone, since deleting in-use accounts would
 * either violate FKs or destroy data.
 *
 * Idempotent — safe to run before or after beneficiaries are saved, and
 * safe to re-run after additional beneficiaries are added.
 */
export async function seedBeneficialTrustCoa(args: {
  organizationId: string;
}): Promise<SeedBeneficialTrustCoaResult> {
  const wipeResult = await wipeDefaultCoaIfSafe(args.organizationId);
  if (wipeResult.skippedReason) {
    logger.warn(
      { orgId: args.organizationId, reason: wipeResult.skippedReason },
      'beneficial-trust seed: skipped default-COA cleanup',
    );
  }

  const { result, idByNumber } = await seedStaticCoa({
    organizationId: args.organizationId,
    template: BENEFICIAL_TRUST_COA,
  });

  const parentAccountId = idByNumber.get(BENEFICIARY_PARENT_ACCOUNT_NUMBER);
  let beneficiarySubAccountsInserted = 0;
  if (parentAccountId) {
    beneficiarySubAccountsInserted = await seedBeneficiaryDemandNotes(
      args.organizationId,
      parentAccountId,
    );
  }

  return {
    ...result,
    beneficiarySubAccountsInserted,
    defaultCoaWiped: wipeResult.wiped,
    defaultCoaWipeSkippedReason: wipeResult.skippedReason,
  };
}

/**
 * If the org still has the standard DEFAULT_COA rows from create-org time
 * AND no real data has been posted yet, wipe all system-generated COA rows
 * so the trust seeder gets a clean slate. Otherwise return a skip reason
 * the caller can log.
 */
async function wipeDefaultCoaIfSafe(
  organizationId: string,
): Promise<{ wiped: number; skippedReason: string | null }> {
  return await db.transaction(async (tx) => {
    // Safety check 1: no posted journal entries (those FK-reference COA rows).
    const [je] = await tx
      .select({ n: count() })
      .from(journalEntries)
      .where(eq(journalEntries.organizationId, organizationId));
    const jeCount = je?.n ?? 0;
    if (jeCount > 0) {
      return { wiped: 0, skippedReason: `${jeCount} journal entries posted` };
    }

    // Safety check 2: no Plaid accounts linked (autoCreateBankCoa creates
    // bank sub-accounts that we shouldn't wipe).
    const [pa] = await tx
      .select({ n: count() })
      .from(plaidAccounts)
      .where(eq(plaidAccounts.linkedOrganizationId, organizationId));
    const paCount = pa?.n ?? 0;
    if (paCount > 0) {
      return { wiped: 0, skippedReason: `${paCount} plaid accounts linked` };
    }

    // Check 3: only wipe if DEFAULT_COA-numbered rows actually exist (i.e.,
    // the conflict we're trying to clean up). If the org only has trust
    // accounts already (re-call case), skip.
    const defaultNumbers = new Set(DEFAULT_COA.map((a) => a.accountNumber));
    const existing = await tx
      .select({
        id: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
      })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.organizationId, organizationId),
          eq(chartOfAccounts.systemGenerated, true),
        ),
      );
    const hasDefaultRows = existing.some((r) => defaultNumbers.has(r.accountNumber));
    if (!hasDefaultRows) {
      return { wiped: 0, skippedReason: null };
    }

    // Null trust_beneficiaries.demand_note_account_id (FK → chart_of_accounts).
    await tx
      .update(trustBeneficiaries)
      .set({ demandNoteAccountId: null })
      .where(eq(trustBeneficiaries.organizationId, organizationId));

    // Orphan parent links so the delete doesn't trip the self-referential FK.
    await tx
      .update(chartOfAccounts)
      .set({ parentAccountId: null })
      .where(
        and(
          eq(chartOfAccounts.organizationId, organizationId),
          eq(chartOfAccounts.systemGenerated, true),
        ),
      );

    // Wipe.
    await tx
      .delete(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.organizationId, organizationId),
          eq(chartOfAccounts.systemGenerated, true),
        ),
      );

    return { wiped: existing.length, skippedReason: null };
  });
}

async function seedBeneficiaryDemandNotes(
  organizationId: string,
  parentAccountId: string,
): Promise<number> {
  const [beneficiaries, existingChildren] = await Promise.all([
    db
      .select({
        id: trustBeneficiaries.id,
        fullName: trustBeneficiaries.fullName,
        demandNoteAccountId: trustBeneficiaries.demandNoteAccountId,
      })
      .from(trustBeneficiaries)
      .where(eq(trustBeneficiaries.organizationId, organizationId)),
    db
      .select({
        id: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
      })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.organizationId, organizationId),
          eq(chartOfAccounts.parentAccountId, parentAccountId),
        ),
      ),
  ]);

  let nextNumber = BENEFICIARY_FIRST_CHILD_NUMBER;
  for (const child of existingChildren) {
    const num = Number.parseInt(child.accountNumber, 10);
    if (Number.isFinite(num) && num >= nextNumber) nextNumber = num + 1;
  }

  let inserted = 0;
  for (const b of beneficiaries) {
    if (b.demandNoteAccountId) continue; // already has a sub-account
    if (!b.fullName.trim()) continue;

    const id = randomUUID();
    const detailType = `trust_beneficiary_demand_note__${id.slice(0, 8)}`;
    const accountNumber = String(nextNumber++);
    try {
      await db.insert(chartOfAccounts).values({
        id,
        organizationId,
        accountNumber,
        accountName: `${b.fullName} - Demand Note`,
        gaapType: 'liability',
        accountType: 'long_term_liabilities',
        detailType,
        parentAccountId,
        normalBalance: 'credit',
        isActive: true,
        systemGenerated: true,
        passedNameContactCheck: true,
      });
      await db
        .update(trustBeneficiaries)
        .set({ demandNoteAccountId: id })
        .where(eq(trustBeneficiaries.id, b.id));
      inserted++;
    } catch {
      // Defensive — race with another seed call. Leave the beneficiary
      // unlinked; the next seed pass will retry with a fresh number.
    }
  }

  return inserted;
}
