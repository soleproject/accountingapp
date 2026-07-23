import { useCompany } from "@/lib/company";
import CleanupCopilot from "@/components/CleanupCopilot";

/**
 * AI Categorized Transaction Review Report.
 *
 * Title + subtitle are handed to CleanupCopilot via `inlineTitle` /
 * `inlineSubtitle` so the component can compose them side-by-side with
 * the stepper's group-info card. That way the currently-focused group
 * lives in the same horizontal band as the page title.
 */
export default function AICleanupReview() {
  const { currentId } = useCompany();
  return (
    <div className="p-6 max-w-6xl mx-auto" data-testid="ai-cleanup-review-page">
      <CleanupCopilot
        currentId={currentId}
        inline
        inlineTitle="AI Cleanup Review"
        inlineSubtitle="Every AI-categorized row not yet human-reviewed, grouped by the account it will post to."
      />
    </div>
  );
}
