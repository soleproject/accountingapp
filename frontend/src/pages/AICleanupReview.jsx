import { useSearchParams } from "react-router-dom";
import { useCompany } from "@/lib/company";
import CleanupCopilot from "@/components/CleanupCopilot";

/**
 * AI Categorized Transaction Review Report.
 *
 * Reads `?view=stepper` from the URL so the Dashboard's "Flagged for
 * review" card can deep-link straight into single-category stepper
 * review — matches the expectation that reviewers want to zoom in on
 * one flagged category at a time without navigating menus.
 */
export default function AICleanupReview() {
  const { currentId } = useCompany();
  const [params] = useSearchParams();
  const initialView = params.get("view") === "stepper" ? "stepper" : null;

  return (
    <div className="p-6 max-w-6xl mx-auto" data-testid="ai-cleanup-review-page">
      <CleanupCopilot
        currentId={currentId}
        inline
        initialViewMode={initialView}
        inlineTitle="AI Cleanup Review"
        inlineSubtitle="Every AI-categorized row not yet human-reviewed, grouped by the account it will post to."
      />
    </div>
  );
}
