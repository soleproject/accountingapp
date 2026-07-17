import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { ChevronLeft, Loader2 } from "lucide-react";

/**
 * Statement import detail — shows the extracted transactions from one
 * bank-statement upload. Every row is already promoted to `transactions`
 * (auto-promote flow), so this view is read-only + green "promoted →" pills.
 */
export default function StatementImportDetail() {
  const { importId } = useParams();
  const { currentId } = useCompany();
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!currentId || !importId) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const r = await api.get(`/companies/${currentId}/statements/imports/${importId}`);
        if (!cancelled) setDoc(r.data);
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.detail || e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentId, importId]);

  if (loading) {
    return (
      <div className="p-8 text-slate-500 flex items-center gap-2">
        <Loader2 className="animate-spin" size={16} />Loading import…
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-8 text-red-700 bg-red-50 border border-red-200 rounded-lg">
        {error}
      </div>
    );
  }
  if (!doc) return null;

  const total = (doc.transactions || [])
    .reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);
  const veryfi = doc.veryfi_raw || {};

  return (
    <div className="space-y-4" data-testid="stmt-detail-page">
      <Link
        to={`/connections`}
        className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
      >
        <ChevronLeft size={14} />Imports
      </Link>

      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">
            {doc.filename}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {(doc.transactions || []).length} transactions
            {total > 0 && (<> · total ${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>)}
          </p>
        </div>
        <span className={"inline-flex items-center gap-1 text-xs px-3 py-1 rounded-full " +
          (doc.status === "completed"
            ? "bg-emerald-100 text-emerald-800"
            : doc.status === "failed"
              ? "bg-red-100 text-red-800"
              : "bg-amber-100 text-amber-800")}>
          {doc.status}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <MetaCard label="METHOD" value={`${doc.method || "—"} · bank_statement`} />
        <MetaCard label="ACCOUNT" value={
          doc.account_code && doc.account_name
            ? `${doc.account_code} · ${doc.account_name}`
            : (doc.account_name || "—")
        } />
        <MetaCard label="PERIOD" value={
          doc.period_start && doc.period_end
            ? `${doc.period_start} → ${doc.period_end}`
            : "—"
        } />
        <MetaCard label="UPLOADED" value={
          doc.created_at ? new Date(doc.created_at).toLocaleString() : "—"
        } />
      </div>

      {veryfi && (veryfi.bank_name || veryfi.account_holder_name || veryfi.starting_balance != null) && (
        <div className="rounded-xl border bg-white p-5 space-y-3">
          <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold">
            Bank statement details
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-xs text-slate-500 mb-1">INSTITUTION</div>
              <div className="font-medium">{veryfi.bank_name || "—"}</div>
              {veryfi.bank_address && <div className="text-xs text-slate-500 mt-1">{veryfi.bank_address}</div>}
            </div>
            <div>
              <div className="text-xs text-slate-500 mb-1">ACCOUNT HOLDER</div>
              <div className="font-medium">{veryfi.account_holder_name || "—"}</div>
              {veryfi.account_holder_address && (
                <div className="text-xs text-slate-500 mt-1">{veryfi.account_holder_address}</div>
              )}
              {(veryfi.account_number || doc.last4) && (
                <div className="text-xs text-slate-500 mt-1 font-mono-num">
                  Account: {veryfi.account_number || `···${doc.last4}`}
                </div>
              )}
            </div>
            <div>
              <div className="text-xs text-slate-500 mb-1">BALANCES</div>
              {veryfi.starting_balance != null && (
                <Row label="Beginning" amount={veryfi.starting_balance} />
              )}
              {veryfi.ending_balance != null && (
                <Row label="Ending" amount={veryfi.ending_balance} />
              )}
              {veryfi.starting_balance != null && veryfi.ending_balance != null && (
                <Row label="Net change"
                     amount={Number(veryfi.ending_balance) - Number(veryfi.starting_balance)}
                     colored />
              )}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-white overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b bg-slate-50">
          <div>
            <div className="font-medium text-sm">Extracted transactions</div>
            <div className="text-xs text-slate-500">All rows have been auto-promoted to the ledger.</div>
          </div>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left border-b">
            <tr className="text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2 font-medium">Date</th>
              <th className="px-4 py-2 font-medium">Description</th>
              <th className="px-4 py-2 font-medium">Category</th>
              <th className="px-4 py-2 font-medium text-right">Amount</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {(doc.transactions || []).length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                No transactions extracted.
              </td></tr>
            )}
            {(doc.transactions || []).map(t => (
              <tr key={t.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2 tabular-nums text-slate-700 whitespace-nowrap">{t.date}</td>
                <td className="px-4 py-2 text-slate-700 max-w-[440px]">
                  <div className="truncate" title={t.description}>{t.description}</div>
                  {t.contact_name && (
                    <div className="text-xs text-slate-500 truncate">↳ {t.contact_name}</div>
                  )}
                </td>
                <td className="px-4 py-2 text-slate-600 text-xs">
                  {t.category_account_code && t.category_account_name
                    ? `${t.category_account_code} · ${t.category_account_name}`
                    : "—"}
                </td>
                <td className={"px-4 py-2 text-right tabular-nums font-mono-num " +
                  (Number(t.amount) >= 0 ? "text-emerald-700" : "text-slate-800")}>
                  ${Math.abs(Number(t.amount) || 0).toLocaleString(undefined,
                    { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-2">
                  {t.posted ? (
                    <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                      promoted →
                    </span>
                  ) : t.needs_review ? (
                    <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                      needs review
                    </span>
                  ) : (
                    <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">
                      pending
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MetaCard({ label, value }) {
  return (
    <div className="rounded-xl border bg-white p-4">
      <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">{label}</div>
      <div className="text-sm text-slate-900 font-medium break-words">{value}</div>
    </div>
  );
}

function Row({ label, amount, colored = false }) {
  const n = Number(amount) || 0;
  const color = colored
    ? (n >= 0 ? "text-emerald-700" : "text-red-700")
    : "text-slate-800";
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="text-slate-600">{label}</span>
      <span className={`font-mono-num ${color}`}>
        {n < 0 ? "-" : ""}${Math.abs(n).toLocaleString(undefined,
          { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    </div>
  );
}
