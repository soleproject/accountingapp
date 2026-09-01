import { X, AlertTriangle, Loader2 } from "lucide-react";
import { useState } from "react";

/**
 * Small confirmation dialog used to gate destructive bulk actions.
 * Sits on top of every bulk flow on the Transactions page after a
 * user accidentally applied the wrong contact to 25 live rows in
 * March 2026 — the picker (or Approve all button) opens this so
 * the write only fires after an explicit second confirm.
 *
 * Props
 * -----
 * title        headline, e.g. "Reclassify 25 transactions?"
 * body         short summary of what will happen
 * confirmLabel action button text, e.g. "Reclassify 25"
 * variant      "primary" | "danger"    — colours the confirm button
 * onConfirm    async () => void        — awaited so we can show a spinner
 * onCancel     () => void
 */
export default function BulkConfirmModal({
  title, body, confirmLabel, variant = "primary", onConfirm, onCancel,
}) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try { await onConfirm(); }
    finally { setBusy(false); }
  };

  const confirmCls = variant === "danger"
    ? "bg-rose-600 hover:bg-rose-700"
    : "bg-emerald-600 hover:bg-emerald-700";

  return (
    <div className="fixed inset-0 z-[90] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm">
        <div className="px-5 py-4 border-b flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-amber-100 p-1.5">
            <AlertTriangle size={16} className="text-amber-600" />
          </div>
          <div className="flex-1">
            <h3 className="font-heading font-semibold text-slate-900">{title}</h3>
            {body && <p className="text-xs text-slate-500 mt-1">{body}</p>}
          </div>
          <button
            onClick={onCancel}
            disabled={busy}
            data-testid="bulk-confirm-close"
            className="text-slate-400 hover:text-slate-700 disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            data-testid="bulk-confirm-cancel"
            className="px-3 py-1.5 text-sm rounded-md border hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={run}
            disabled={busy}
            data-testid="bulk-confirm-apply"
            className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white rounded-md ${confirmCls} disabled:opacity-70`}
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {busy ? "Applying…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
