/**
 * The three guided-review flows reachable from the "Start guided review" picker.
 * Shared by the AI tool (start_guided_review), the sidecar quick-reply intercept,
 * and the stepper so the URLs never drift. Keep in sync with the stepper hrefs in
 * app/(app)/transactions/page.tsx.
 */
export const GUIDED_REVIEW_URLS = {
  deposits: '/transactions?deposits=1&withdrawals=0&reviewed=0&unreviewed=1&filter=to_review&guide=1',
  ai_categorized: '/transactions?filter=to_verify&guide=1&deposits=1&withdrawals=1',
  uncategorized: '/transactions?reviewed=0&unreviewed=1&deposits=0&withdrawals=1&filter=to_review&guide=1',
} as const;

export type GuidedReviewKey = keyof typeof GUIDED_REVIEW_URLS;

/** The exact picker-button labels (from the AI's [[suggestions]]) → flow key, so
 *  the sidecar can navigate deterministically when one is tapped. */
export const GUIDED_REVIEW_LABELS: Record<string, GuidedReviewKey> = {
  'review deposits': 'deposits',
  'review ai categorized': 'ai_categorized',
  'review uncategorized': 'uncategorized',
};
