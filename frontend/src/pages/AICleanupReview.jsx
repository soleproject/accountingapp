import { useCompany } from "@/lib/company";
import CleanupCopilot from "@/components/CleanupCopilot";

/**
 * AI Categorized Transaction Review Report.
 *
 * Layout mirrors the Transactions page pixel-for-pixel: Cleanup Copilot
 * banner first, then a plain h1 + one-line subtitle, then the report
 * card. No breadcrumb, no side pill — Transactions doesn't have those
 * and the user wanted these two pages visually consistent.
 */
export default function AICleanupReview() {
  const { currentId } = useCompany();

  const reportHeader = (
    <div className="mt-6 mb-3 flex items-baseline justify-between gap-4">
      <div>
        <h1 className="text-3xl font-heading font-bold text-slate-900 leading-tight">
          AI Cleanup Review
        </h1>
        <div className="text-sm text-slate-500 mt-1">
          Every AI-categorized row not yet human-reviewed, grouped by the account it will post to.
        </div>
      </div>
    </div>
  );

  return (
    <div className="p-6 max-w-6xl mx-auto" data-testid="ai-cleanup-review-page">
      <CleanupCopilot currentId={currentId} inline reportHeader={reportHeader} />
    </div>
  );
}
