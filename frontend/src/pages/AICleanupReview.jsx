import { useCompany } from "@/lib/company";
import CleanupCopilot from "@/components/CleanupCopilot";
import { Sparkles, ClipboardCheck } from "lucide-react";

/**
 * AI Categorized Transaction Review Report.
 *
 * Layout mirrors the Transactions page: Cleanup Copilot banner first,
 * then the section title + description, then the report card. We pass
 * the title JSX as `reportHeader` so CleanupCopilot renders it between
 * its own banner and the inline report body.
 */
export default function AICleanupReview() {
  const { currentId } = useCompany();

  const reportHeader = (
    <div className="mt-6">
      <div className="flex items-baseline justify-between mb-1">
        <div className="flex items-center gap-2 text-slate-500 text-sm">
          <ClipboardCheck size={14} /> Accounting · AI Cleanup Review
        </div>
        <span className="hidden md:inline-flex items-center gap-1 text-[11px] text-fuchsia-700 bg-fuchsia-50 border border-fuchsia-200 rounded-full px-2 py-0.5">
          <Sparkles size={11} /> Copilot report
        </span>
      </div>
      <h1 className="text-2xl font-heading font-bold text-slate-900 mb-1">
        AI Categorized Transaction Review
      </h1>
      <p className="text-sm text-slate-600">
        Every AI-categorized row that hasn't been human-reviewed yet, grouped by the account
        the AI wants to post them to. Approve a bucket, override a category, or approve an
        entire group in one click.
      </p>
    </div>
  );

  return (
    <div className="p-6 max-w-6xl mx-auto" data-testid="ai-cleanup-review-page">
      <CleanupCopilot currentId={currentId} inline reportHeader={reportHeader} />
    </div>
  );
}
