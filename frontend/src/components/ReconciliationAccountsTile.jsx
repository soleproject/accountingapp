/**
 * ReconciliationAccountsTile
 *
 * Inline expandable content for the "Reconciling accounts" row on the
 * Responsibilities panel. Mirrors the pattern used by ReorderAlertsTile
 * for Monitoring Inventory.
 *
 * Lists every reconcilable account (bank / savings / credit card / loan)
 * on the given company and, per account, shows:
 *   • whether a reconciliation covering this month has been *attempted*
 *   • whether the account is currently *balanced* (|diff| < $0.02)
 *   • deep-link to open the reconciliation session for that account
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useMoneyFmt } from "@/lib/company";
import { toast } from "sonner";
import {
  CheckCircle2, AlertTriangle, Circle, Loader2, RefreshCw, ArrowRight,
} from "lucide-react";

const STATUS_STYLES = {
  reconciled:   { icon: CheckCircle2,   tone: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200", label: "Reconciled" },
  qbo_covered:  { icon: CheckCircle2,   tone: "text-indigo-700",  bg: "bg-indigo-50 border-indigo-200",   label: "QBO Verified" },
  variance:     { icon: AlertTriangle,  tone: "text-amber-700",   bg: "bg-amber-50 border-amber-200",     label: "Variance" },
  not_started:  { icon: Circle,         tone: "text-slate-500",   bg: "bg-slate-50 border-slate-200",     label: "Not started" },
};

export default function ReconciliationAccountsTile({ companyId, period, returnPath, returnLabel }) {
  const fmtMoney = useMoneyFmt();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const buildHref = (base) => {
    if (!base) return "#";
    if (!returnPath) return base;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}return_to=${encodeURIComponent(returnPath)}&return_label=${encodeURIComponent(returnLabel || "")}`;
  };

  const load = useCallback(async () => {
    if (!companyId) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${companyId}/responsibilities/reconciliation-detail`, {
        params: { period },
      });
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load account status.");
    } finally {
      setBusy(false);
    }
  }, [companyId, period]);

  useEffect(() => { load(); }, [load]);

  const accounts = data?.accounts || [];
  const reconPeriod = data?.recon_period || period;
  const reconLabel = data?.recon_period_label;
  const summary = useMemo(() => {
    const total = accounts.length;
    const reconciled = accounts.filter(a =>
      a.status === "reconciled" || a.status === "qbo_covered"
    ).length;
    const variance = accounts.filter(a => a.status === "variance").length;
    const notStarted = accounts.filter(a => a.status === "not_started").length;
    return { total, reconciled, variance, notStarted };
  }, [accounts]);

  if (busy && !data) {
    return (
      <div
        className="rounded-lg border bg-white p-4 flex items-center justify-center text-slate-400"
        data-testid="recon-accounts-tile-loading"
      >
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }

  if (!accounts.length) {
    return (
      <div
        className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-500"
        data-testid="recon-accounts-tile-empty"
      >
        No bank / credit card / loan accounts have been added yet.
        <div className="mt-2">
          <Link
            to={buildHref("/accounting/chart-of-accounts")}
            className="text-xs text-cyan-700 hover:underline inline-flex items-center gap-1"
          >
            Add an account <ArrowRight size={11} />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-white overflow-hidden" data-testid="recon-accounts-tile">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-slate-50 text-[11px]">
        <div className="text-slate-600">
          {reconLabel && <b className="text-slate-900 mr-1">{reconLabel}:</b>}
          <b>{summary.reconciled}</b> reconciled · <b>{summary.variance}</b> variance · <b>{summary.notStarted}</b> not started
          <span className="text-slate-400"> · {summary.total} account{summary.total === 1 ? "" : "s"}</span>
        </div>
        <button
          onClick={load}
          disabled={busy}
          className="text-slate-500 hover:text-slate-900 inline-flex items-center gap-1 disabled:opacity-40"
          data-testid="recon-accounts-tile-refresh"
        >
          <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>
      <ul className="divide-y">
        {accounts.map(a => {
          const style = STATUS_STYLES[a.status] || STATUS_STYLES.not_started;
          const Icon = style.icon;
          const kindLabel =
            a.detail_type === "credit_card" ? "Credit card" :
            a.detail_type === "loan_and_line_of_credit" ? "Loan / LOC" :
            a.detail_type === "cash_and_bank" ? "Bank" :
            a.type === "liability" ? "Liability" : "Asset";
          // Deep-link: open reconciliation page, filtered to this account
          // via the month deep-link so the pro sees this period preloaded.
          const openHref = a.reconciliation_id
            ? buildHref(`/accounting/reconciliation/${a.reconciliation_id}`)
            : buildHref(`/accounting/reconciliation?month=${reconPeriod}`);
          return (
            <li
              key={a.id}
              className="px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm hover:bg-slate-50"
              data-testid={`recon-accounts-tile-row-${a.id}`}
            >
              <Icon size={14} className={`shrink-0 ${style.tone}`} />
              <div className="min-w-0 flex-1 basis-[160px]">
                <div className="truncate font-medium text-slate-900">
                  {a.code ? <span className="text-slate-400 font-mono-num mr-1.5">{a.code}</span> : null}
                  {a.name}
                </div>
                <div className="text-[11px] text-slate-500 flex items-center gap-x-2 flex-wrap">
                  <span>{kindLabel}</span>
                  <span className="text-slate-300">·</span>
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${style.bg} ${style.tone}`}
                    data-testid={`recon-accounts-tile-status-${a.id}`}
                  >
                    {style.label}
                  </span>
                  {a.attempted && a.diff !== null && a.status !== "qbo_covered" && (
                    <>
                      <span className="text-slate-300">·</span>
                      <span
                        className={`font-mono-num ${Math.abs(a.diff) < 0.02 ? "text-emerald-700" : "text-red-700"}`}
                        title="Statement − ledger (current session)"
                      >
                        diff {fmtMoney(a.diff)}
                      </span>
                    </>
                  )}
                  {!a.attempted && (
                    <>
                      <span className="text-slate-300 hidden sm:inline">·</span>
                      <span className="italic text-slate-500 basis-full sm:basis-auto">
                        no reconciliation attempted for this month
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[10px] uppercase tracking-widest text-slate-400">Ledger</div>
                <div className="font-mono-num tabular-nums text-sm">{fmtMoney(a.ledger_balance || 0)}</div>
              </div>
              <Link
                to={openHref}
                className="text-[11px] px-2 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 inline-flex items-center gap-1 shrink-0"
                data-testid={`recon-accounts-tile-open-${a.id}`}
              >
                {a.attempted ? "View" : "Reconcile"} <ArrowRight size={11} />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
