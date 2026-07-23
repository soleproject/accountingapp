import { useCompany } from "@/lib/company";
import CleanupCopilot from "@/components/CleanupCopilot";
import { Sparkles, ClipboardCheck } from "lucide-react";

/**
 * AI Categorized Transaction Review Report.
 *
 * Same top-of-page Cleanup Copilot banner as the Transactions page, but
 * the table below is replaced with the inline version of the bulk-
 * approve report — grouped by category by default, with per-bucket and
 * per-group Approve buttons. Purpose: a dedicated review surface that
 * bookkeepers can pull up at month-end without wading through every
 * transaction row.
 *
 * The report auto-opens on mount (CleanupCopilot's `inline` prop drives
 * that) so this page has no chrome of its own — the copilot component
 * owns the whole flow.
 */
export default function AICleanupReview() {
  const { currentId } = useCompany();

  return (
    <div className="p-6 max-w-6xl mx-auto" data-testid="ai-cleanup-review-page">
      <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
        <ClipboardCheck size={14} /> Accounting · AI Cleanup Review
      </div>
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-2xl font-heading font-bold text-slate-900">
          AI Categorized Transaction Review
        </h1>
        <span className="hidden md:inline-flex items-center gap-1 text-[11px] text-fuchsia-700 bg-fuchsia-50 border border-fuchsia-200 rounded-full px-2 py-0.5">
          <Sparkles size={11} /> Copilot report
        </span>
      </div>
      <p className="text-sm text-slate-600 mb-4">
        Every AI-categorized row that hasn't been human-reviewed yet, grouped by the account
        the AI wants to post them to. Approve a bucket, override a category, or approve an
        entire group in one click.
      </p>
      <CleanupCopilot currentId={currentId} inline />
    </div>
  );
}
