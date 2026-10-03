// Pick a transaction for a receipt (mode="receipt") or a receipt for a
// transaction (mode="transaction"). Candidates come pre-scored from the
// fuzzy matcher; one click links them.
import { useEffect, useState } from "react";
import { Loader2, Link2, X, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

const money = (n) => `$${Math.abs(Number(n || 0)).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
const fmt = (iso) => (iso ? new Date(iso + (iso.length === 10 ? "T00:00:00" : "")).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");

export default function ReceiptMatchPicker({ companyId, mode, id, onClose, onDone }) {
  const [cands, setCands] = useState(null);
  const [busy, setBusy] = useState(null);
  const url = mode === "receipt"
    ? `/companies/${companyId}/receipts/${id}/match-candidates`
    : `/companies/${companyId}/transactions/${id}/receipt-candidates`;

  useEffect(() => {
    setCands(null);
    api.get(url).then((r) => setCands(r.data.candidates || [])).catch(() => setCands([]));
  }, [url]);

  const pick = async (c) => {
    const rid = mode === "receipt" ? id : c.receipt_id;
    const tid = mode === "receipt" ? c.transaction_id : id;
    setBusy(rid + tid);
    try {
      await api.post(`/companies/${companyId}/receipts/${rid}/match`, { transaction_id: tid });
      toast.success("Receipt attached to the transaction.");
      onDone?.({ receipt_id: rid, transaction_id: tid });
      onClose?.();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't attach the receipt.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-slate-900/40 backdrop-blur-[2px]" data-testid="receipt-match-picker">
      <div className="w-[min(560px,92vw)] rounded-2xl border border-slate-200 bg-white shadow-2xl p-5">
        <div className="flex items-start gap-3">
          <div>
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-indigo-600 font-semibold"><Link2 size={13} /> {mode === "receipt" ? "Attach to a transaction" : "Attach an existing receipt"}</div>
            <p className="text-sm text-slate-500 mt-1">Closest matches by amount, date, account and merchant. Pick one to link them.</p>
          </div>
          <button onClick={onClose} className="ml-auto p-1.5 rounded-md hover:bg-slate-100" data-testid="receipt-match-close"><X size={16} /></button>
        </div>
        <div className="mt-4 max-h-[50vh] overflow-y-auto divide-y divide-slate-100 rounded-lg border border-slate-200">
          {cands === null && <div className="p-6 text-center text-slate-400"><Loader2 size={16} className="animate-spin inline" /></div>}
          {cands?.length === 0 && (
            <div className="p-6 text-center text-sm text-slate-500" data-testid="receipt-match-empty">
              No likely matches within 5 days. {mode === "receipt" ? "The bank transaction may not have posted yet — we'll link it automatically when it does." : "Upload the receipt with “Add receipt” instead."}
            </div>
          )}
          {cands?.map((c) => {
            const key = mode === "receipt" ? c.transaction_id : c.receipt_id;
            return (
              <button key={key} onClick={() => pick(c)} disabled={!!busy}
                      className="w-full text-left px-3 py-2.5 hover:bg-indigo-50/60 flex items-center gap-3 disabled:opacity-60"
                      data-testid={`receipt-match-option-${key}`}>
                <div className="w-14 text-xs text-slate-500 font-mono-num">{fmt(c.date)}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-800 truncate">{mode === "receipt" ? (c.description || "Transaction") : (c.merchant || "Receipt")}{mode !== "receipt" && c.has_image && <Paperclip size={11} className="inline ml-1 text-slate-400" />}</div>
                  <div className="text-[11px] text-slate-400 truncate">{(c.reasons || []).join(" · ")}</div>
                </div>
                <div className="text-sm font-mono-num text-slate-900">{money(c.amount)}</div>
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${c.confidence === "high" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{c.score}%</span>
                {busy === (mode === "receipt" ? id + c.transaction_id : c.receipt_id + id) && <Loader2 size={13} className="animate-spin text-slate-400" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
