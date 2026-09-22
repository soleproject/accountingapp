/**
 * NmiTransactionsBlock — per-invoice list of NMI gateway transactions
 * (card + ACH sales, refunds, voids) with in-line Refund / Void
 * actions. Wired to:
 *   GET  /api/companies/{cid}/nmi/transactions           (list all)
 *   POST /api/companies/{cid}/nmi/transactions/{id}/refund
 *   POST /api/companies/{cid}/nmi/transactions/{id}/void
 *
 * Only transactions whose `invoice_id === invoiceId` render — the
 * endpoint is company-scoped, we filter on the client because the
 * expected row count per invoice is tiny.
 */
import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { RefreshCw, RotateCcw, Ban, Loader2, ExternalLink } from "lucide-react";
import { api } from "@/lib/api";

const STATUS_STYLE = {
  approved:  "bg-emerald-50 text-emerald-700 border-emerald-200",
  settled:   "bg-emerald-50 text-emerald-700 border-emerald-200",
  refunded:  "bg-blue-50 text-blue-700 border-blue-200",
  voided:    "bg-slate-100 text-slate-600 border-slate-200",
  declined:  "bg-rose-50 text-rose-700 border-rose-200",
  failed:    "bg-rose-50 text-rose-700 border-rose-200",
  disputed:  "bg-amber-50 text-amber-800 border-amber-200",
};

function StatusPill({ status }) {
  const cls = STATUS_STYLE[status] || "bg-slate-100 text-slate-700 border-slate-200";
  return (
    <span className={`inline-block text-[10px] uppercase tracking-widest font-semibold px-1.5 py-0.5 rounded border ${cls}`}>
      {status}
    </span>
  );
}

function money(n) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(n || 0);
}

function RefundDialog({ txn, onClose, onDone }) {
  const [amount, setAmount] = useState(String(txn.amount || ""));
  const [busy, setBusy] = useState(false);
  const submit = async (fullRefund) => {
    setBusy(true);
    try {
      const body = fullRefund ? { amount: null } : { amount: parseFloat(amount) };
      await api.post(
        `/companies/${txn.company_id}/nmi/transactions/${txn.nmi_transaction_id}/refund`,
        body,
      );
      toast.success(fullRefund ? "Full refund submitted" : `Partial refund of ${money(body.amount)} submitted`);
      onDone?.();
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Refund failed");
    } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" data-testid="refund-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="p-4 border-b">
          <div className="text-[10px] uppercase tracking-widest font-semibold text-blue-700">Refund transaction</div>
          <div className="font-bold text-slate-900">{txn.nmi_transaction_id}</div>
          <div className="text-[12px] text-slate-500">Original: {money(txn.amount)}</div>
        </div>
        <div className="p-4 space-y-3">
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Refund amount ($)</div>
            <input
              type="number" step="0.01" min="0" max={txn.amount}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              data-testid="refund-amount"
            />
            <div className="text-[11px] text-slate-500 mt-1">
              Leave the full amount and click "Refund full" to fully refund and mark the transaction refunded.
            </div>
          </label>
        </div>
        <div className="p-4 border-t flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-700 hover:text-slate-900" data-testid="refund-cancel">Cancel</button>
          <button
            onClick={() => submit(false)}
            disabled={busy || !amount || parseFloat(amount) <= 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-blue-300 text-blue-700 bg-white hover:bg-blue-50 text-sm disabled:opacity-50"
            data-testid="refund-partial"
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            Refund {money(parseFloat(amount) || 0)}
          </button>
          <button
            onClick={() => submit(true)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm disabled:opacity-50"
            data-testid="refund-full"
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            Refund full
          </button>
        </div>
      </div>
    </div>
  );
}

export default function NmiTransactionsBlock({ companyId, invoiceId, onChange }) {
  const [rows, setRows] = useState(null);
  const [refundOn, setRefundOn] = useState(null);
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    if (!companyId || !invoiceId) return;
    try {
      const r = await api.get(`/companies/${companyId}/nmi/transactions`);
      setRows((r.data?.items || []).filter((t) => t.invoice_id === invoiceId));
    } catch {
      setRows([]);
    }
  }, [companyId, invoiceId]);
  useEffect(() => { load(); }, [load]);

  const voidTxn = async (txn) => {
    if (!window.confirm(`Void ${txn.nmi_transaction_id} for ${money(txn.amount)}? This only works before the transaction settles.`)) return;
    setBusyId(txn.nmi_transaction_id);
    try {
      await api.post(`/companies/${companyId}/nmi/transactions/${txn.nmi_transaction_id}/void`);
      toast.success("Transaction voided");
      await load();
      onChange?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Void failed — transaction may already be settled");
    } finally { setBusyId(""); }
  };

  if (rows === null) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex justify-center py-4"><Loader2 size={16} className="animate-spin text-slate-400" /></div>
      </div>
    );
  }
  if (rows.length === 0) return null;

  return (
    <>
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" data-testid="nmi-txns-block">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">Card &amp; ACH payments</div>
            <div className="text-[11px] text-slate-500">Direct from the payment gateway (NMI)</div>
          </div>
          <button
            onClick={load}
            className="text-slate-500 hover:text-slate-800 p-1"
            title="Refresh"
            data-testid="nmi-txns-refresh"
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <ul className="divide-y divide-slate-100 border border-slate-200 rounded-md overflow-hidden">
          {rows.map((t) => {
            const eligible = t.status === "approved" || t.status === "settled";
            const isRefundable = eligible;
            const isVoidable = t.status === "approved"; // pre-settle only
            return (
              <li key={t.nmi_transaction_id || t.id} className="flex items-center gap-3 px-3 py-2.5" data-testid={`nmi-txn-${t.nmi_transaction_id}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] text-slate-800">{t.nmi_transaction_id}</span>
                    <StatusPill status={t.status} />
                    {t.method && (
                      <span className="text-[10px] uppercase tracking-widest text-slate-400">{t.method}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    {money(t.amount)}
                    {t.auth_code && <> · auth {t.auth_code}</>}
                    {t.created_at && <> · {new Date(t.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</>}
                    {t.response_text && t.status !== "approved" && t.status !== "settled" && (
                      <> · {t.response_text}</>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {isRefundable && (
                    <button
                      onClick={() => setRefundOn(t)}
                      disabled={busyId === t.nmi_transaction_id}
                      className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded border border-blue-200 text-blue-700 bg-white hover:bg-blue-50 disabled:opacity-50"
                      data-testid={`nmi-txn-${t.nmi_transaction_id}-refund`}
                    >
                      <RotateCcw size={11} /> Refund
                    </button>
                  )}
                  {isVoidable && (
                    <button
                      onClick={() => voidTxn(t)}
                      disabled={busyId === t.nmi_transaction_id}
                      className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded border border-slate-300 text-slate-700 bg-white hover:bg-slate-100 disabled:opacity-50"
                      data-testid={`nmi-txn-${t.nmi_transaction_id}-void`}
                    >
                      {busyId === t.nmi_transaction_id ? <Loader2 size={11} className="animate-spin" /> : <Ban size={11} />}
                      Void
                    </button>
                  )}
                  <a
                    href={`https://secure.nmi.com/merchants/reports/report.php?tid=${encodeURIComponent(t.nmi_transaction_id)}`}
                    target="_blank" rel="noreferrer"
                    className="text-slate-400 hover:text-slate-700 p-1"
                    title="Open in NMI"
                    data-testid={`nmi-txn-${t.nmi_transaction_id}-open`}
                  >
                    <ExternalLink size={11} />
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {refundOn && (
        <RefundDialog
          txn={refundOn}
          onClose={() => setRefundOn(null)}
          onDone={() => { load(); onChange?.(); }}
        />
      )}
    </>
  );
}
