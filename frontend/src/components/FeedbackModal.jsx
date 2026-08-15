import { useState } from "react";
import { X, Bug, Lightbulb, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

/**
 * FeedbackModal — the "Report a bug or recommendation" widget that lives
 * in the profile menu. Auto-captures current route, active company, and
 * user agent so a superadmin triaging in `/admin/feedback` has real
 * repro context without asking the reporter.
 *
 * Submitter gets an in-app inbox at `/feedback/mine` (no status-change
 * emails by product decision — keeps noise low).
 */
export default function FeedbackModal({ onClose, defaultType = "bug" }) {
  const { currentId } = useCompany() || {};
  const [type, setType] = useState(defaultType === "recommendation" ? "recommendation" : "bug");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const route = typeof window !== "undefined"
    ? (window.location.pathname + window.location.search)
    : "";
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";

  const isBug = type === "bug";
  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) { toast.error("Add a short title"); return; }
    setBusy(true);
    try {
      await api.post("/feedback", {
        type,
        title: title.trim(),
        description: description.trim(),
        route,
        user_agent: userAgent,
        company_id: currentId || null,
      });
      toast.success("Thanks — we got it. You can track it in your feedback inbox.");
      onClose && onClose();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't submit feedback");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[1100] bg-slate-900/50 flex items-center justify-center p-4"
      onClick={onClose}
      data-testid="feedback-modal-overlay"
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="bg-white rounded-lg shadow-xl w-full max-w-md"
        data-testid="feedback-modal"
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-100">
          <div>
            <div className="font-heading font-semibold text-slate-900">
              Report a bug or recommendation
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              You'll be able to track its status in your{" "}
              <a href="/feedback/mine" className="underline hover:text-slate-700">
                feedback inbox
              </a>
              .
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100"
            data-testid="feedback-close-btn"
          >
            <X size={16} className="text-slate-500" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setType("bug")}
              data-testid="feedback-type-bug"
              className={`px-3 py-2.5 rounded-md border text-sm font-medium flex items-center justify-center gap-2 transition ${
                isBug
                  ? "border-rose-300 bg-rose-50 text-rose-700"
                  : "border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              <Bug size={14} /> Bug
            </button>
            <button
              type="button"
              onClick={() => setType("recommendation")}
              data-testid="feedback-type-recommendation"
              className={`px-3 py-2.5 rounded-md border text-sm font-medium flex items-center justify-center gap-2 transition ${
                !isBug
                  ? "border-cyan-300 bg-cyan-50 text-cyan-700"
                  : "border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              <Lightbulb size={14} /> Recommendation
            </button>
          </div>

          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Title
            </span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={isBug ? "What went wrong?" : "What would you like to see?"}
              maxLength={200}
              autoFocus
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400"
              data-testid="feedback-title"
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Description
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={isBug
                ? "What did you expect to happen? What happened instead? Steps to reproduce?"
                : "Describe the recommendation and the problem it solves."}
              rows={5}
              maxLength={5000}
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400 resize-none"
              data-testid="feedback-description"
            />
          </label>

          <div className="text-[11px] text-slate-500">
            Submitted from{" "}
            <code className="bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
              {route || "/"}
            </code>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-slate-100 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm text-slate-600 hover:bg-slate-100"
            data-testid="feedback-cancel-btn"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-md bg-cyan-600 text-white text-sm font-medium hover:bg-cyan-700 disabled:opacity-50"
            data-testid="feedback-submit-btn"
          >
            {busy && <Loader2 size={13} className="animate-spin" />} Submit
          </button>
        </div>
      </form>
    </div>
  );
}
