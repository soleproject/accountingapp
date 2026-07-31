import { useEffect, useState } from "react";
import { api, fmtMoney, fmtDate } from "@/lib/api";
import { toast } from "sonner";
import { X, Loader2, ExternalLink, Users, Truck, Eye, Mail, Send } from "lucide-react";

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
  // PDF preview state — { url, title }
  const [preview, setPreview] = useState(null);
  const [statementOpen, setStatementOpen] = useState(false);

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

  const openPdf = async (doc) => {
    const path = isVendor ? "bills" : "invoices";
    try {
      const r = await api.get(`/companies/${currentId}/${path}/${doc.id}/pdf`, { responseType: "blob" });
      const url = URL.createObjectURL(new Blob([r.data], { type: "application/pdf" }));
      setPreview({ url, title: `${isVendor ? "Bill" : "Invoice"} ${doc.number || ""}` });
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not load PDF");
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex justify-end" data-testid="contact-detail-modal">
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
          <div className="flex items-center gap-2">
            {!isVendor && (
              <button
                onClick={() => setStatementOpen(true)}
                data-testid="contact-detail-send-statement"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-600 text-white text-xs hover:bg-emerald-700"
                title="Email an outstanding-invoice statement to this customer"
              ><Mail size={12} /> Send statement</button>
            )}
            <button onClick={onClose} data-testid="contact-detail-close"><X size={18} /></button>
          </div>
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
                      <th></th>
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
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => openPdf(d)}
                            data-testid={`contact-detail-pdf-${d.id}`}
                            title="Preview PDF"
                            className="p-1 rounded hover:bg-indigo-100 text-indigo-600"
                          ><Eye size={13} /></button>
                        </td>
                      </tr>
                    ))}
                    {!docs.length && (
                      <tr><td colSpan={7} className="text-center py-6 text-xs text-slate-400">Nothing in this period.</td></tr>
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
      {preview && (
        <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4" data-testid="doc-preview-modal">
          <div className="bg-white rounded-xl w-full max-w-4xl h-[85vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <div className="font-heading font-semibold text-sm">{preview.title}</div>
              <div className="flex items-center gap-2">
                <a href={preview.url} download className="text-xs text-slate-500 hover:text-slate-800 hover:underline">Download</a>
                <button
                  onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }}
                  data-testid="doc-preview-close"
                ><X size={16} /></button>
              </div>
            </div>
            <iframe title={preview.title} src={preview.url} className="flex-1 w-full" data-testid="doc-preview-iframe" />
          </div>
        </div>
      )}
      {statementOpen && !isVendor && (
        <StatementModal
          currentId={currentId}
          customerId={row.customer_id}
          defaultEmail=""
          start={start}
          end={end}
          onClose={() => setStatementOpen(false)}
        />
      )}
    </div>
  );
}

function StatementModal({ currentId, customerId, defaultEmail, start, end, onClose }) {
  const [to, setTo] = useState(defaultEmail || "");
  const [busy, setBusy] = useState(false);
  const [prefill, setPrefill] = useState(null);
  // Look up the customer's email on mount so we can pre-fill.
  useEffect(() => {
    (async () => {
      try {
        const r = await api.get(`/companies/${currentId}/contacts`);
        const c = (r.data.contacts || []).find(x => x.id === customerId);
        if (c) { setTo(c.email || ""); setPrefill(c); }
      } catch (e) { /* non-fatal */ }
    })();
  }, [currentId, customerId]);
  const send = async () => {
    if (!to || !to.includes("@")) { toast.error("Please enter a valid email address."); return; }
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/customers/${customerId}/send-statement`,
        null, { params: { start, end, to } });
      if (r.data?.status === "sent") {
        toast.success(`Statement sent to ${to} · ${r.data.invoice_count} invoice(s)`);
      } else if (r.data?.status === "skipped_pref_off") {
        toast.warning("Statement not sent — recipient has opted out of statements.");
      } else {
        toast.warning(`Send returned status: ${r.data?.status || "unknown"}`);
      }
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not send statement");
    } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4" data-testid="statement-modal">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold inline-flex items-center gap-2"><Send size={16} /> Send customer statement</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        <p className="text-xs text-slate-500">
          Emails an outstanding-invoice statement to {prefill?.name || "the customer"} for {start} → {end}.
        </p>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Send to</label>
          <input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="name@company.com"
            className="w-full border rounded px-2 py-1.5 text-sm"
            data-testid="statement-email"
          />
          {!prefill?.email && (
            <p className="text-[10px] text-amber-700 mt-1">No email on file for this customer — we'll use whatever you enter here.</p>
          )}
        </div>
        <button
          onClick={send}
          disabled={busy || !to}
          className="w-full py-2 rounded-md bg-emerald-600 text-white text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
          data-testid="statement-send"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          Send statement
        </button>
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
