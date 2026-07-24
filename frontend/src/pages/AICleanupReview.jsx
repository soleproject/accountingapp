import { useSearchParams } from "react-router-dom";
import { useCompany } from "@/lib/company";
import CleanupCopilot from "@/components/CleanupCopilot";

/**
 * AI Categorized Transaction Review Report.
 *
 * Reads `?view=` from the URL so the Dashboard's checklist / attention
 * cards can deep-link straight into the mode the CPA needs:
 *   • `?view=stepper`  → single-group-at-a-time stepper (Step 1 in Setup)
 *   • `?view=category` → all vendor groups side-by-side (Step 2 in Setup)
 *   • (unset)          → default grouped view (inline layout)
 */
export default function AICleanupReview() {
  const { currentId } = useCompany();
  const [params] = useSearchParams();
  const rawView = params.get("view");
  const initialView =
    rawView === "stepper" ? "stepper"
    : rawView === "category" || rawView === "grouped" ? "category"
    : rawView === "rows" ? "rows"
    : null;

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
