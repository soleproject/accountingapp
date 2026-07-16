import 'server-only';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';
import { DEFAULT_COA } from './default-coa-data';
import type { SeedAccount } from './default-coa-data';

export interface SeedCoaResult {
  organizationId: string;
  inserted: number;
  skipped: number;
  totalAccounts: number;
}

// Back-compat alias for callers that imported the old name.
export type SeedDefaultCoaResult = SeedCoaResult;

/**
 * Idempotently seed a chart-of-accounts template on an org.
 *
 * Skips any account whose accountNumber OR (gaapType, detailType) already
 * exists — both because of unique-by-account-number convention and because
 * the table has UNIQUE (organization_id, gaap_type, detail_type). Resolves
 * sub-account `parent` references against accounts already in the org or
 * inserted earlier in this same seed pass.
 *
 * Returns the result counts plus an `idByNumber` map (existing + newly
 * inserted) so callers that need to add follow-on dynamic sub-accounts
 * (e.g. the beneficial-trust seeder seeding per-beneficiary 26x children)
 * can look up parent ids without re-querying.
 */
export async function seedStaticCoa(args: {
  organizationId: string;
  template: readonly SeedAccount[];
}): Promise<{ result: SeedCoaResult; idByNumber: Map<string, string> }> {
  const existing = await db
    .select({
      id: chartOfAccounts.id,
      accountNumber: chartOfAccounts.accountNumber,
      gaapType: chartOfAccounts.gaapType,
      detailType: chartOfAccounts.detailType,
    })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.organizationId, args.organizationId));

  const usedNumbers = new Set(existing.map((e) => e.accountNumber));
  const usedGaapDetail = new Set(
    existing
      .filter((e) => e.detailType)
      .map((e) => `${e.gaapType}::${e.detailType}`),
  );
  const idByNumber = new Map<string, string>(existing.map((e) => [e.accountNumber, e.id]));

  let inserted = 0;
  let skipped = 0;
  for (const a of args.template) {
    if (usedNumbers.has(a.accountNumber)) {
      skipped++;
      continue;
    }
    const key = `${a.gaapType}::${a.detailType}`;
    if (usedGaapDetail.has(key)) {
      skipped++;
      continue;
    }
    const parentAccountId = a.parent ? idByNumber.get(a.parent) ?? null : null;
    const id = randomUUID();
    try {
      await db.insert(chartOfAccounts).values({
        id,
        organizationId: args.organizationId,
        accountNumber: a.accountNumber,
        accountName: a.accountName,
        gaapType: a.gaapType,
        accountType: a.accountType,
        detailType: a.detailType,
        parentAccountId,
        normalBalance: a.normalBalance,
        isActive: true,
        systemGenerated: true,
        passedNameContactCheck: true,
      });
      usedNumbers.add(a.accountNumber);
      usedGaapDetail.add(key);
      idByNumber.set(a.accountNumber, id);
      inserted++;
    } catch {
      // Defensive — race with another seed call. Treat as skip.
      skipped++;
    }
  }

  return {
    result: {
      organizationId: args.organizationId,
      inserted,
      skipped,
      totalAccounts: existing.length + inserted,
    },
    idByNumber,
  };
}

/**
 * Idempotently seed the standard chart of accounts on an org. Thin wrapper
 * around seedStaticCoa with the DEFAULT_COA template.
 */
export async function seedDefaultCoa(args: { organizationId: string }): Promise<SeedCoaResult> {
  const { result } = await seedStaticCoa({ organizationId: args.organizationId, template: DEFAULT_COA });
  return result;
}
