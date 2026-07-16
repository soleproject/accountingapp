/**
 * Auto-approval guard for "meal-shaped" categories.
 *
 * Meals are the most over-assigned category in the categorization pipeline:
 *   - Plaid mis-tags non-restaurant merchants as FOOD_AND_DRINK (which maps
 *     to entertainment_meals / travel_meals — see pfc-coa-mapping.ts).
 *   - Vendor memory cascades a single Meals categorization across every
 *     future transaction for that merchant.
 *   - The AI categorization prompt is meal-eager (any food-ish token → Meals).
 *
 * A large dollar amount is the single strongest signal that a "meal" is
 * actually something else (inventory, a supplier payment, payroll). Rather
 * than change WHERE such a txn lands, we refuse to AUTO-CONFIRM it: the
 * journal entry still posts, but `reviewed` stays false so a human sees it in
 * the review queue before the amount is trusted.
 *
 * Pure arithmetic — no DB, no AI, no added latency. Designed to run at every
 * gate that would otherwise set reviewed=true (plaid-promote PFC path and the
 * auto-categorize AI/memory path).
 *
 * No 'server-only': this is pure logic, importable anywhere (server, scripts,
 * tests, client).
 */

/**
 * detail_type slugs that represent a meal (see coa-taxonomy.ts). Any
 * categorization landing on one of these is subject to the amount cap.
 */
const MEAL_DETAIL_TYPES = new Set<string>([
  'entertainment_meals',
  'promotional_meals',
  'travel_meals',
  'trust_meals_for_workers',
]);

const DEFAULT_MEAL_AUTO_APPROVE_CAP = 750;

/**
 * The dollar amount at or below which a meal categorization is allowed to
 * auto-confirm. Above it, the row is forced into the review queue. Override
 * with MEAL_AUTO_APPROVE_CAP (mirrors AUTO_CATEGORIZE_CONFIDENCE_THRESHOLD).
 * When this becomes a per-org setting, swap the call sites to pass the org's
 * configured cap instead of reading the env here.
 */
export function mealAutoApproveCap(): number {
  const raw = process.env.MEAL_AUTO_APPROVE_CAP;
  if (!raw) return DEFAULT_MEAL_AUTO_APPROVE_CAP;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MEAL_AUTO_APPROVE_CAP;
  return n;
}

export function isMealDetailType(detailType: string | null | undefined): boolean {
  return !!detailType && MEAL_DETAIL_TYPES.has(detailType);
}

/**
 * True when a categorization to `detailType` for `amount` is too large to
 * auto-confirm and must go to the review queue (reviewed=false). Only meal
 * categories are gated; every other category returns false (unaffected).
 *
 * @param detailType the resolved category's detail_type slug
 * @param amount     the transaction's positive amount
 */
export function exceedsMealAutoApproveCap(
  detailType: string | null | undefined,
  amount: number | null | undefined,
): boolean {
  if (!isMealDetailType(detailType)) return false;
  if (amount == null || !Number.isFinite(amount)) return false;
  return amount > mealAutoApproveCap();
}
