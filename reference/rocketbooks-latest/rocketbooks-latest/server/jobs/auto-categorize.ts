import 'server-only';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { inngest } from '@/lib/inngest';
import { db } from '@/db/client';
import { transactions, plaidRawTransactions, chartOfAccounts } from '@/db/schema/schema';
import { categorizeTransaction } from '@/lib/ai/categorization';
import { createJournalEntryFromTransaction, repostTransactionJE } from '@/lib/accounting/auto-post';
import { exceedsMealAutoApproveCap } from '@/lib/accounting/meal-auto-approve-guard';
import {
  lookupBeneficiaryMemoryWithQualifyingCheck,
  getAccountDetailType,
  isPerBeneficiaryDetailType,
} from '@/lib/accounting/beneficiary-memory';
import { logger } from '@/lib/logger';
import { getOrgAutomationSettings } from '@/lib/accounting/automation-settings';

interface PlaidPfc {
  primary?: string | null;
  detailed?: string | null;
  confidence_level?: string | null;
}

/** Look up Plaid Personal Finance Category for a representative txn via its
 *  reference field (set as 'plaid:<plaid_txn_id>' during promotion). */
async function loadPlaidPfc(reference: string | null): Promise<PlaidPfc | null> {
  if (!reference?.startsWith('plaid:')) return null;
  const plaidTxnId = reference.slice('plaid:'.length);
  if (!plaidTxnId) return null;

  const [raw] = await db
    .select({ rawJson: plaidRawTransactions.rawJson })
    .from(plaidRawTransactions)
    .where(eq(plaidRawTransactions.plaidTransactionId, plaidTxnId))
    .limit(1);
  if (!raw?.rawJson) return null;
  const json = raw.rawJson as { personal_finance_category?: PlaidPfc };
  return json.personal_finance_category ?? null;
}

type TxnRow = typeof transactions.$inferSelect;

/**
 * Group transactions by (contactId or fallback to description) AND type.
 * Same merchant + same type goes through ONE categorize call; the result
 * gets applied to every transaction in the group. Guarantees within-batch
 * consistency: if AI says 'Travel' for the first United Airlines deposit,
 * every other United Airlines deposit in this batch gets 'Travel' too.
 */
function groupByMerchant(txns: TxnRow[]): Map<string, TxnRow[]> {
  const groups = new Map<string, TxnRow[]>();
  for (const t of txns) {
    const merchantKey =
      t.contactId
        ? `c:${t.contactId}`
        : `d:${(t.bankDescription ?? t.description ?? '').toLowerCase().trim()}`;
    const key = `${merchantKey}|${t.type ?? '?'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  return groups;
}

function pickRepresentative(group: TxnRow[]): TxnRow {
  // Most recent date — vendor memory matches future-most-recent first
  return [...group].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0];
}

interface UncategorizedSlots {
  /** chart_of_accounts.id for "Uncategorized Expense" in this org, or null if absent. */
  expense: string | null;
  /** chart_of_accounts.id for "Uncategorized Income" in this org, or null if absent. */
  income: string | null;
}

/**
 * When AI can't pick a confident category, decision IS "Uncategorized" — post
 * each txn (that doesn't already have a JE) to the org's Uncategorized
 * Expense/Income account based on direction, with reviewed=false so it
 * surfaces in the user's review queue. Without this, low_confidence /
 * no_match rows would sit in JE-less limbo waiting for the 15-min
 * stuck-pending-fallback cron — auto-cat already looked at them, the
 * decision should be made now.
 *
 * Skips txns that already have a JE (Plaid PFC primary or Veryfi primary
 * match — those are correct already) and txns the user has confirmed
 * (reviewed=true).
 */
async function decisionGroupToUncategorized(
  group: TxnRow[],
  organizationId: string,
  uncat: UncategorizedSlots,
  prov: CategorizationProvenance | null,
): Promise<number> {
  let posted = 0;
  for (const txn of group) {
    if (txn.amount == null || !txn.type || !txn.accountId) continue;
    if (txn.reviewed === true) continue;
    if (txn.journalEntryId) continue;
    const acctId = txn.type === 'deposit' ? uncat.income : uncat.expense;
    if (!acctId) continue;
    const jeId = await createJournalEntryFromTransaction({
      id: txn.id,
      organizationId,
      date: txn.date,
      type: txn.type,
      amount: txn.amount,
      accountId: txn.accountId,
      categoryAccountId: acctId,
      contactId: txn.contactId ?? null,
      bankDescription: txn.bankDescription,
      userDescription: txn.userDescription,
    });
    await db
      .update(transactions)
      .set({ categoryAccountId: acctId, journalEntryId: jeId, reviewed: false, ...provColumns(prov) })
      .where(eq(transactions.id, txn.id));
    posted++;
  }
  return posted;
}

/**
 * Provenance the categorizer learned about a group's representative txn.
 * Persisted on every row in the group so the accountant review queue can
 * explain the decision (reason + how confident + which signal) without
 * re-running the model. For no_match / low_confidence rows parked on
 * Uncategorized, this is exactly the "why is this here?" the reviewer needs.
 */
interface CategorizationProvenance {
  confidence: number;
  reason: string;
  source: string;
}

function provColumns(prov: CategorizationProvenance | null) {
  return {
    aiConfidence: prov?.confidence ?? null,
    aiReason: prov?.reason ?? null,
    aiSource: prov?.source ?? null,
    aiCategorizedAt: new Date().toISOString(),
  };
}

export const autoCategorize = inngest.createFunction(
  {
    id: 'auto-categorize',
    concurrency: { limit: 1, key: 'event.data.organizationId' },
    retries: 2,
    triggers: [
      { event: 'plaid/promote.completed' },
      { event: 'transactions/auto-categorize.requested' },
    ],
  },
  async ({ event, step }) => {
    const { organizationId, transactionIds } = event.data as {
      organizationId: string;
      transactionIds: string[];
    };
    if (!organizationId || transactionIds.length === 0) {
      return { skipped: true, reason: 'no_input' };
    }
    if (!process.env.OPENAI_API_KEY) {
      logger.warn('auto-categorize: OPENAI_API_KEY not set, skipping');
      return { skipped: true, reason: 'no_openai_key' };
    }

    // Per-org automation settings — auto-post on/off + confidence threshold.
    // Falls back to the env/0.85 default so untouched orgs are unchanged.
    const automation = await step.run('load-automation-settings', () =>
      getOrgAutomationSettings(organizationId),
    );

    // Load all the txns up front so we can group
    const txns = await step.run('load-txns', async () =>
      db
        .select()
        .from(transactions)
        .where(and(inArray(transactions.id, transactionIds), eq(transactions.organizationId, organizationId))),
    );

    // Resolve the org's Uncategorized Expense / Income accounts once per run.
    // Used as the destination when AI returns no_match or low_confidence —
    // auto-cat decisions those rows to Uncategorized so they hit the GL
    // immediately and land in the user's review queue.
    const uncat = await step.run('load-uncategorized-accts', async (): Promise<UncategorizedSlots> => {
      const rows = await db
        .select({ id: chartOfAccounts.id, accountName: chartOfAccounts.accountName })
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.organizationId, organizationId),
            sql`${chartOfAccounts.accountName} IN ('Uncategorized Expense', 'Uncategorized Income')`,
          ),
        );
      return {
        expense: rows.find((r) => r.accountName === 'Uncategorized Expense')?.id ?? null,
        income: rows.find((r) => r.accountName === 'Uncategorized Income')?.id ?? null,
      };
    });

    const groups = groupByMerchant(txns);
    const stats = {
      posted: 0,
      low_confidence: 0,
      no_match: 0,
      errors: 0,
      groups: groups.size,
      txns: txns.length,
    };

    for (const [groupKey, group] of groups) {
      const rep = pickRepresentative(group);
      if (!rep.amount || !rep.type || !rep.accountId) {
        continue;
      }

      try {
        const groupResult = await step.run(`group-${groupKey.slice(0, 60)}`, async () => {
          // If this is a Plaid txn, fetch the PFC hint
          const pfc = await loadPlaidPfc(rep.reference);

          // Categorize the representative — memory + AI fallback
          const suggestion = await categorizeTransaction({
            organizationId,
            description: rep.userDescription || rep.bankDescription || rep.description || '',
            amount: rep.amount!,
            type: rep.type!,
            date: rep.date,
            contactId: rep.contactId ?? null,
            plaidPfc: pfc
              ? { primary: pfc.primary, detailed: pfc.detailed, confidenceLevel: pfc.confidence_level }
              : null,
          });

          // Provenance carried onto every row the categorizer decides — the
          // reviewer sees the same explanation whether the row auto-posted or
          // was parked on Uncategorized for review.
          const provenance: CategorizationProvenance = {
            confidence: suggestion.confidence,
            reason: suggestion.reason,
            source: suggestion.source,
          };

          if (!suggestion.accountId) {
            // AI couldn't find a category. Decision: post the group to
            // Uncategorized so it's on the GL and in the review queue now,
            // not waiting for the 15-min fallback cron.
            const posted = await decisionGroupToUncategorized(group, organizationId, uncat, provenance);
            return { outcome: 'no_match' as const, count: posted };
          }
          if (suggestion.confidence < automation.autoPostThreshold) {
            // AI's pick wasn't confident enough. Same decision — park on
            // Uncategorized rather than punting to the 15-min cron.
            const posted = await decisionGroupToUncategorized(group, organizationId, uncat, provenance);
            return { outcome: 'low_confidence' as const, count: posted, confidence: suggestion.confidence };
          }

          // Apply to EVERY txn in the group. The invariant from the promote
          // step is "every transaction has a JE" — including those parked
          // on the Uncategorized fallback. So we don't skip posted rows;
          // instead we either reverse-and-repost (when AI disagrees with
          // the current category) or just mark reviewed=true (when it
          // agrees, e.g. AI also picks Uncategorized for a genuinely
          // ambiguous row).
          //
          // We DO skip rows the user has already confirmed (reviewed=true).
          //
          // Per-beneficiary trust account memory: if the picked category is
          // one of 815/820/310/635, look up "this merchant on this account
          // got tagged to which beneficiary last time" and auto-tag if so.
          // Per-txn lookup (because date differs across the group for the
          // 815/820 qualifying check) but the detail_type fetch is hoisted
          // out of the loop.
          const newCategoryDetailType = await getAccountDetailType({
            organizationId,
            accountId: suggestion.accountId,
          });
          const categoryNeedsBeneficiary = isPerBeneficiaryDetailType(newCategoryDetailType);

          let posted = 0;
          for (const txn of group) {
            if (txn.amount == null || !txn.type || !txn.accountId) continue;
            if (txn.reviewed === true) continue; // user-confirmed; don't override

            // Single-source-of-truth for contact: whatever resolveContact put
            // on the row at promote time. Auto-categorize doesn't touch it.
            const contactId = txn.contactId ?? null;
            const newCategoryId = suggestion.accountId;
            const currentCategoryId = txn.categoryAccountId;

            let beneficiaryId: string | null = null;
            if (categoryNeedsBeneficiary) {
              const memory = await lookupBeneficiaryMemoryWithQualifyingCheck({
                organizationId,
                categoryAccountId: newCategoryId,
                categoryDetailType: newCategoryDetailType,
                asOfDate: txn.date,
                contactId,
                description: txn.bankDescription ?? txn.description,
                type: txn.type,
              });
              beneficiaryId = memory?.beneficiaryId ?? null;
            }

            const txnForPosting = {
              id: txn.id,
              organizationId,
              date: txn.date,
              type: txn.type,
              amount: txn.amount,
              accountId: txn.accountId,
              categoryAccountId: newCategoryId,
              contactId,
              bankDescription: txn.bankDescription,
              userDescription: txn.userDescription,
              beneficiaryId,
            };

            // Auto-confirm (reviewed=true) only when the org has auto-post
            // enabled. When it's off, the AI's category still gets applied +
            // posted, but reviewed=false so every row waits in the review queue
            // for one-click approval ("feels automatic but a human pressed go").
            //
            // Amount gate: a large meal is almost always a mis-tag (Plaid
            // FOOD_AND_DRINK on a supplier payment, a poisoned vendor-memory
            // cascade, or a meal-eager AI guess). Post the JE either way, but
            // don't auto-confirm an oversized meal — leave reviewed=false so
            // it surfaces in the review queue. newCategoryDetailType is
            // hoisted above the loop, so this is pure arithmetic per txn.
            const autoReviewed =
              automation.autoPostEnabled && !exceedsMealAutoApproveCap(newCategoryDetailType, txn.amount);

            if (txn.journalEntryId) {
              // Already posted (likely to Uncategorized at promote time).
              if (currentCategoryId === newCategoryId) {
                // AI agrees with what's already there — mark reviewed unless
                // the amount gate holds it for review.
                await db
                  .update(transactions)
                  .set({ reviewed: autoReviewed, ...provColumns(provenance) })
                  .where(eq(transactions.id, txn.id));
              } else {
                // AI picked a different category. Reverse the existing JE
                // and post a new one against the new category. Then sync the
                // transactions row.
                await repostTransactionJE({
                  txn: txnForPosting,
                  existingJournalEntryId: txn.journalEntryId,
                });
                await db
                  .update(transactions)
                  .set({ categoryAccountId: newCategoryId, reviewed: autoReviewed, ...provColumns(provenance) })
                  .where(eq(transactions.id, txn.id));
              }
            } else {
              // No JE yet — the common case for PFC fallback / unmapped
              // rows. plaid-promote skips JE creation for those and lets
              // auto-categorize be the first poster, which avoids the
              // post → reverse → re-post churn of pre-staging to 5999.
              const jeId = await createJournalEntryFromTransaction(txnForPosting);
              await db
                .update(transactions)
                .set({
                  categoryAccountId: newCategoryId,
                  journalEntryId: jeId,
                  reviewed: autoReviewed,
                  ...provColumns(provenance),
                })
                .where(eq(transactions.id, txn.id));
            }

            posted++;
          }

          return { outcome: 'posted' as const, count: posted, confidence: suggestion.confidence, source: suggestion.source };
        });

        switch (groupResult.outcome) {
          case 'posted':
            stats.posted += groupResult.count;
            break;
          case 'low_confidence':
            stats.low_confidence += groupResult.count;
            break;
          case 'no_match':
            stats.no_match += groupResult.count;
            break;
        }
      } catch (err) {
        stats.errors += group.length;
        logger.error(
          { groupKey, err: err instanceof Error ? err.message : err },
          'auto-categorize: group failed',
        );
      }
    }

    logger.info(
      { organizationId, autoPostEnabled: automation.autoPostEnabled, autoPostThreshold: automation.autoPostThreshold, ...stats },
      'auto-categorize done',
    );
    return { autoPostEnabled: automation.autoPostEnabled, autoPostThreshold: automation.autoPostThreshold, ...stats };
  },
);
