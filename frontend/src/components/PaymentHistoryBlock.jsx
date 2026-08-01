import { useEffect, useState } from "react";
import { fmtMoney, api } from "@/lib/api";
import { Plus } from "lucide-react";
import { PaymentModal } from "@/pages/Payments";

const METHOD_LABEL = {
  check: "Check",
  ach: "ACH Transfer",
  credit_card: "Credit card",
  wire: "Wire transfer",
  cash: "Cash",
  other: "Other",
};

/**
 * Wave-style Payment History + Doc Summary block. Renders inline on
 * the invoice/bill editor page whenever the doc has one or more
 * linked payments. Kind is either "invoice" or "bill" and controls
 * the copy ("Payment Received" vs "Payment Sent", section title, etc).
 *
 * When `docId` and `currentId` are passed, also renders a "+ Record
 * payment" button that opens the PaymentModal pre-locked to this doc.
 */
export default function PaymentHistoryBlock({ payments, original, kind = "invoice", docId, docLabel, contactId, currentId, onPaymentRecorded }) {
  const [openRecord, setOpenRecord] = useState(false);
  const [ctx, setCtx] = useState({ contacts: [], invoices: [], bills: [], transactions: [] });
  // Lazy-load the ancillary data the modal needs — only fires when the
  // pro actually clicks Record Payment, so the editor's initial load
  // stays fast when they're just reviewing history.
  useEffect(() => {
    if (!openRecord || !currentId) return;
    let cancelled = false;
    (async () => {
      try {
        const [c, i, b, t] = await Promise.all([
          api.get(`/companies/${currentId}/contacts`),
          api.get(`/companies/${currentId}/invoices`),
          api.get(`/companies/${currentId}/bills`),
          api.get(`/companies/${currentId}/transactions?limit=500`),
        ]);
        if (cancelled) return;
        setCtx({
          contacts: c.data.contacts || [],
          invoices: i.data.invoices || [],
          bills: b.data.bills || [],
          transactions: t.data.transactions || [],
        });
      } catch { /* modal will still function with empty lists */ }
    })();
    return () => { cancelled = true; };
  }, [openRecord, currentId]);
  const canRecord = !!(docId && currentId);
  return renderBlock({ payments, original, kind, docId, docLabel, contactId, currentId, openRecord, setOpenRecord, ctx, canRecord, onPaymentRecorded });
}

function renderBlock({ payments, original, kind, docId, docLabel, contactId, currentId, openRecord, setOpenRecord, ctx, canRecord, onPaymentRecorded }) {
  const hasPayments = payments && payments.length > 0;
  // Even when there are 0 payments we still render the header + record
  // button so pros can log the first payment. When payments==0 we
  // hide the tables + summary and just show a coaching row.
  const totalPaid = hasPayments ? payments.reduce((s, p) => s + Number(p.amount || 0), 0) : 0;
  const credits = 0;
  const remaining = Math.max(Number(original || 0) - totalPaid - credits, 0);
  const desc = kind === "invoice" ? "Payment Received" : "Payment Sent";
  const summaryLabel = kind === "invoice" ? "INVOICE SUMMARY" : "BILL SUMMARY";
  const originalLabel = kind === "invoice" ? "Original Invoice Amount" : "Original Bill Amount";
  const fullyPaid = remaining < 0.005;

  return (
    <div className="border-t bg-white" data-testid={`${kind}-editor-payment-history`}>
      <div className="px-6 py-3 border-b bg-slate-50 flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-slate-700">PAYMENT HISTORY</h3>
        {canRecord && (
          <button
            onClick={() => setOpenRecord(true)}
            className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:bg-indigo-50 px-2 py-1 rounded"
            data-testid={`${kind}-editor-record-payment`}
          ><Plus size={12} /> Record payment</button>
        )}
      </div>
      {hasPayments ? (
        <div className="px-6 py-3">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wide text-slate-500 border-b">
              <tr>
                <th className="text-left py-2 pr-4">Payment date</th>
                <th className="text-left py-2 pr-4">Description</th>
                <th className="text-left py-2 pr-4">Payment method</th>
                <th className="text-left py-2 pr-4">Reference / ID</th>
                <th className="text-right py-2">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {payments.map((p) => {
                const method = METHOD_LABEL[(p.method || "").toLowerCase()] || (p.method || "—");
                return (
                  <tr key={p.id}>
                    <td className="py-2 pr-4 text-slate-700 font-mono-num">{p.date}</td>
                    <td className="py-2 pr-4 text-slate-700">{desc}</td>
                    <td className="py-2 pr-4 text-slate-700">{method}</td>
                    <td className="py-2 pr-4 text-slate-500">{p.memo || p.reference || "—"}</td>
                    <td className="py-2 text-right font-mono-num text-slate-800">{fmtMoney(p.amount)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t">
                <td colSpan={3}></td>
                <td className="py-2 pr-4 text-right text-sm font-medium text-slate-700">Total Payments Received</td>
                <td className="py-2 text-right text-sm font-semibold font-mono-num text-slate-900">{fmtMoney(totalPaid)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <div className="px-6 py-4 text-center text-xs text-slate-400">
          No payments applied yet.
        </div>
      )}

      {hasPayments && (
        <>
          <div className="px-6 py-3 border-t bg-slate-50">
            <h3 className="text-xs font-semibold tracking-wide text-slate-700">{summaryLabel}</h3>
          </div>
          <div className="px-6 py-4">
            <div className="grid grid-cols-1 md:grid-cols-7 gap-3 items-stretch">
              <SummaryCell label={originalLabel} value={fmtMoney(original)} />
              <div className="hidden md:flex items-center justify-center text-slate-400 text-lg">−</div>
              <SummaryCell label="Total Payments Received" value={fmtMoney(totalPaid)} />
              <div className="hidden md:flex items-center justify-center text-slate-400 text-lg">−</div>
              <SummaryCell label="Credits Applied" value={fmtMoney(credits)} />
              <div className="hidden md:flex items-center justify-center text-slate-400 text-lg">=</div>
              <div className={`rounded-md p-3 text-center ${fullyPaid ? "bg-emerald-50" : "bg-emerald-50/60"}`}>
                <div className="text-[11px] uppercase tracking-wide font-semibold text-emerald-700">
                  {fullyPaid ? "Fully Paid" : "Remaining Balance Due"}
                </div>
                <div className={`mt-1 text-lg font-semibold font-mono-num ${fullyPaid ? "text-emerald-600" : "text-emerald-700"}`}
                     data-testid={`${kind}-editor-remaining`}>
                  {fmtMoney(remaining)}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {openRecord && canRecord && (
        <PaymentModal
          currentId={currentId}
          contacts={ctx.contacts}
          invoices={ctx.invoices}
          bills={ctx.bills}
          transactions={ctx.transactions}
          preset={{
            kind,
            linkedId: docId,
            contactId: contactId || "",
            docLabel: docLabel || "",
          }}
          onClose={() => {
            setOpenRecord(false);
            if (onPaymentRecorded) onPaymentRecorded();
          }}
        />
      )}
    </div>
  );
}

function SummaryCell({ label, value }) {
  return (
    <div className="rounded-md border p-3 text-center bg-white">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-base font-medium font-mono-num text-slate-800">{value}</div>
    </div>
  );
}
