import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, fmtMoney, fmtDate } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X, AlertTriangle, Pencil, Repeat, Check, Package, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useCreateListener, useActionListener } from "@/lib/createBus";
import MonthCloseBreadcrumb from "@/components/MonthCloseBreadcrumb";
import MemorizeModal from "@/components/MemorizeModal";
import ItemPicker from "@/components/ItemPicker";

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
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [itemsCatalog, setItemsCatalog] = useState([]);
  const [aging, setAging] = useState(null);
  const [creating, setCreating] = useState(false);
  const [creatingPrefill, setCreatingPrefill] = useState(null);
  const [editing, setEditing] = useState(null);
  const [memorizing, setMemorizing] = useState(null);
  // Inline-edit state for invoice numbers on list rows.
  const [numEditId, setNumEditId] = useState(null);
  const [numEditVal, setNumEditVal] = useState("");
  const commitNumberEdit = async (inv) => {
    const val = (numEditVal || "").trim();
    if (!val || val === inv.number) { setNumEditId(null); return; }
    try {
      const r = await api.patch(`/companies/${currentId}/invoices/${inv.id}`, { number: val });
      if (r.data?.number_conflict) {
        toast.warning(`Heads up — another invoice already uses ${val}.`);
      } else {
        toast.success("Invoice number updated");
      }
      setNumEditId(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Update failed");
    }
  };
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
    const [i, c, a, it] = await Promise.all([
      api.get(`/companies/${currentId}/invoices`),
      api.get(`/companies/${currentId}/contacts`),
      api.get(`/companies/${currentId}/reports/ar-aging`),
      api.get(`/companies/${currentId}/items?usage=sales`),
    ]);
    setItems(i.data.invoices || []); setContacts(c.data.contacts || []); setAging(a.data);
    setItemsCatalog(it.data.items || []);
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
        <button data-testid={TID.addBtn} onClick={() => navigate("/invoices/new")}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
          <Plus size={13} /> New Invoice
        </button>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <Link to="/recurring" data-testid="recurring-link" className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100">
          <Repeat size={12} /> Recurring invoices
        </Link>
      </div>

      {aging && aging.total > 0 && (
        <ArAgingCard aging={aging} navigate={navigate} />
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
                <td className="px-3 py-2 font-mono-num text-slate-600">
                  {numEditId === inv.id ? (
                    <span className="inline-flex items-center gap-1">
                      <input
                        autoFocus
                        value={numEditVal}
                        onChange={(e) => setNumEditVal(e.target.value)}
                        onBlur={() => commitNumberEdit(inv)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitNumberEdit(inv);
                          if (e.key === "Escape") setNumEditId(null);
                        }}
                        className="w-28 border rounded px-1.5 py-0.5 text-xs font-mono-num"
                        data-testid={`invoice-number-input-${inv.id}`}
                      />
                      <Check size={12} className="text-emerald-600" />
                    </span>
                  ) : (
                    <button
                      onClick={() => { setNumEditId(inv.id); setNumEditVal(inv.number || ""); }}
                      className="text-slate-700 hover:text-indigo-600 hover:underline decoration-dotted"
                      title="Click to edit"
                      data-testid={`invoice-number-${inv.id}`}
                    >{inv.number}</button>
                  )}
                </td>
                <td className="px-3 py-2">{inv.contact_name}</td>
                <td className="px-3 py-2 font-mono-num text-slate-500">{fmtDate(inv.issue_date)}</td>
                <td className="px-3 py-2 font-mono-num text-slate-500">{fmtDate(inv.due_date)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(inv.total)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(inv.balance_due)}</td>
                <td className="px-3 py-2"><span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100">{inv.status}</span></td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button data-testid={`invoice-memorize-btn-${inv.id}`} onClick={() => setMemorizing(inv)}
                            title="Memorize (recurring)"
                            className="p-1 rounded hover:bg-fuchsia-100 text-fuchsia-600"><Repeat size={13} /></button>
                    <button data-testid="invoice-edit-btn" onClick={() => navigate(`/invoices/${inv.id}/edit`)}
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
      {creating && <InvoiceModal contacts={contacts} itemsCatalog={itemsCatalog} currentId={currentId} prefill={creatingPrefill}
                                  onClose={() => { setCreating(false); setCreatingPrefill(null); load(); }} />}
      {editing && <InvoiceModal contacts={contacts} itemsCatalog={itemsCatalog} currentId={currentId} invoice={editing} onClose={() => { setEditing(null); load(); }} />}
      {memorizing && <MemorizeModal currentId={currentId} source={memorizing} kind="invoice" onClose={() => setMemorizing(null)} />}
    </div>
  );
}

function InvoiceModal({ contacts, itemsCatalog, currentId, invoice, prefill, onClose }) {
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
  const [number, setNumber] = useState(invoice?.number || "");
  const [mode, setMode] = useState("edit"); // "edit" | "preview"
  const [pdfBlobUrl, setPdfBlobUrl] = useState(null);
  useEffect(() => {
    if (mode !== "preview" || !editMode || !invoice?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(`/companies/${currentId}/invoices/${invoice.id}/pdf`, { responseType: "blob" });
        if (cancelled) return;
        setPdfBlobUrl(URL.createObjectURL(new Blob([r.data], { type: "application/pdf" })));
      } catch (e) { toast.error("Could not load preview"); }
    })();
    return () => { cancelled = true; if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, invoice?.id, invoice?.updated_at]);
  const upd = (i, patch) => setLines(lines.map((x, j) => j === i ? { ...x, ...patch, amount: (patch.quantity !== undefined ? patch.quantity : x.quantity) * (patch.rate !== undefined ? patch.rate : x.rate) } : x));
  const total = lines.reduce((s, l) => s + Number(l.amount || 0), 0) + Number(tax);
  const save = async () => {
    const c = contacts.find(x => x.id === contact);
    const body = {
      contact_id: contact || null, contact_name: c?.name || invoice?.contact_name || "",
      issue_date: issue, due_date: due, line_items: lines, tax: Number(tax), status,
    };
    if (number && number !== invoice?.number) body.number = number.trim();
    if (editMode) {
      const r = await api.patch(`/companies/${currentId}/invoices/${invoice.id}`, body);
      if (r.data?.number_conflict) {
        toast.warning(`Heads up — another invoice already uses ${body.number}.`);
      } else {
        toast.success("Invoice updated");
      }
    } else {
      if (number) body.number = number.trim();
      await api.post(`/companies/${currentId}/invoices`, body);
      toast.success("Invoice created");
    }
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[92vh] overflow-auto p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h3 className="font-heading font-semibold">{editMode ? `Edit Invoice ${invoice.number}` : "New Invoice"}</h3>
            {editMode && (
              <div className="inline-flex rounded-md border bg-slate-50 p-0.5 text-xs" data-testid="invoice-view-toggle">
                <button
                  type="button"
                  onClick={() => setMode("edit")}
                  data-testid="invoice-mode-edit"
                  className={`px-2.5 py-1 rounded ${mode === "edit" ? "bg-slate-900 text-white" : "text-slate-600"}`}
                >Edit</button>
                <button
                  type="button"
                  onClick={() => setMode("preview")}
                  data-testid="invoice-mode-preview"
                  className={`px-2.5 py-1 rounded ${mode === "preview" ? "bg-emerald-600 text-white" : "text-slate-600"}`}
                >Preview</button>
              </div>
            )}
          </div>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        {mode === "preview" ? (
          pdfBlobUrl ? (
            <iframe title="Invoice preview" src={pdfBlobUrl} className="w-full h-[70vh] border rounded" data-testid="invoice-preview-iframe" />
          ) : (
            <div className="h-[60vh] flex items-center justify-center text-slate-400 text-sm">Loading preview…</div>
          )
        ) : (<>
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
        <div>
          <label htmlFor={`inv-num-${invoice?.id || "new"}`}
                 className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">
            Invoice number
          </label>
          <input
            id={`inv-num-${invoice?.id || "new"}`}
            key={`inv-num-${invoice?.id || "new"}`}
            type="text"
            autoComplete="off"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="e.g. INV-1001 (leave blank to auto-assign)"
            className="w-full border rounded px-2 py-1.5 text-sm font-mono-num focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
            data-testid="invoice-modal-number"
          />
        </div>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <div className="col-span-5">
                <ItemPicker
                  items={itemsCatalog}
                  value={l.description}
                  onChangeText={(txt) => upd(i, { description: txt })}
                  onPickItem={(it) => upd(i, {
                    item_id: it.id,
                    item_name: it.name,
                    description: it.description || it.name,
                    rate: Number(it.price || 0),
                    income_account_id: it.income_account_id || null,
                    income_account_name: it.income_account_name || "",
                    category: it.income_account_name || "",
                  })}
                  testId={`invoice-line-${i}`}
                />
              </div>
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
        </>)}
      </div>
    </div>
  );
}


/**
 * A/R Aging card with a top-of-card toggle between:
 *   • "A/R Aging"   — canonical 5-bucket view (Current / 1-30 / 31-60 / 61-90 / 90+)
 *   • "Highlights"  — two glanceable cards (Overdue + Due within 30 days)
 *                     plus a big AI Follow-up call-to-action.
 *
 * Bucket vocabulary:
 *   overdue           = 1_30 + 31_60 + 61_90 + over_90
 *   due within 30 days = the "current" bucket (not yet due, Net 30 default)
 */
function ArAgingCard({ aging, navigate }) {
  const [view, setView] = useState("aging"); // "aging" | "highlights"
  const overdue = ["1_30", "31_60", "61_90", "over_90"]
    .reduce((s, k) => s + (aging.buckets[k] || 0), 0);
  const dueSoon = aging.buckets.current || 0;
  const atRisk = (aging.buckets["61_90"] || 0) + (aging.buckets["over_90"] || 0);

  return (
    <div data-testid="ar-aging-widget" className="rounded-xl border bg-white p-5">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
        <div>
          <div className="font-heading font-semibold">
            {view === "aging" ? "A/R Aging" : "Highlights"}
          </div>
          <div className="text-xs text-slate-500">
            As of {aging.as_of} · <span className="font-mono-num font-semibold text-slate-800">{fmtMoney(aging.total)}</span> outstanding
          </div>
        </div>
        <div className="flex items-center gap-3">
          {atRisk > 0 && view === "aging" && (
            <div className="text-xs px-2 py-1 rounded-md bg-red-50 border border-red-200 text-red-700 flex items-center gap-1">
              <AlertTriangle size={12} />
              {fmtMoney(atRisk)} at collection risk
            </div>
          )}
          {/* Toggle */}
          <div className="inline-flex rounded-md border overflow-hidden text-xs bg-slate-50" data-testid="ar-aging-toggle">
            <button
              onClick={() => setView("aging")}
              className={`px-3 py-1.5 ${view === "aging" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-white"}`}
              data-testid="ar-aging-toggle-aging"
            >A/R Aging</button>
            <button
              onClick={() => setView("highlights")}
              className={`px-3 py-1.5 ${view === "highlights" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-white"}`}
              data-testid="ar-aging-toggle-highlights"
            >Highlights</button>
          </div>
        </div>
      </div>

      {view === "aging" ? (
        <>
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
        </>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="ar-highlights">
          <div className="rounded-lg border-2 border-red-200 bg-red-50 p-4">
            <div className="text-[11px] uppercase tracking-wider font-semibold text-red-700">Overdue</div>
            <div className="font-mono-num text-2xl font-bold mt-1 text-red-700" data-testid="ar-highlights-overdue">
              {fmtMoney(overdue)}
            </div>
            <div className="text-xs text-red-600/80 mt-1">Past-due invoices need attention.</div>
          </div>
          <div className="rounded-lg border-2 border-amber-200 bg-amber-50 p-4">
            <div className="text-[11px] uppercase tracking-wider font-semibold text-amber-700">Due within 30 days</div>
            <div className="font-mono-num text-2xl font-bold mt-1 text-amber-700" data-testid="ar-highlights-due-soon">
              {fmtMoney(dueSoon)}
            </div>
            <div className="text-xs text-amber-700/80 mt-1">Not yet late — send a friendly nudge.</div>
          </div>
          <button
            type="button"
            onClick={() => {
              toast.info("AI Follow-up coming soon — will draft personalised chase emails for every overdue invoice.");
            }}
            className="rounded-lg border-2 border-indigo-400 bg-gradient-to-br from-indigo-600 to-indigo-700 p-4 text-white text-left shadow-md hover:shadow-lg hover:from-indigo-500 hover:to-indigo-600 transition"
            data-testid="ar-highlights-ai-followup"
          >
            <div className="text-[11px] uppercase tracking-wider font-semibold text-indigo-100 inline-flex items-center gap-1.5">
              <Sparkles size={12} /> AI Follow-up
            </div>
            <div className="text-lg font-bold mt-1">
              {overdue > 0 ? `Draft ${overdue > 1 ? "chase emails" : "chase email"}` : "Prep next-run nudges"}
            </div>
            <div className="text-xs text-indigo-100/90 mt-1">
              One-tap AI-drafted follow-ups for every overdue customer.
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

