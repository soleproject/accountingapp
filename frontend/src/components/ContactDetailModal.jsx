import { useEffect, useState } from "react";
import { api, fmtMoney, fmtDate } from "@/lib/api";
import { X, Loader2, ExternalLink, Users, Truck } from "lucide-react";

/**
 * Drill-down for one vendor or one customer. Shows every bill/invoice
 * in the period plus every transaction the pros already linked back
 * to those docs. Rendered as a right-side slide-over so the parent
 * report stays visible for context.
 */
export default function ContactDetailModal({ currentId, kind, row, start, end, onClose }) {
  const isVendor = kind === "vendor";
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const nameKey = isVendor ? "vendor" : "customer";
  const label = isVendor ? row.vendor_name : row.customer_name;
  const idParam = isVendor ? row.vendor_id : row.customer_id;

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const params = { start, end };
        if (idParam) params[`${nameKey}_id`] = idParam;
        else params[`${nameKey}_name`] = label;
        const r = await api.get(`/companies/${currentId}/reports/${nameKey}-detail`, { params });
        setData(r.data);
      } finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const docs = isVendor ? (data?.bills || []) : (data?.invoices || []);
  const txns = data?.linked_transactions || [];
  const totals = data?.totals || {};

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex justify-end" data-testid="contact-detail-modal">
      <div className="bg-white w-full max-w-2xl h-full overflow-auto shadow-2xl">
        <div className="px-5 py-4 border-b flex items-center justify-between sticky top-0 bg-white z-10">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500 inline-flex items-center gap-1">
              {isVendor ? <Truck size={12} /> : <Users size={12} />}
              {isVendor ? "Vendor detail" : "Customer detail"}
            </div>
            <h3 className="font-heading font-semibold text-lg" data-testid="contact-detail-name">{label}</h3>
            <div className="text-[11px] text-slate-500">{start} → {end}</div>
          </div>
          <button onClick={onClose} data-testid="contact-detail-close"><X size={18} /></button>
        </div>

        {loading ? (
          <div className="p-12 text-center text-slate-400"><Loader2 className="inline animate-spin" size={20} /></div>
        ) : (
          <div className="p-5 space-y-6">
            <div className="grid grid-cols-4 gap-3">
              <Stat label={isVendor ? "Total spend" : "Total revenue"} value={fmtMoney(totals.amount || 0)} tone="slate" />
              <Stat label="Paid" value={fmtMoney(totals.paid || 0)} tone="emerald" />
              <Stat label="Outstanding" value={fmtMoney(totals.outstanding || 0)} tone={totals.outstanding > 0 ? "rose" : "slate"} />
              <Stat label={isVendor ? "Bills" : "Invoices"} value={String(isVendor ? totals.bill_count || 0 : totals.invoice_count || 0)} tone="slate" />
            </div>

            <section>
              <h4 className="text-xs uppercase tracking-wide text-slate-500 mb-2">
                {isVendor ? "Bills" : "Invoices"} <span className="font-mono-num text-slate-400">({docs.length})</span>
              </h4>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
                    <tr>
                      <th className="px-3 py-2 text-left">Number</th>
                      <th className="px-3 py-2 text-left">Issued</th>
                      <th className="px-3 py-2 text-left">Due</th>
                      <th className="px-3 py-2 text-left">Status</th>
                      <th className="px-3 py-2 text-right">Total</th>
                      <th className="px-3 py-2 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {docs.map(d => (
                      <tr key={d.id} className="border-b hover:bg-slate-50" data-testid={`contact-detail-doc-${d.id}`}>
                        <td className="px-3 py-2 font-mono-num text-slate-700">
                          <a href={isVendor ? `/bills` : `/invoices`} className="hover:underline inline-flex items-center gap-1">
                            {d.number} <ExternalLink size={10} className="text-slate-400" />
                          </a>
                        </td>
                        <td className="px-3 py-2 text-slate-500 font-mono-num">{fmtDate(d.issue_date)}</td>
                        <td className="px-3 py-2 text-slate-500 font-mono-num">{fmtDate(d.due_date)}</td>
                        <td className="px-3 py-2">
                          <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100">{d.status}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono-num font-semibold">{fmtMoney(d.total)}</td>
                        <td className={`px-3 py-2 text-right font-mono-num ${d.balance_due > 0 ? "text-rose-700" : "text-slate-400"}`}>{fmtMoney(d.balance_due)}</td>
                      </tr>
                    ))}
                    {!docs.length && (
                      <tr><td colSpan={6} className="text-center py-6 text-xs text-slate-400">Nothing in this period.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h4 className="text-xs uppercase tracking-wide text-slate-500 mb-2">
                Linked transactions <span className="font-mono-num text-slate-400">({txns.length})</span>
              </h4>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
                    <tr>
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-left">Description</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {txns.map(t => (
                      <tr key={t.id} className="border-b hover:bg-slate-50" data-testid={`contact-detail-txn-${t.id}`}>
                        <td className="px-3 py-2 text-slate-500 font-mono-num">{fmtDate(t.date)}</td>
                        <td className="px-3 py-2 text-slate-700 truncate">{t.description || t.merchant || <span className="text-slate-400">—</span>}</td>
                        <td className={`px-3 py-2 text-right font-mono-num ${t.amount < 0 ? "text-rose-700" : "text-emerald-700"}`}>{fmtMoney(t.amount)}</td>
                      </tr>
                    ))}
                    {!txns.length && (
                      <tr><td colSpan={3} className="text-center py-6 text-xs text-slate-400">No transactions linked back yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone = "slate" }) {
  const tones = {
    slate:   "border-slate-200 text-slate-800",
    emerald: "border-emerald-200 text-emerald-700",
    rose:    "border-rose-200 text-rose-700",
  };
  return (
    <div className={`rounded-lg border p-3 ${tones[tone]}`}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="font-heading font-semibold text-lg font-mono-num mt-1">{value}</div>
    </div>
  );
}
