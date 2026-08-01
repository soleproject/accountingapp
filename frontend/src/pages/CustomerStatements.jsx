import { useEffect, useMemo, useState } from "react";
import { api, fmtMoney, fmtDate } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";
import {
  Send, Printer, Eye, ChevronDown, FileText, RefreshCw, ExternalLink,
} from "lucide-react";
import { Link } from "react-router-dom";

/**
 * Customer Statements — Wave-style page.
 *
 * Left: (nothing — sidebar handles nav)
 * Right, top: light toolbar with Customer + Type selectors and a
 *             Create statement / Refresh button.
 * Right, empty state: "Keep customers informed" illustration + copy.
 * Right, populated: More actions (Print, Preview) + Send statement,
 *                   followed by a print-ready statement preview card.
 */
export default function CustomerStatements() {
  const { currentId } = useCompany();
  const [contacts, setContacts] = useState([]);
  const [customerId, setCustomerId] = useState("");
  const [kind, setKind] = useState("outstanding"); // outstanding | activity
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/contacts`).then(r => {
      const customers = (r.data?.contacts || []).filter(c => c.type === "customer" || c.type === "both");
      setContacts(customers);
    });
  }, [currentId]);

  const load = async () => {
    if (!customerId) { toast.warning("Pick a customer first."); return; }
    setLoading(true);
    try {
      const r = await api.get(`/companies/${currentId}/customer-statements/preview`, {
        params: { customer_id: customerId, kind },
      });
      setPreview(r.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not build preview");
    } finally {
      setLoading(false);
    }
  };

  const send = async () => {
    if (!preview) return;
    setSending(true);
    try {
      const r = await api.post(`/companies/${currentId}/customers/${customerId}/send-statement`, null);
      if (r.data?.status === "sent") toast.success(`Statement sent to ${r.data.to}`);
      else if (r.data?.status === "opted_out") toast.warning("Customer has opted out of statement emails.");
      else toast.error("Send failed — check email deliverability.");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Send failed");
    } finally {
      setSending(false);
    }
  };

  const printPreview = () => {
    setMoreOpen(false);
    window.print();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Customer Statements</h1>
          <p className="text-slate-500 text-sm mt-1">Remind customers of outstanding invoices or share full account activity.</p>
        </div>
      </div>

      {/* Selector toolbar — matches Wave's grey card */}
      <div className="rounded-xl bg-slate-100 border border-slate-200 px-5 py-4 flex flex-wrap items-end gap-4" data-testid="cs-toolbar">
        <div className="flex-1 min-w-[220px]">
          <label className="block text-xs font-semibold text-slate-700 mb-1">Customer</label>
          <select
            value={customerId}
            onChange={(e) => { setCustomerId(e.target.value); setPreview(null); }}
            className="w-full px-3 py-2 rounded-md border border-slate-300 text-sm bg-white focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
            data-testid="cs-customer-select"
          >
            <option value="">Select a customer</option>
            {contacts.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div className="w-[220px]">
          <label className="block text-xs font-semibold text-slate-700 mb-1">Type</label>
          <select
            value={kind}
            onChange={(e) => { setKind(e.target.value); setPreview(null); }}
            className="w-full px-3 py-2 rounded-md border border-slate-300 text-sm bg-white focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
            data-testid="cs-type-select"
          >
            <option value="outstanding">Outstanding invoices</option>
            <option value="activity">Account activity</option>
          </select>
        </div>
        <button
          onClick={load}
          disabled={!customerId || loading}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          data-testid="cs-create-btn"
        >
          {loading ? (<><RefreshCw size={13} className="animate-spin" /> Loading…</>)
            : preview ? (<><RefreshCw size={13} /> Refresh</>)
            : (<>Create statement</>)}
        </button>
      </div>

      {/* Empty state / Preview */}
      {!preview ? (
        <EmptyState />
      ) : (
        <>
          <div className="flex items-center justify-center gap-3 relative print:hidden" data-testid="cs-action-bar">
            <div className="relative">
              <button
                onClick={() => setMoreOpen(v => !v)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-indigo-300 text-indigo-700 text-sm font-medium hover:bg-indigo-50"
                data-testid="cs-more-actions"
              >
                More actions <ChevronDown size={13} />
              </button>
              {moreOpen && (
                <div className="absolute left-0 top-full mt-1 w-48 bg-white border border-slate-200 rounded-md shadow-lg py-1 z-10" data-testid="cs-more-menu">
                  <button
                    onClick={printPreview}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 text-left"
                    data-testid="cs-action-print"
                  ><Printer size={13} /> Print</button>
                  <button
                    onClick={() => { setMoreOpen(false); window.open(`/customer-statements/preview?customer_id=${customerId}&kind=${kind}`, "_blank"); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 text-left"
                    data-testid="cs-action-preview"
                  ><Eye size={13} /> Preview as customer</button>
                </div>
              )}
            </div>
            <button
              onClick={send}
              disabled={sending}
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-full bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
              data-testid="cs-send-btn"
            >
              {sending ? (<><RefreshCw size={13} className="animate-spin" /> Sending…</>) : (<><Send size={13} /> Send statement</>)}
            </button>
          </div>

          <StatementPreview preview={preview} />
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center" data-testid="cs-empty-state">
      <div className="w-48 h-32 mb-4 rounded-lg bg-gradient-to-br from-indigo-100 via-white to-slate-100 border border-slate-200 flex items-center justify-center">
        <FileText size={48} className="text-indigo-400" strokeWidth={1.5} />
      </div>
      <h2 className="font-heading text-xl font-semibold text-slate-800">Keep customers informed</h2>
      <p className="text-sm text-slate-500 max-w-md mt-2">
        Remind your customers about outstanding invoices or send details of their account activity.
        Create a statement by selecting a customer and statement type from the form above.
      </p>
    </div>
  );
}

function StatementPreview({ preview }) {
  const { customer, company, summary, rows, kind, as_of } = preview;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm max-w-4xl mx-auto print:shadow-none print:border-0 print:p-0" data-testid="cs-preview">
      {/* Top strip */}
      <div className="border-t-4 border-slate-800 -mx-8 -mt-8 mb-8 print:hidden" />
      {/* Header — company left, statement type right */}
      <div className="flex items-start justify-between mb-10">
        <div className="flex items-start gap-3">
          {company.logo_data_url ? (
            <img src={company.logo_data_url} alt={company.name} className="h-10 w-10 rounded object-cover border border-slate-200" data-testid="cs-preview-logo" />
          ) : (
            <div className="h-10 w-10 rounded bg-indigo-100 text-indigo-700 flex items-center justify-center font-heading font-bold">
              {(company.name || "?").charAt(0)}
            </div>
          )}
          <div className="text-sm leading-tight">
            <div className="font-heading font-semibold text-slate-900">{company.name}</div>
            {company.address && <div className="text-slate-500 whitespace-pre-line text-xs mt-0.5">{company.address}</div>}
            {company.country && <div className="text-slate-500 text-xs">{company.country}</div>}
          </div>
        </div>
        <div className="text-right">
          <div className="font-heading text-2xl font-bold text-slate-900">Statement of Account</div>
          <div className="text-sm text-slate-500 mt-1">
            {kind === "outstanding" ? "Outstanding invoices" : "Account activity"}
          </div>
        </div>
      </div>

      {/* Bill to / As of */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">Bill to</div>
          <div className="font-heading font-semibold text-slate-900" data-testid="cs-preview-customer">{customer.name}</div>
          {customer.email && <div className="text-xs text-slate-500 font-mono-num">{customer.email}</div>}
          {customer.address && <div className="text-xs text-slate-500 whitespace-pre-line">{customer.address}</div>}
        </div>
        <div className="text-right">
          <div className="text-slate-900 font-heading font-semibold">United States dollar (USD)</div>
          <div className="text-xs text-slate-500 mt-0.5">As of <span className="font-mono-num">{fmtDate(as_of)}</span></div>
        </div>
      </div>

      {/* Summary block */}
      {kind === "outstanding" ? (
        <div className="mb-6" data-testid="cs-preview-summary">
          <div className="flex justify-between py-1.5 text-sm">
            <span className="text-slate-500">Overdue</span>
            <span className="font-mono-num text-slate-900">{fmtMoney(summary.overdue)}</span>
          </div>
          <div className="flex justify-between py-1.5 text-sm border-b border-slate-200">
            <span className="text-slate-500">Not yet due</span>
            <span className="font-mono-num text-slate-900">{fmtMoney(summary.not_yet_due)}</span>
          </div>
          <div className="flex justify-between py-3 mt-1 bg-slate-100 -mx-2 px-2 rounded" data-testid="cs-preview-outstanding">
            <span className="font-heading font-semibold text-slate-900">Outstanding balance (USD)</span>
            <span className="font-mono-num font-semibold text-slate-900">{fmtMoney(summary.outstanding)}</span>
          </div>
        </div>
      ) : (
        <div className="mb-6" data-testid="cs-preview-summary">
          <div className="flex justify-between py-1.5 text-sm">
            <span className="text-slate-500">Total invoiced</span>
            <span className="font-mono-num text-slate-900">{fmtMoney(summary.total_invoiced)}</span>
          </div>
          <div className="flex justify-between py-1.5 text-sm border-b border-slate-200">
            <span className="text-slate-500">Total paid</span>
            <span className="font-mono-num text-slate-900">{fmtMoney(summary.total_paid)}</span>
          </div>
          <div className="flex justify-between py-3 mt-1 bg-slate-100 -mx-2 px-2 rounded">
            <span className="font-heading font-semibold text-slate-900">Balance (USD)</span>
            <span className="font-mono-num font-semibold text-slate-900">{fmtMoney(summary.balance)}</span>
          </div>
        </div>
      )}

      {/* Row table */}
      {kind === "outstanding" ? (
        <table className="w-full text-sm" data-testid="cs-preview-rows">
          <thead className="text-slate-500">
            <tr className="border-b border-slate-200">
              <th className="text-left font-medium py-2">Invoice #</th>
              <th className="text-left font-medium py-2">Invoice date</th>
              <th className="text-left font-medium py-2">Due date</th>
              <th className="text-right font-medium py-2">Total</th>
              <th className="text-right font-medium py-2">Paid</th>
              <th className="text-right font-medium py-2">Due</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className="border-b border-slate-100">
                <td className="py-3">
                  <Link to={`/invoices/${r.id}/edit`} className="text-indigo-600 hover:underline inline-flex items-center gap-1" data-testid={`cs-row-inv-${r.number}`}>
                    {r.number} <ExternalLink size={11} />
                  </Link>
                </td>
                <td className="py-3 font-mono-num text-slate-700">{fmtDate(r.invoice_date)}</td>
                <td className="py-3 font-mono-num">
                  <div className="text-slate-700">{fmtDate(r.due_date)}</div>
                  {r.is_overdue && <div className="text-xs text-red-600 font-semibold uppercase">Overdue</div>}
                </td>
                <td className="py-3 text-right font-mono-num text-slate-700">{fmtMoney(r.total)}</td>
                <td className="py-3 text-right font-mono-num text-slate-700">{fmtMoney(r.paid)}</td>
                <td className="py-3 text-right font-mono-num text-slate-900 font-semibold">{fmtMoney(r.due)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="text-center py-6 text-slate-400 italic">No outstanding invoices.</td></tr>
            )}
          </tbody>
        </table>
      ) : (
        <table className="w-full text-sm" data-testid="cs-preview-rows">
          <thead className="text-slate-500">
            <tr className="border-b border-slate-200">
              <th className="text-left font-medium py-2">Date</th>
              <th className="text-left font-medium py-2">Activity</th>
              <th className="text-right font-medium py-2">Invoiced</th>
              <th className="text-right font-medium py-2">Payment</th>
              <th className="text-right font-medium py-2">Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e, idx) => (
              <tr key={idx} className="border-b border-slate-100">
                <td className="py-3 font-mono-num text-slate-700">{fmtDate(e.date)}</td>
                <td className="py-3 text-slate-700">
                  {e.invoice_id ? (
                    <Link to={`/invoices/${e.invoice_id}/edit`} className="text-indigo-600 hover:underline">{e.description}</Link>
                  ) : e.description}
                </td>
                <td className="py-3 text-right font-mono-num text-slate-700">{e.debit ? fmtMoney(e.debit) : ""}</td>
                <td className="py-3 text-right font-mono-num text-emerald-700">{e.credit ? fmtMoney(e.credit) : ""}</td>
                <td className="py-3 text-right font-mono-num text-slate-900 font-semibold">{fmtMoney(e.balance)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={5} className="text-center py-6 text-slate-400 italic">No activity to display.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {/* Footer outstanding balance echo */}
      {kind === "outstanding" && (
        <div className="mt-3 flex justify-between py-3 bg-slate-100 -mx-2 px-2 rounded">
          <span className="font-heading font-semibold text-slate-900">Outstanding balance (USD)</span>
          <span className="font-mono-num font-semibold text-slate-900">{fmtMoney(summary.outstanding)}</span>
        </div>
      )}
    </div>
  );
}
