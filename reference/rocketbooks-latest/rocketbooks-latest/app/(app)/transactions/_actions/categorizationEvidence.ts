'use server';

import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, chartOfAccounts, categorizationRules } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';

/**
 * Provenance for the accountant review queue's "Why?" drawer. Answers
 * "why did the AI put this transaction here, and on what evidence?" by
 * returning, for one transaction:
 *   - the persisted AI reason / source / confidence (from auto-categorize),
 *   - how this same merchant has been categorized before (vendor memory),
 *   - any deterministic categorization rules whose pattern matches it.
 *
 * Read-only. Mirrors the merchant-match logic in lib/ai/categorization.ts's
 * lookupVendorMemory so the drawer shows the same evidence the categorizer
 * itself would weigh.
 */

export interface SimilarCategorization {
  categoryName: string;
  count: number;
  mostRecent: string | null;
}

export interface MatchedRule {
  pattern: string;
  categoryName: string | null;
  confidence: number;
}

export interface CategorizationEvidence {
  reason: string | null;
  source: string | null;
  confidence: number | null;
  similar: SimilarCategorization[];
  rules: MatchedRule[];
  error?: string;
}

export async function getCategorizationEvidence(
  transactionId: string,
): Promise<CategorizationEvidence> {
  const empty: CategorizationEvidence = { reason: null, source: null, confidence: null, similar: [], rules: [] };
  if (!transactionId) return { ...empty, error: 'Missing transaction' };

  const orgId = await getCurrentOrgId();

  const [txn] = await db
    .select({
      id: transactions.id,
      type: transactions.type,
      contactId: transactions.contactId,
      bankDescription: transactions.bankDescription,
      description: transactions.description,
      aiReason: transactions.aiReason,
      aiSource: transactions.aiSource,
      aiConfidence: transactions.aiConfidence,
    })
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.organizationId, orgId)))
    .limit(1);
  if (!txn) return { ...empty, error: 'Transaction not found' };

  const description = (txn.bankDescription ?? txn.description ?? '').trim();

  // Similar past categorizations of the same merchant — only confirmed,
  // posted rows count (same predicate the categorizer's vendor memory uses).
  const matchByContact = txn.contactId ? eq(transactions.contactId, txn.contactId) : null;
  const matchByDesc = description
    ? sql`(${transactions.bankDescription} = ${description} OR ${transactions.description} = ${description})`
    : null;
  const merchantMatch =
    matchByContact && matchByDesc
      ? sql`(${matchByContact} OR ${matchByDesc})`
      : matchByContact ?? matchByDesc;

  let similar: SimilarCategorization[] = [];
  if (merchantMatch) {
    const conditions = [
      eq(transactions.organizationId, orgId),
      isNotNull(transactions.categoryAccountId),
      isNotNull(transactions.journalEntryId),
      eq(transactions.reviewed, true),
      merchantMatch,
    ];
    if (txn.type) conditions.push(eq(transactions.type, txn.type));

    const rows = await db
      .select({
        categoryName: chartOfAccounts.accountName,
        n: sql<number>`COUNT(*)::int`.as('n'),
        mostRecent: sql<string>`MAX(${transactions.date})`.as('most_recent'),
      })
      .from(transactions)
      .innerJoin(chartOfAccounts, eq(transactions.categoryAccountId, chartOfAccounts.id))
      .where(and(...conditions))
      .groupBy(chartOfAccounts.accountName)
      .orderBy(desc(sql`COUNT(*)`))
      .limit(5);
    similar = rows.map((r) => ({ categoryName: r.categoryName, count: r.n, mostRecent: r.mostRecent }));
  }

  // Deterministic rules whose pattern matches this merchant. Org rule sets are
  // small; filter substring matches in JS rather than push pattern logic into
  // SQL (rule_type semantics live in the categorizer, not the DB).
  let rules: MatchedRule[] = [];
  if (description) {
    const allRules = await db
      .select({
        pattern: categorizationRules.pattern,
        confidence: categorizationRules.confidence,
        categoryName: chartOfAccounts.accountName,
      })
      .from(categorizationRules)
      .leftJoin(chartOfAccounts, eq(categorizationRules.categoryAccountId, chartOfAccounts.id))
      .where(eq(categorizationRules.organizationId, orgId));
    const haystack = description.toLowerCase();
    rules = allRules
      .filter((r) => r.pattern && haystack.includes(r.pattern.toLowerCase()))
      .slice(0, 5)
      .map((r) => ({ pattern: r.pattern, categoryName: r.categoryName, confidence: r.confidence }));
  }

  return {
    reason: txn.aiReason,
    source: txn.aiSource,
    confidence: txn.aiConfidence,
    similar,
    rules,
  };
}
