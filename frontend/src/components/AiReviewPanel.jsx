import { useState } from "react";
import { CheckCircle2, AlertTriangle, Download, Loader2, XCircle, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

const usd = (n) => n == null ? "—" : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function AiReviewPanel({ doc, companyId, onChanged }) {
  const [busy, setBusy] = useState(null);
  const review = doc.ai_review;
  if (!review) return null;
  const s = review.summary || {};
  const r = review.reconciliation || {};
  const t = s.totals || {};
  const held = doc.status === "needs_review";

  const act = async (kind) => {
    setBusy(kind);
    try {
      const res = await api.post(`/companies/${companyId}/statements/imports/${doc.id}/${kind}`);
      toast.success(kind === "approve" ? `Posted ${res.data.transaction_count} transactions` : "Import rejected — nothing was posted");
      onChanged?.();
    } catch (e) { toast.error(e?.response?.data?.detail || `Couldn't ${kind}`); }
    finally { setBusy(null); }
  };

  const download = async () => {
    setBusy("export");
    try {
      const res = await api.get(`/companies/${companyId}/statements/imports/${doc.id}/export.xlsx`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a"); a.href = url;
      a.download = (doc.filename || "statement").replace(/\.[^.]+$/, "") + "_transactions.xlsx"; a.click();
      URL.revokeObjectURL(url);
    } catch { toast.error("Export failed"); }
    finally { setBusy(null); }
  };

  const Row = ({ label, value, ok, drift, extracted }) => (
    <div className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0 text-sm">
      <span className="text-slate-600">{label}</span>
      <span className="flex items-center gap-3 tabular-nums">
        {extracted != null && <span className="text-xs text-slate-400">extracted {usd(extracted)}</span>}
        <span className="font-medium text-slate-900">{usd(value)}</span>
        {ok === true && <CheckCircle2 size={14} className="text-emerald-600" />}
        {ok === false && <span className="text-xs text-rose-700 font-semibold inline-flex items-center gap-1"><AlertTriangle size={12} /> off by {usd(Math.abs(drift || 0))}</span>}
      </span>
    </div>
  );

  return (
    <div className={`rounded-xl border p-4 ${held ? "border-rose-200 bg-rose-50/40" : "border-indigo-200 bg-indigo-50/30"}`} data-testid="ai-review-panel">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-xs uppercase tracking-widest font-semibold text-indigo-800 inline-flex items-center gap-1"><Sparkles size={12} /> AI Review · GPT-4o</div>
          <div className="text-sm text-slate-700 mt-1">
            {s.bank_name || "Statement"} · {s.account_type?.replace("_", " ")} {s.account_number_masked ? `· ${s.account_number_masked}` : ""} · {s.period_start} → {s.period_end}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">{r.count_withdrawals ?? 0} withdrawals · {r.count_deposits ?? 0} deposits · {review.pages} pages{r.retried ? " · second pass used" : ""}</div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={download} disabled={busy === "export"} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-slate-300 bg-white text-xs font-semibold hover:border-slate-500" data-testid="ai-review-export">
            {busy === "export" ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Export Excel
          </button>
        </div>
      </div>

      <div className="rounded-lg bg-white border border-slate-200 px-4 py-1" data-testid="ai-review-summary">
        <Row label="Beginning Balance" value={s.beginning_balance} />
        <Row label="Deposits / Payments Received" value={t.deposits} ok={r.deposits_ok} drift={r.deposits_drift} extracted={r.deposits_extracted} />
        <Row label="Withdrawals / Purchases" value={t.withdrawals} ok={r.withdrawals_ok} drift={r.withdrawals_drift} extracted={r.withdrawals_extracted} />
        <Row label="Fees" value={t.fees} />
        <Row label="Interest" value={t.interest} />
        <Row label="Ending Balance" value={s.ending_balance} ok={r.balance_ok} drift={r.balance_drift} />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        {r.ties ? (
          <div className="text-sm text-emerald-800 inline-flex items-center gap-1.5" data-testid="ai-review-ties"><CheckCircle2 size={15} /> Extracted transactions tie to the statement summary.</div>
        ) : (
          <div className="text-sm text-rose-800 inline-flex items-center gap-1.5" data-testid="ai-review-drift"><AlertTriangle size={15} /> Totals don't tie — nothing has been posted. Review the rows below, then approve or reject.</div>
        )}
        {held && (
          <div className="flex items-center gap-2">
            <button onClick={() => act("reject")} disabled={!!busy} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full border border-slate-300 bg-white text-sm font-semibold hover:border-rose-400 hover:text-rose-700 disabled:opacity-50" data-testid="ai-review-reject">
              <XCircle size={14} /> Reject
            </button>
            <button onClick={() => act("approve")} disabled={!!busy} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50" data-testid="ai-review-approve">
              {busy === "approve" ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Approve &amp; post anyway
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function AiRowsTable({ rows }) {
  if (!rows?.length) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden" data-testid="ai-review-rows">
      <div className="px-4 py-2 border-b bg-slate-50 text-xs font-semibold text-slate-600">Extracted rows (not yet posted)</div>
      <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 sticky top-0">
            <tr><th className="px-3 py-2 text-left">Post</th><th className="px-3 py-2 text-left">Trans</th><th className="px-3 py-2 text-left">Description</th><th className="px-3 py-2 text-left">Ref / Check</th><th className="px-3 py-2 text-right">Withdrawal</th><th className="px-3 py-2 text-right">Deposit</th><th className="px-3 py-2 text-left">Cardholder</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="px-3 py-1.5 text-xs text-slate-600 whitespace-nowrap">{r.post_date}</td>
                <td className="px-3 py-1.5 text-xs text-slate-500 whitespace-nowrap">{r.trans_date || "—"}</td>
                <td className="px-3 py-1.5 text-slate-800">{r.description}</td>
                <td className="px-3 py-1.5 text-xs text-slate-500 font-mono">{r.check_number ? `#${r.check_number}` : (r.reference || "—")}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-rose-700">{r.direction === "withdrawal" ? usd(r.amount) : ""}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700">{r.direction === "deposit" ? usd(r.amount) : ""}</td>
                <td className="px-3 py-1.5 text-xs text-slate-500">{r.cardholder || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
