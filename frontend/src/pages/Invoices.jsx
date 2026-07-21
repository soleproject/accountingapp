import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, fmtMoney, fmtDate } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X, AlertTriangle, Pencil } from "lucide-react";
import { toast } from "sonner";
import { useCreateListener, useActionListener } from "@/lib/createBus";
import MonthCloseBreadcrumb from "@/components/MonthCloseBreadcrumb";

const BUCKETS = [
  { key: "current", label: "Current", desc: "Not yet due", color: "emerald" },
  { key: "1_30", label: "1–30 days", desc: "Past due", color: "amber" },
  { key: "31_60", label: "31–60 days", desc: "Late", color: "orange" },
  { key: "61_90", label: "61–90 days", desc: "Very late", color: "red" },
  { key: "over_90", label: "90+ days", desc: "Critical", color: "rose" },
];

const BAR = {
  emerald: "bg-emerald-500", amber: "bg-amber-500", orange: "bg-orange-500",
  red: "bg-red-500", rose: "bg-rose-600",
};
const TEXT = {
  emerald: "text-emerald-700", amber: "text-amber-700", orange: "text-orange-700",
  red: "text-red-700", rose: "text-rose-700",
};
const BG = {
  emerald: "bg-emerald-50 border-emerald-100", amber: "bg-amber-50 border-amber-100",
  orange: "bg-orange-50 border-orange-100", red: "bg-red-50 border-red-100",
  rose: "bg-rose-50 border-rose-100",
};

export default function Invoices() {
  const { currentId } = useCompany();
  const [items, setItems] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [aging, setAging] = useState(null);
  const [creating, setCreating] = useState(false);
  const [creatingPrefill, setCreatingPrefill] = useState(null);
  const [editing, setEditing] = useState(null);
  // Deep-link filters from Month Close: /invoices?outstanding=1&as_of=YYYY-MM-DD
  // Filtering is client-side against the already-loaded /invoices response
  // — matches the backend `_outstanding_count` semantics exactly
  // (issue_date <= as_of AND balance_due > 0).
  const [params, setParams] = useSearchParams();
  const outstanding = params.get("outstanding") === "1";
  const asOf = params.get("as_of") || "";
  const filtered = useMemo(() => {
    if (!outstanding && !asOf) return items;
    return items.filter(inv => {
      if (outstanding && !(Number(inv.balance_due) > 0.005)) return false;
      if (asOf) {
        const d = inv.issue_date || inv.date || "";
        if (d && d > asOf) return false;
      }
      return true;
    });
  }, [items, outstanding, asOf]);
  const clearFilters = () => {
    const p = new URLSearchParams(params);
    p.delete("outstanding"); p.delete("as_of");
    setParams(p, { replace: true });
  };
  const load = async () => {
    if (!currentId) return;
    const [i, c, a] = await Promise.all([
      api.get(`/companies/${currentId}/invoices`),
      api.get(`/companies/${currentId}/contacts`),
      api.get(`/companies/${currentId}/reports/ar-aging`),
    ]);
    setItems(i.data.invoices || []); setContacts(c.data.contacts || []); setAging(a.data);
  };
  useEffect(() => { load(); }, [currentId]);

  // Voice-driven modal opener — see /lib/createBus.js.
  useCreateListener("invoice", (prefill) => {
    setCreatingPrefill(prefill || {});
    setCreating(true);
  });
  useActionListener("close-current-modal", () => {
    setCreating(false);
    setCreatingPrefill(null);
    setEditing(null);
    load();
  });
  const del = async (id) => {
    if (!confirm("Delete?")) return;
    await api.delete(`/companies/${currentId}/invoices/${id}`);
    load();
  };
  return (
    <div className="space-y-4">
      <MonthCloseBreadcrumb />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Invoices</h1>
          <p className="text-slate-500 text-sm mt-1">Money in · sent to customers.</p>
        </div>
        <button data-testid={TID.addBtn} onClick={() => setCreating(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
          <Plus size={13} /> New Invoice
        </button>
      </div>

      {aging && aging.total > 0 && (
        <div data-testid="ar-aging-widget" className="rounded-xl border bg-white p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="font-heading font-semibold">A/R Aging</div>
              <div className="text-xs text-slate-500">
                Outstanding receivables as of {aging.as_of} · <span className="font-mono-num font-semibold text-slate-800">{fmtMoney(aging.total)}</span> total
              </div>
            </div>
            {(aging.buckets["61_90"] + aging.buckets["over_90"]) > 0 && (
              <div className="text-xs px-2 py-1 rounded-md bg-red-50 border border-red-200 text-red-700 flex items-center gap-1">
                <AlertTriangle size={12} />
                {fmtMoney(aging.buckets["61_90"] + aging.buckets["over_90"])} at collection risk
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {BUCKETS.map(b => {
              const amt = aging.buckets[b.key] || 0;
              const pct = aging.total ? (amt / aging.total) * 100 : 0;
              return (
                <div key={b.key} className={`rounded-lg border p-3 ${BG[b.color]}`}>
                  <div className={`text-[10px] uppercase tracking-wider font-semibold ${TEXT[b.color]}`}>{b.label}</div>
                  <div className={`font-mono-num text-lg font-semibold mt-0.5 ${TEXT[b.color]}`}>{fmtMoney(amt)}</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">{b.desc}</div>
                  <div className="mt-2 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                    <div className={`h-full ${BAR[b.color]} transition-all`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className={`text-[10px] mt-1 ${TEXT[b.color]}`}>{pct.toFixed(0)}% of A/R</div>
                </div>
              );
            })}
          </div>

          {/* Stacked visual bar */}
          <div className="mt-4">
            <div className="flex h-2.5 rounded-full overflow-hidden bg-slate-100">
              {BUCKETS.map(b => {
                const amt = aging.buckets[b.key] || 0;
                const pct = aging.total ? (amt / aging.total) * 100 : 0;
                if (pct === 0) return null;
                return (
                  <div key={b.key} className={BAR[b.color]} style={{ width: `${pct}%` }} title={`${b.label}: ${fmtMoney(amt)}`} />
                );
              })}
            </div>
          </div>
        </div>
      )}
      <div className="rounded-xl border bg-white overflow-hidden">
        {(outstanding || asOf) && (
          <div
            className="flex items-center justify-between px-3 py-2 bg-cyan-50 border-b border-cyan-100 text-xs text-cyan-900"
            data-testid="invoices-filter-chip"
          >
            <span>
              Showing{" "}
              {outstanding && <b>outstanding</b>}
              {outstanding && asOf && " "}
              {asOf && <>as of <b className="font-mono-num">{asOf}</b></>}
              {" "}·{" "}
              <span className="font-mono-num">{filtered.length}</span> of {items.length}
            </span>
            <button
              onClick={clearFilters}
              className="inline-flex items-center gap-1 text-cyan-700 hover:underline"
              data-testid="invoices-clear-filters"
            >
              <X size={12} /> Clear filters
            </button>
          </div>
        )}
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr>
              <th className="px-3 py-2 text-left">Number</th>
              <th className="px-3 py-2 text-left">Customer</th>
              <th className="px-3 py-2 text-left">Issued</th>
              <th className="px-3 py-2 text-left">Due</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-right">Balance</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(inv => (
              <tr key={inv.id} className="border-b hover:bg-slate-50">
                <td className="px-3 py-2 font-mono-num text-slate-600">{inv.number}</td>
                <td className="px-3 py-2">{inv.contact_name}</td>
                <td className="px-3 py-2 font-mono-num text-slate-500">{fmtDate(inv.issue_date)}</td>
                <td className="px-3 py-2 font-mono-num text-slate-500">{fmtDate(inv.due_date)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(inv.total)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(inv.balance_due)}</td>
                <td className="px-3 py-2"><span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100">{inv.status}</span></td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button data-testid="invoice-edit-btn" onClick={() => setEditing(inv)}
                            className="p-1 rounded hover:bg-indigo-100 text-indigo-600"><Pencil size={13} /></button>
                    <button onClick={() => del(inv.id)} className="p-1 rounded hover:bg-red-100 text-red-500"><Trash2 size={13} /></button>
                  </div>
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={8} className="text-center py-8 text-slate-500">
                  {(outstanding || asOf)
                    ? `No matching invoices${items.length ? ` (${items.length} total, none met the filter)` : ""}.`
                    : "No invoices."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {creating && <InvoiceModal contacts={contacts} currentId={currentId} prefill={creatingPrefill}
                                  onClose={() => { setCreating(false); setCreatingPrefill(null); load(); }} />}
      {editing && <InvoiceModal contacts={contacts} currentId={currentId} invoice={editing} onClose={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function InvoiceModal({ contacts, currentId, invoice, prefill, onClose }) {
  const editMode = !!invoice;
  const p = prefill || {};
  const initLines = () => {
    if (invoice?.line_items?.length) return invoice.line_items.map(l => ({ ...l }));
    if (p.amount || p.description) {
      const amt = Number(p.amount || 0);
      return [{
        description: p.description || "Services",
        quantity: 1,
        rate: amt,
        amount: amt,
      }];
    }
    return [{ description: "", quantity: 1, rate: 0, amount: 0 }];
  };
  const [contact, setContact] = useState(invoice?.contact_id || p.contact_id || "");
  // Race guard: prefill.contact_id may arrive before the parent's contacts
  // list finishes loading (voice-command flow). Re-apply if it starts
  // matching a real option once contacts populate.
  useEffect(() => {
    if (!contact && p.contact_id && contacts.some(c => c.id === p.contact_id)) {
      setContact(p.contact_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts, p.contact_id]);
  const [issue, setIssue] = useState(invoice?.issue_date || p.issue_date || new Date().toISOString().slice(0, 10));
  const [due, setDue] = useState(
    invoice?.due_date
    || p.due_date
    || new Date(Date.now() + (Number(p.due_days) || 30) * 86400000).toISOString().slice(0, 10)
  );
  const [lines, setLines] = useState(initLines);
  const [tax, setTax] = useState(invoice?.tax || Number(p.tax || 0));
  const [status, setStatus] = useState(invoice?.status || p.status || "sent");
  const upd = (i, patch) => setLines(lines.map((x, j) => j === i ? { ...x, ...patch, amount: (patch.quantity !== undefined ? patch.quantity : x.quantity) * (patch.rate !== undefined ? patch.rate : x.rate) } : x));
  const total = lines.reduce((s, l) => s + Number(l.amount || 0), 0) + Number(tax);
  const save = async () => {
    const c = contacts.find(x => x.id === contact);
    const body = {
      contact_id: contact || null, contact_name: c?.name || invoice?.contact_name || "",
      issue_date: issue, due_date: due, line_items: lines, tax: Number(tax), status,
    };
    if (editMode) {
      await api.patch(`/companies/${currentId}/invoices/${invoice.id}`, body);
      toast.success("Invoice updated");
    } else {
      await api.post(`/companies/${currentId}/invoices`, body);
      toast.success("Invoice created");
    }
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold">{editMode ? `Edit Invoice ${invoice.number}` : "New Invoice"}</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <select value={contact} onChange={(e) => setContact(e.target.value)} className="border rounded px-2 py-1.5 text-sm">
            <option value="">Customer…</option>
            {contacts.filter(c => c.type === "customer" || c.type === "both").map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input type="date" value={issue} onChange={(e) => setIssue(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="border rounded px-2 py-1.5 text-sm">
            <option value="draft">Draft</option><option value="sent">Sent</option>
            <option value="partial">Partial</option><option value="paid">Paid</option>
          </select>
        </div>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <input placeholder="Description" value={l.description} onChange={(e) => upd(i, { description: e.target.value })} className="col-span-5 border rounded px-2 py-1.5 text-sm" />
              <input type="number" value={l.quantity} onChange={(e) => upd(i, { quantity: Number(e.target.value) })} className="col-span-2 border rounded px-2 py-1.5 text-sm font-mono-num" />
              <input type="number" value={l.rate} onChange={(e) => upd(i, { rate: Number(e.target.value) })} className="col-span-2 border rounded px-2 py-1.5 text-sm font-mono-num" />
              <div className="col-span-2 py-1.5 text-right font-mono-num">{fmtMoney(l.amount)}</div>
              <button onClick={() => setLines(lines.filter((_, j) => j !== i))} className="col-span-1 text-red-500"><Trash2 size={13} /></button>
            </div>
          ))}
          <button onClick={() => setLines([...lines, { description: "", quantity: 1, rate: 0, amount: 0 }])}
                  className="text-xs text-slate-600 border border-dashed rounded px-2 py-1">+ Line</button>
        </div>
        <div className="flex justify-end gap-4 items-center border-t pt-3">
          <div className="text-sm">Tax: <input type="number" value={tax} onChange={(e) => setTax(e.target.value)} className="w-24 border rounded px-2 py-1 text-sm font-mono-num" /></div>
          <div className="text-lg font-mono-num font-semibold">Total: {fmtMoney(total)}</div>
          <button data-testid={TID.saveBtn} onClick={save} className="px-4 py-2 rounded-md bg-slate-900 text-white text-sm">
            {editMode ? "Save changes" : "Save Invoice"}
          </button>
        </div>
      </div>
    </div>
  );
}
