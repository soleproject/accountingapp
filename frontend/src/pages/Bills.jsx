import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, fmtMoney, fmtDate } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X, AlertTriangle, Pencil, Repeat, Check } from "lucide-react";
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
const BAR = { emerald: "bg-emerald-500", amber: "bg-amber-500", orange: "bg-orange-500", red: "bg-red-500", rose: "bg-rose-600" };
const TEXT = { emerald: "text-emerald-700", amber: "text-amber-700", orange: "text-orange-700", red: "text-red-700", rose: "text-rose-700" };
const BG = { emerald: "bg-emerald-50 border-emerald-100", amber: "bg-amber-50 border-amber-100", orange: "bg-orange-50 border-orange-100", red: "bg-red-50 border-red-100", rose: "bg-rose-50 border-rose-100" };

export default function Bills() {
  const { currentId } = useCompany();
  const [items, setItems] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [itemsCatalog, setItemsCatalog] = useState([]);
  const [aging, setAging] = useState(null);
  const [creating, setCreating] = useState(false);
  const [creatingPrefill, setCreatingPrefill] = useState(null);
  const [editing, setEditing] = useState(null);
  const [memorizing, setMemorizing] = useState(null);
  const [numEditId, setNumEditId] = useState(null);
  const [numEditVal, setNumEditVal] = useState("");
  const commitNumberEdit = async (bill) => {
    const val = (numEditVal || "").trim();
    if (!val || val === bill.number) { setNumEditId(null); return; }
    try {
      const r = await api.patch(`/companies/${currentId}/bills/${bill.id}`, { number: val });
      if (r.data?.number_conflict) {
        toast.warning(`Heads up — another bill already uses ${val}.`);
      } else {
        toast.success("Bill number updated");
      }
      setNumEditId(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Update failed");
    }
  };
  // Deep-link filters from Month Close: /bills?outstanding=1&as_of=YYYY-MM-DD
  const [params, setParams] = useSearchParams();
  const outstanding = params.get("outstanding") === "1";
  const asOf = params.get("as_of") || "";
  const filtered = useMemo(() => {
    if (!outstanding && !asOf) return items;
    return items.filter(b => {
      if (outstanding && !(Number(b.balance_due) > 0.005)) return false;
      if (asOf) {
        const d = b.issue_date || b.date || "";
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
    const [b, c, a, it] = await Promise.all([
      api.get(`/companies/${currentId}/bills`),
      api.get(`/companies/${currentId}/contacts`),
      api.get(`/companies/${currentId}/reports/ap-aging`),
      api.get(`/companies/${currentId}/items?usage=purchases`),
    ]);
    setItems(b.data.bills || []); setContacts(c.data.contacts || []); setAging(a.data);
    setItemsCatalog(it.data.items || []);
  };
  useEffect(() => { load(); }, [currentId]);
  useCreateListener("bill", (prefill) => {
    setCreatingPrefill(prefill || {});
    setCreating(true);
  });
  useActionListener("close-current-modal", () => {
    setCreating(false);
    setCreatingPrefill(null);
    setEditing(null);
    load();
  });
  const del = async (id) => { if (confirm("Delete?")) { await api.delete(`/companies/${currentId}/bills/${id}`); load(); } };

  return (
    <div className="space-y-4">
      <MonthCloseBreadcrumb />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Bills</h1>
          <p className="text-slate-500 text-sm mt-1">Money out · vendor bills to be paid.</p>
        </div>
        <button data-testid={TID.addBtn} onClick={() => setCreating(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
          <Plus size={13} /> New Bill
        </button>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <Link to="/recurring" data-testid="recurring-link" className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100">
          <Repeat size={12} /> Recurring bills
        </Link>
      </div>

      {aging && aging.total > 0 && (
        <div data-testid="ap-aging-widget" className="rounded-xl border bg-white p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="font-heading font-semibold">A/P Aging</div>
              <div className="text-xs text-slate-500">
                Outstanding payables as of {aging.as_of} · <span className="font-mono-num font-semibold text-slate-800">{fmtMoney(aging.total)}</span> total
              </div>
            </div>
            {(aging.buckets["61_90"] + aging.buckets["over_90"]) > 0 && (
              <div className="text-xs px-2 py-1 rounded-md bg-red-50 border border-red-200 text-red-700 flex items-center gap-1">
                <AlertTriangle size={12} />
                {fmtMoney(aging.buckets["61_90"] + aging.buckets["over_90"])} severely late
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
                  <div className={`text-[10px] mt-1 ${TEXT[b.color]}`}>{pct.toFixed(0)}% of A/P</div>
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
                return <div key={b.key} className={BAR[b.color]} style={{ width: `${pct}%` }} title={`${b.label}: ${fmtMoney(amt)}`} />;
              })}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-white overflow-hidden">
        {(outstanding || asOf) && (
          <div
            className="flex items-center justify-between px-3 py-2 bg-cyan-50 border-b border-cyan-100 text-xs text-cyan-900"
            data-testid="bills-filter-chip"
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
              data-testid="bills-clear-filters"
            >
              <X size={12} /> Clear filters
            </button>
          </div>
        )}
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr><th className="px-3 py-2 text-left">Number</th><th className="px-3 py-2 text-left">Vendor</th>
              <th className="px-3 py-2 text-left">Issued</th><th className="px-3 py-2 text-left">Due</th>
              <th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2 text-right">Balance</th>
              <th className="px-3 py-2">Status</th><th></th></tr>
          </thead>
          <tbody>
            {filtered.map(b => (
              <tr key={b.id} className="border-b hover:bg-slate-50">
                <td className="px-3 py-2 font-mono-num text-slate-600">
                  {numEditId === b.id ? (
                    <span className="inline-flex items-center gap-1">
                      <input
                        autoFocus
                        value={numEditVal}
                        onChange={(e) => setNumEditVal(e.target.value)}
                        onBlur={() => commitNumberEdit(b)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitNumberEdit(b);
                          if (e.key === "Escape") setNumEditId(null);
                        }}
                        className="w-28 border rounded px-1.5 py-0.5 text-xs font-mono-num"
                        data-testid={`bill-number-input-${b.id}`}
                      />
                      <Check size={12} className="text-emerald-600" />
                    </span>
                  ) : (
                    <button
                      onClick={() => { setNumEditId(b.id); setNumEditVal(b.number || ""); }}
                      className="text-slate-700 hover:text-indigo-600 hover:underline decoration-dotted"
                      title="Click to edit"
                      data-testid={`bill-number-${b.id}`}
                    >{b.number}</button>
                  )}
                </td>
                <td className="px-3 py-2">{b.contact_name}</td>
                <td className="px-3 py-2 font-mono-num text-slate-500">{fmtDate(b.issue_date)}</td>
                <td className="px-3 py-2 font-mono-num text-slate-500">{fmtDate(b.due_date)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(b.total)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(b.balance_due)}</td>
                <td className="px-3 py-2"><span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100">{b.status}</span></td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button data-testid={`bill-memorize-btn-${b.id}`} onClick={() => setMemorizing(b)}
                            title="Memorize (recurring)"
                            className="p-1 rounded hover:bg-fuchsia-100 text-fuchsia-600"><Repeat size={13} /></button>
                    <button data-testid="bill-edit-btn" onClick={() => setEditing(b)}
                            className="p-1 rounded hover:bg-indigo-100 text-indigo-600"><Pencil size={13} /></button>
                    <button onClick={() => del(b.id)} className="p-1 rounded hover:bg-red-100 text-red-500"><Trash2 size={13} /></button>
                  </div>
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={8} className="text-center py-8 text-slate-500">
                  {(outstanding || asOf)
                    ? `No matching bills${items.length ? ` (${items.length} total, none met the filter)` : ""}.`
                    : "No bills."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {creating && <BillModal contacts={contacts} itemsCatalog={itemsCatalog} currentId={currentId} prefill={creatingPrefill}
                                onClose={() => { setCreating(false); setCreatingPrefill(null); load(); }} />}
      {editing && <BillModal contacts={contacts} itemsCatalog={itemsCatalog} currentId={currentId} bill={editing} onClose={() => { setEditing(null); load(); }} />}
      {memorizing && <MemorizeModal currentId={currentId} source={memorizing} kind="bill" onClose={() => setMemorizing(null)} />}
    </div>
  );
}

function BillModal({ contacts, itemsCatalog, currentId, bill, prefill, onClose }) {
  const editMode = !!bill;
  const p = prefill || {};
  const initLines = () => {
    if (bill?.line_items?.length) return bill.line_items.map(l => ({ ...l }));
    if (p.amount || p.description) {
      const amt = Number(p.amount || 0);
      return [{
        description: p.description || "Services",
        quantity: 1, rate: amt, amount: amt,
      }];
    }
    return [{ description: "", quantity: 1, rate: 0, amount: 0 }];
  };
  const [contact, setContact] = useState(bill?.contact_id || p.contact_id || "");
  useEffect(() => {
    if (!contact && p.contact_id && contacts.some(c => c.id === p.contact_id)) {
      setContact(p.contact_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts, p.contact_id]);
  const [issue, setIssue] = useState(bill?.issue_date || p.issue_date || new Date().toISOString().slice(0, 10));
  const [due, setDue] = useState(
    bill?.due_date
    || p.due_date
    || new Date(Date.now() + (Number(p.due_days) || 30) * 86400000).toISOString().slice(0, 10)
  );
  const [lines, setLines] = useState(initLines);
  const [status, setStatus] = useState(bill?.status || p.status || "open");
  const [number, setNumber] = useState(bill?.number || "");
  const upd = (i, p) => setLines(lines.map((x, j) => j === i ? { ...x, ...p, amount: (p.quantity !== undefined ? p.quantity : x.quantity) * (p.rate !== undefined ? p.rate : x.rate) } : x));
  const total = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const save = async () => {
    const c = contacts.find(x => x.id === contact);
    const body = {
      contact_id: contact || null, contact_name: c?.name || bill?.contact_name || "",
      issue_date: issue, due_date: due, line_items: lines, status,
    };
    if (number && number !== bill?.number) body.number = number.trim();
    if (editMode) {
      const r = await api.patch(`/companies/${currentId}/bills/${bill.id}`, body);
      if (r.data?.number_conflict) {
        toast.warning(`Heads up — another bill already uses ${body.number}.`);
      } else {
        toast.success("Bill updated");
      }
    } else {
      if (number) body.number = number.trim();
      await api.post(`/companies/${currentId}/bills`, body);
      toast.success("Bill created");
    }
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold">{editMode ? `Edit Bill ${bill.number}` : "New Bill"}</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <select value={contact} onChange={(e) => setContact(e.target.value)} className="border rounded px-2 py-1.5 text-sm">
            <option value="">Vendor…</option>
            {contacts.filter(c => c.type === "vendor" || c.type === "both").map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input type="date" value={issue} onChange={(e) => setIssue(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="border rounded px-2 py-1.5 text-sm">
            <option value="open">Open</option><option value="partial">Partial</option><option value="paid">Paid</option>
          </select>
        </div>
        <div>
          <label htmlFor={`bill-num-${bill?.id || "new"}`}
                 className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">
            Bill number
          </label>
          <input
            id={`bill-num-${bill?.id || "new"}`}
            key={`bill-num-${bill?.id || "new"}`}
            type="text"
            autoComplete="off"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="e.g. BILL-2001 (leave blank to auto-assign)"
            className="w-full border rounded px-2 py-1.5 text-sm font-mono-num focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
            data-testid="bill-modal-number"
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
                    // Bills use the item's expense-account mapping — falls
                    // back to income_account when the user hasn't set one.
                    expense_account_id: it.expense_account_id || null,
                    expense_account_name: it.expense_account_name || "",
                    category: it.expense_account_name || it.income_account_name || "",
                  })}
                  testId={`bill-line-${i}`}
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
          <div className="text-lg font-mono-num font-semibold">Total: {fmtMoney(total)}</div>
          <button data-testid={TID.saveBtn} onClick={save} className="px-4 py-2 rounded-md bg-slate-900 text-white text-sm">
            {editMode ? "Save changes" : "Save Bill"}
          </button>
        </div>
      </div>
    </div>
  );
}
