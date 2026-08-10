import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";
import {
  CheckCircle2, Unlink, Link2, RefreshCw, ArrowRight,
} from "lucide-react";

/**
 * Bank Match Review — Advanced-mode-only page where CPAs audit every
 * silent-matched pair produced by `bank_match.auto_match_bank_feed`.
 *
 * The silent matcher pairs a Plaid bank-feed row with an editor-
 * authored transaction (Purchase / SalesReceipt / Deposit / CreditMemo
 * / RefundReceipt) when they represent the same money movement. This
 * screen shows those pairs side-by-side so the CPA can either
 * confirm (locks it in) or unlink (breaks the pair AND tombstones
 * both rows so a re-sync won't re-pair them).
 *
 * Route: `/accounting/bank-matches` (guarded by AdvancedModeRoute).
 */
export default function BankMatchReview() {
  const { currentId: cid } = useCompany();
  const nav = useNavigate();
  const [status, setStatus] = useState("unconfirmed"); // unconfirmed | confirmed | all
  const [pairs, setPairs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    if (!cid) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${cid}/bank-matches`,
                                { params: { status } });
      setPairs(r.data.pairs || []);
    } catch (e) {
      toast.error("Failed to load matches");
    } finally { setLoading(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [cid, status]);

  const confirm = async (bankId) => {
    if (busyId) return;
    setBusyId(bankId);
    try {
      await api.post(`/companies/${cid}/bank-matches/${bankId}/confirm`);
      toast.success("Match confirmed");
      // Optimistic: strip from unconfirmed view.
      if (status === "unconfirmed") {
        setPairs((prev) => prev.filter((p) => p.bank.id !== bankId));
      } else {
        load();
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to confirm");
    } finally { setBusyId(null); }
  };

  const unlink = async (bankId) => {
    if (busyId) return;
    if (!window.confirm(
      "Unlink this pair? The editor row will reappear in the ledger "
       + "and the silent matcher won't re-pair these two rows.")) return;
    setBusyId(bankId);
    try {
      await api.post(`/companies/${cid}/bank-matches/${bankId}/unlink`);
      toast.success("Pair unlinked");
      setPairs((prev) => prev.filter((p) => p.bank.id !== bankId));
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to unlink");
    } finally { setBusyId(null); }
  };

  const totals = useMemo(() => {
    const abs = (v) => Math.abs(Number(v || 0));
    return {
      count: pairs.length,
      sum: pairs.reduce((s, p) => s + abs(p.bank?.amount), 0),
    };
  }, [pairs]);

  const routeForEditor = (t) => ({
    Purchase: "/purchases",
    SalesReceipt: "/sales-receipts",
    Deposit: "/deposits",
    CreditMemo: "/credit-memos",
    RefundReceipt: "/refund-receipts",
  }[t] || "/accounting/transactions");

  return (
    <div className="space-y-6" data-testid="bank-match-review-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-slate-900 tracking-tight">
            Bank Match Review
          </h1>
          <p className="text-slate-500 mt-1 text-sm max-w-2xl">
            Silent matches between bank-feed transactions and rows
            you (or your team) authored via the editors. Confirm to
            lock in a pair, or unlink if the two rows are unrelated —
            the silent matcher won't re-pair anything you've unlinked.
          </p>
        </div>
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-slate-200 rounded-md bg-white hover:bg-slate-50"
          data-testid="bank-match-refresh-btn"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {/* Status filter chips */}
      <div className="flex items-center gap-2 flex-wrap">
        {[
          { k: "unconfirmed", label: "Awaiting review" },
          { k: "confirmed",   label: "Confirmed" },
          { k: "all",         label: "All" },
        ].map(({ k, label }) => {
          const active = status === k;
          return (
            <button
              key={k}
              onClick={() => setStatus(k)}
              className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                active
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
              data-testid={`bank-match-filter-${k}`}
            >
              {label}
            </button>
          );
        })}
        <div className="text-xs text-slate-500 tabular-nums ml-auto">
          <span className="font-medium text-slate-700">{totals.count}</span> pairs
          {" · "}
          <span className="font-medium text-slate-700">{fmtMoney(totals.sum)}</span> total
        </div>
      </div>

      {loading ? (
        <div className="border border-slate-200 rounded-lg bg-white p-8 text-center text-sm text-slate-400">
          Loading matches…
        </div>
      ) : pairs.length === 0 ? (
        <EmptyState status={status} />
      ) : (
        <div className="space-y-3">
          {pairs.map((p) => (
            <PairRow
              key={p.bank.id}
              pair={p}
              busy={busyId === p.bank.id}
              onConfirm={() => confirm(p.bank.id)}
              onUnlink={() => unlink(p.bank.id)}
              onOpenEditor={() => nav(
                `${routeForEditor(p.editor?.txn_type)}/${p.editor?.id}/edit`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}


function EmptyState({ status }) {
  const copy = {
    unconfirmed: "No matches awaiting review — the silent matcher hasn't paired any new rows since your last confirm.",
    confirmed:   "No confirmed matches yet. Confirm a pair from the Awaiting review tab and it'll show up here.",
    all:         "No silent matches exist for this company yet. The matcher pairs bank-feed rows with editor-authored transactions after every Plaid sync.",
  }[status];
  return (
    <div
      className="border border-dashed border-slate-300 rounded-lg bg-slate-50 p-10 text-center"
      data-testid="bank-match-empty"
    >
      <CheckCircle2 size={28} className="mx-auto text-emerald-500" />
      <p className="mt-3 text-sm text-slate-600 max-w-md mx-auto">{copy}</p>
    </div>
  );
}


function PairRow({ pair, busy, onConfirm, onUnlink, onOpenEditor }) {
  const b = pair.bank || {};
  const e = pair.editor || {};
  const confirmed = pair.confirmed;
  return (
    <div
      className={`border rounded-lg bg-white overflow-hidden ${
        confirmed ? "border-emerald-200" : "border-slate-200"
      }`}
      data-testid={`bank-match-row-${b.id}`}
    >
      {/* Header strip */}
      <div className={`flex items-center justify-between px-4 py-2 border-b text-xs ${
        confirmed ? "bg-emerald-50 border-emerald-100"
                   : "bg-slate-50 border-slate-100"
      }`}>
        <div className="flex items-center gap-2 text-slate-600">
          <Link2 size={12} className={confirmed ? "text-emerald-600" : "text-slate-400"} />
          {confirmed ? (
            <span className="font-medium text-emerald-700">Confirmed match</span>
          ) : (
            <span className="font-medium text-slate-700">Awaiting review</span>
          )}
          {pair.matched_at && (
            <span className="text-slate-400">
              · matched {new Date(pair.matched_at).toLocaleString(undefined, {
                  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {!confirmed && (
            <button
              onClick={onConfirm}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              data-testid={`bank-match-confirm-${b.id}`}
            >
              <CheckCircle2 size={12} /> Confirm
            </button>
          )}
          <button
            onClick={onUnlink}
            disabled={busy}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-rose-200 bg-white text-rose-700 hover:bg-rose-50 disabled:opacity-50"
            data-testid={`bank-match-unlink-${b.id}`}
          >
            <Unlink size={12} /> Unlink
          </button>
        </div>
      </div>

      {/* Side-by-side comparison */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr,auto,1fr] items-stretch">
        <Side
          label="Bank feed"
          badgeClass="bg-sky-100 text-sky-800"
          row={b}
          data-testid={`bank-match-bank-${b.id}`}
        />
        <div className="flex md:flex-col items-center justify-center px-2 py-3 md:py-0 bg-slate-50 border-t md:border-t-0 md:border-l md:border-r border-slate-100">
          <ArrowRight size={16} className="text-slate-400 md:rotate-90" />
        </div>
        <Side
          label={editorLabel(e.txn_type)}
          badgeClass="bg-amber-100 text-amber-800"
          row={e}
          onOpen={onOpenEditor}
          data-testid={`bank-match-editor-${b.id}`}
        />
      </div>
    </div>
  );
}


function Side({ label, badgeClass, row, onOpen }) {
  const amt = Number(row?.amount || 0);
  const isOut = amt < 0;
  return (
    <div className="px-4 py-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${badgeClass}`}>
          {label}
        </span>
        {onOpen && (
          <button
            onClick={onOpen}
            className="text-[11px] text-slate-500 hover:text-slate-900 underline underline-offset-2"
          >
            Open →
          </button>
        )}
      </div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-slate-700 truncate">
          {row?.description || row?.merchant || "—"}
        </span>
        <span className={`text-sm font-semibold tabular-nums ${
          isOut ? "text-rose-600" : "text-emerald-700"
        }`}>
          {isOut ? "-" : ""}{fmtMoney(Math.abs(amt))}
        </span>
      </div>
      <div className="text-[11px] text-slate-500 flex items-center gap-2 flex-wrap">
        <span>{row?.date || "—"}</span>
        {row?.contact_name && <span>· {row.contact_name}</span>}
        {row?.number && <span>· #{row.number}</span>}
        {row?.category_account_name && (
          <span>· {row.category_account_name}</span>
        )}
      </div>
    </div>
  );
}


function editorLabel(t) {
  return {
    Purchase: "Expense",
    SalesReceipt: "Sales Receipt",
    Deposit: "Deposit",
    CreditMemo: "Credit Memo",
    RefundReceipt: "Refund Receipt",
  }[t] || (t || "Editor row");
}
