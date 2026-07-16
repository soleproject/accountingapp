import 'server-only';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';

export interface ResolvedVeryfiCategory {
  /** chart_of_accounts.id, or null when category was a sentinel or unknown. */
  categoryAccountId: string | null;
  /** Maps to transactions.reviewed at promote time. */
  reviewedByDefault: boolean;
  /** Tracks how the lookup landed — useful for logs and downstream classification. */
  source: 'primary' | 'fallback_uncategorized' | 'sentinel_transfer' | 'unknown';
  /** Echo of what Veryfi returned, post-trim. */
  category: string | null;
}

/**
 * Step 2.b for the Veryfi import pipeline.
 *
 * Veryfi's bank-statement endpoint accepts a `categories` array on the
 * request and returns one of those category names per transaction. Because
 * we passed our chart-of-accounts names directly, the response is already
 * mapped — this resolver just looks the COA row up by name.
 *
 * Sentinels:
 *   - "Internal Transfer" (sent in the request) → no category, reviewed=false.
 *
 * Fallbacks:
 *   - Empty/null category from Veryfi → uncategorized_expense or
 *     uncategorized_income depending on transaction direction (deposit vs
 *     withdrawal). Forces reviewed=false.
 *   - A category Veryfi returned that doesn't match any active CoA name in
 *     the org (rare; would only happen if Veryfi hallucinated a label) →
 *     same uncategorized fallback.
 */
export async function resolveVeryfiCategory(args: {
  organizationId: string;
  category: string | null;
  type: 'deposit' | 'withdrawal';
}): Promise<ResolvedVeryfiCategory> {
  const cat = args.category?.trim() ?? null;
  const cleanCat = cat && cat.length > 0 ? cat : null;

  // Sentinel — explicit transfer label sent in the request.
  if (cleanCat?.toLowerCase() === 'internal transfer') {
    return {
      categoryAccountId: null,
      reviewedByDefault: false,
      source: 'sentinel_transfer',
      category: cleanCat,
    };
  }

  // Pull all active CoA rows for this org once. Small list (~50 for a fresh
  // canonical seed), worth a single round-trip rather than two queries.
  const coa = await db
    .select({
      id: chartOfAccounts.id,
      accountName: chartOfAccounts.accountName,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, args.organizationId), eq(chartOfAccounts.isActive, true)));

  const findByName = (name: string) =>
    coa.find((c) => c.accountName.trim().toLowerCase() === name.trim().toLowerCase()) ?? null;

  // 1. Primary mapping: Veryfi returned one of our CoA names verbatim.
  if (cleanCat) {
    const match = findByName(cleanCat);
    if (match) {
      return {
        categoryAccountId: match.id,
        reviewedByDefault: true,
        source: 'primary',
        category: cleanCat,
      };
    }
  }

  // 2. Fallback to uncategorized. Direction-aware so deposits go to
  //    Uncategorized Income and withdrawals to Uncategorized Expense.
  const fallbackName = args.type === 'deposit' ? 'Uncategorized Income' : 'Uncategorized Expense';
  const fallback = findByName(fallbackName);
  if (fallback) {
    return {
      categoryAccountId: fallback.id,
      reviewedByDefault: false,
      source: 'fallback_uncategorized',
      category: cleanCat,
    };
  }

  // 3. Org doesn't even have the uncategorized slots — leave unset, force review.
  return {
    categoryAccountId: null,
    reviewedByDefault: false,
    source: 'unknown',
    category: cleanCat,
  };
}
