/**
 * MobileTxnCards — mobile-first card view for the Transactions list.
 *
 * One touch-friendly card per transaction. Swipe gestures:
 *   • swipe right (>60px)  — accept the AI-proposed category if one
 *                             is pending; otherwise no-op with a
 *                             gentle "wobble" so the user knows the
 *                             gesture registered but had nothing to
 *                             do.
 *   • swipe left  (>60px)  — expand the inline category picker so
 *                             the user can re-categorize.
 *   • tap the card          — same as swipe-left (expand picker).
 *
 * Rendered from Transactions.jsx via a conditional. Reuses the same
 * `updateCategory` + AccountPicker so category changes flow through
 * the exact same code path as the desktop table.
 */
import { useState, useRef } from "react";
import { toast } from "sonner";
import { CheckCircle2, Undo2, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import AccountPicker from "@/components/AccountPicker";


function TxnCard({ t, accts, updateCategory, currentId, onReload }) {
  const [dx, setDx] = useState(0);                  // touch delta X
  const [expanded, setExpanded] = useState(false);
  const startX = useRef(null);

  const onTouchStart = (e) => { startX.current = e.touches[0].clientX; };
  const onTouchMove = (e) => {
    if (startX.current == null) return;
    setDx(e.touches[0].clientX - startX.current);
  };
  const onTouchEnd = async () => {
    const d = dx;
    setDx(0);
    if (d > 60) {
      // Swipe right → accept AI proposal if present.
      if (t.ai_proposal_from_answer) {
        try {
          await api.post(`/companies/${currentId}/transactions/${t.id}/accept-proposal`);
          toast.success(`Approved → ${t.ai_proposal_from_answer.account_name || "AI category"}`);
          onReload?.();
        } catch (e) {
          toast.error("Approve failed");
        }
      } else if (t.ai_suggested_category_id && !t.category_account_id) {
        // No formal proposal but the AI has a suggestion → apply it.
        try {
          await updateCategory(t.id, t.ai_suggested_category_id);
          toast.success("Category applied");
        } catch { toast.error("Apply failed"); }
      } else {
        toast.info("Nothing to approve on this row");
      }
    } else if (d < -60) {
      // Swipe left → open picker.
      setExpanded(true);
    }
    startX.current = null;
  };

  const cat = accts.find(a => a.id === t.category_account_id);
  const swipeStyle = { transform: `translateX(${Math.max(-100, Math.min(100, dx))}px)` };
  const swipingRight = dx > 20;
  const swipingLeft = dx < -20;

  return (
    <div className="relative rounded-xl border bg-white shadow-sm overflow-hidden"
         data-testid={`mobile-txn-card-${t.id}`}>
      {/* Background action indicators — visible as user drags. */}
      <div className="absolute inset-y-0 left-0 flex items-center px-4 bg-emerald-500 text-white">
        <CheckCircle2 size={18} />
        <span className="ml-2 text-xs font-semibold">Approve</span>
      </div>
      <div className="absolute inset-y-0 right-0 flex items-center px-4 bg-slate-800 text-white">
        <span className="mr-2 text-xs font-semibold">Re-categorize</span>
        <Undo2 size={18} />
      </div>
      {/* Foreground card — slides horizontally with the touch. */}
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={() => setExpanded(v => !v)}
        style={swipeStyle}
        className={`relative bg-white p-3 transition-transform touch-pan-y ${
          swipingRight ? "shadow-emerald-200" : swipingLeft ? "shadow-slate-300" : ""
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs text-slate-500 font-mono-num">
              {t.date}
              {t.ai_proposal_from_answer && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-cyan-100 text-cyan-800 font-semibold">
                  AI suggested
                </span>
              )}
            </div>
            <div className="font-heading font-semibold text-slate-900 truncate">
              {t.merchant || t.description || "(no payee)"}
            </div>
            <div className="text-xs text-slate-500 mt-0.5 truncate">
              {cat ? cat.name : (t.needs_review ? "Uncategorized" : "—")}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className={`font-heading font-bold tabular-nums ${
              Number(t.amount) < 0 ? "text-red-600" : "text-emerald-700"
            }`}>
              {Number(t.amount) < 0 ? "-" : ""}${Math.abs(Number(t.amount) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <ChevronRight size={14} className="ml-auto text-slate-300 mt-1" />
          </div>
        </div>
        {expanded && (
          <div className="mt-3 pt-3 border-t border-slate-100" onClick={(e) => e.stopPropagation()}>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">Category</div>
            <AccountPicker
              value={t.category_account_id || ""}
              accounts={accts}
              onChange={(id) => updateCategory(t.id, id)}
              companyId={currentId}
              testId={`mobile-txn-cat-${t.id}`}
            />
            <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-400">
              Tip: swipe → to approve · swipe ← to change
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


export default function MobileTxnCards({ txns, accts, updateCategory, currentId, onReload }) {
  if (!txns.length) {
    return (
      <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500 italic"
           data-testid="mobile-txn-empty">
        No transactions.
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="mobile-txn-cards">
      {txns.map(t => (
        <TxnCard
          key={t.id}
          t={t}
          accts={accts}
          updateCategory={updateCategory}
          currentId={currentId}
          onReload={onReload}
        />
      ))}
    </div>
  );
}
