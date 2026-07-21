import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";
import {
  ArrowLeft, CheckCircle2, Loader2, CalendarDays, Building2, User,
} from "lucide-react";

// Reconciliation detail — the drill-down when a user clicks a row in the
// history table. Shows the snapshot at completion time (statement balance,
// ledger balance, difference) plus the full list of transactions that were
// cleared as part of this reconciliation.
export default function ReconciliationDetail() {
  const { rid } = useParams();
  const { currentId } = useCompany();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentId || !rid) return;
    setLoading(true);
    api.get(`/companies/${currentId}/reconciliations/${rid}`)
      .then(r => setData(r.data))
      .catch(e => toast.error(e.response?.data?.detail || "Failed to load"))
      .finally(() => setLoading(false));
  }, [currentId, rid]);

  if (loading) return (
    <div className="p-10 text-center text-slate-500 text-sm">
      <Loader2 size={16} className="animate-spin inline mr-2" /> Loading…
    </div>
  );
  if (!data) return (
    <div className="p-10 text-center text-slate-500 text-sm">Reconciliation not found.</div>
  );

  const r = data.reconciliation;
  const a = data.account;
  const txns = data.transactions || [];
  const balanced = Math.abs(r.diff || 0) < 0.005;

  return (
    <div className="space-y-4" data-testid="recon-detail-page">
      <Link to="/accounting/reconciliation" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
        <ArrowLeft size={14} /> Back to reconciliations
      </Link>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">
            Reconciliation · {a?.name || "—"}
            {a?.mask && <span className="text-slate-400 text-lg font-normal"> ···{a.mask}</span>}
          </h1>
          <p className="text-slate-500 text-sm mt-1 flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1">
              <CalendarDays size={13} /> {r.period_start || r.as_of} → {r.period_end || r.as_of}
            </span>
            {r.completed_by && (
              <span className="inline-flex items-center gap-1">
                <User size={13} /> {r.completed_by}
              </span>
            )}
            <span className={`text-[10px] uppercase px-2 py-0.5 rounded ${
              r.status === "reconciled" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"
            }`}>
              {r.status || r.source || "manual"}
            </span>
          </p>
        </div>
      </div>

      {/* Summary card */}
      <div className={`rounded-xl border bg-white p-5 ${balanced ? "ring-2 ring-emerald-200" : ""}`}
           data-testid="recon-detail-summary">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StatBlock label="Statement balance" value={r.statement_balance || 0} />
          <StatBlock label="Ledger balance"    value={r.ledger_balance || 0} />
          <StatBlock label={`Matched (${txns.length})`} value={r.ledger_balance || 0} muted />
          <StatBlock label="Difference" value={r.diff || 0}
                     accent={balanced ? "emerald" : "red"} />
        </div>
        <div className={`mt-3 text-xs ${balanced ? "text-emerald-700" : "text-red-700"}`}>
          {balanced
            ? <><CheckCircle2 size={13} className="inline mr-1" /> Books match the statement.</>
            : "The reconciliation snapshot is off — a matched transaction may have been edited or deleted since."
          }
        </div>
      </div>

      {/* Cleared transactions */}
      <div className="rounded-xl border bg-white overflow-hidden" data-testid="recon-detail-txns">
        <div className="px-4 py-2 border-b bg-slate-50 text-xs uppercase tracking-widest text-slate-500 flex items-center justify-between">
          <span>Transactions cleared in this reconciliation</span>
          <span className="text-slate-400 normal-case tracking-normal">{txns.length} items</span>
        </div>
        {txns.length === 0 ? (
          <div className="p-10 text-center text-slate-500 text-sm">
            No transactions attached to this reconciliation.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase text-slate-500 border-b">
              <tr>
                <th className="px-4 py-2 text-left">Date</th>
                <th className="px-4 py-2 text-left">Description</th>
                <th className="px-4 py-2 text-left">Category</th>
                <th className="px-4 py-2 text-center">Source</th>
                <th className="px-4 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {txns.map(t => (
                <tr key={t.id} className="border-b last:border-b-0 hover:bg-slate-50">
                  <td className="px-4 py-2 font-mono-num text-slate-600 text-xs">{t.date}</td>
                  <td className="px-4 py-2 truncate max-w-md">
                    <Link to={`/accounting/transactions?highlight=${t.id}`}
                          className="text-slate-900 hover:text-cyan-700 hover:underline">
                      {t.description || t.merchant}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-slate-500 text-xs">{t.category_account_name || "—"}</td>
                  <td className="px-4 py-2 text-center">
                    <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                      {t.cleared_source || "manual"}
                    </span>
                  </td>
                  <td className={`px-4 py-2 text-right font-mono-num tabular-nums ${
                    Number(t.amount) < 0 ? "text-red-700" : "text-emerald-700"
                  }`}>
                    {fmtMoney(t.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function StatBlock({ label, value, accent, muted }) {
  const color = accent === "emerald" ? "text-emerald-700"
              : accent === "red"     ? "text-red-700"
              : muted                ? "text-slate-500"
              : "text-slate-900";
  return (
    <div>
      <div className="text-[11px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className={`font-heading text-2xl font-bold font-mono-num tabular-nums ${color}`}>
        {fmtMoney(value)}
      </div>
    </div>
  );
}
