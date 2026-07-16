import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, fmtMoney, fmtDate } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { useAiFocus } from "@/lib/aiFocus";
import { TID } from "@/constants/testIds";
import { toast } from "sonner";
import {
  Check, Wand2, Split, Link as LinkIcon, RotateCw, Plus, X, Trash2, AlertTriangle, ShieldCheck,
  ChevronLeft, ChevronRight,
} from "lucide-react";

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];

function ConfidenceChip({ conf, needs_review }) {
  const v = Number(conf || 0);
  // Needs-review always renders in an attention color regardless of the raw
  // confidence value. Some rows (transfers auto-routed to Uncategorized) have
  // conf=0.95 by design — the chip must not go green on them because the row
  // still requires an accountant to reclassify.
  let cls, label;
  if (needs_review) {
    cls = v < 0.70 ? "confidence-low" : "confidence-med";  // rose vs amber
    label = "Needs review";
  } else {
    cls = v >= 0.85 ? "confidence-high" : v >= 0.70 ? "confidence-med" : "confidence-low";
    label = v >= 0.85 ? "High" : v >= 0.70 ? "Medium" : "Low";
  }
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>
      {needs_review ? <AlertTriangle size={10} /> : <ShieldCheck size={10} />}
      {label} · {(v * 100).toFixed(0)}%
    </span>
  );
}

export default function Transactions() {
  const { currentId } = useCompany();
  const { setFocus } = useAiFocus();
  const [txns, setTxns] = useState([]);
  const [accts, setAccts] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [bills, setBills] = useState([]);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(new Set());
  const [editing, setEditing] = useState(null);
  const [splitting, setSplitting] = useState(null);
  const [linking, setLinking] = useState(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(250);
  const [pagination, setPagination] = useState({ total: 0, page: 1, pages: 1, limit: 250 });

  const load = async () => {
    if (!currentId) return;
    const params = new URLSearchParams();
    if (filter === "review") params.set("needs_review", "true");
    params.set("page", String(page));
    params.set("limit", String(pageSize));
    const qs = `?${params.toString()}`;
    const [t, a, i, b] = await Promise.all([
      api.get(`/companies/${currentId}/transactions${qs}`),
      api.get(`/companies/${currentId}/accounts`),
      api.get(`/companies/${currentId}/invoices`),
      api.get(`/companies/${currentId}/bills`),
    ]);
    setTxns(t.data.transactions || []);
    setPagination(t.data.pagination || { total: (t.data.transactions || []).length, page: 1, pages: 1, limit: pageSize });
    setAccts(a.data.accounts || []);
    setInvoices(i.data.invoices || []);
    setBills(b.data.bills || []);
    setSelected(new Set());
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId, filter, page, pageSize]);
  // Reset page when switching company (single-purpose, no duplicate fetch when
  // page is already 1).
  useEffect(() => { setPage(p => (p === 1 ? p : 1)); }, [currentId]);

  const [params] = useSearchParams();
  useEffect(() => {
    const hl = params.get("highlight");
    const opn = params.get("open");
    if (!hl || !txns.length) return;
    const target = txns.find(t => t.id === hl);
    if (target) {
      // Scroll to the row
      setTimeout(() => {
        const row = document.querySelector(`[data-txn-id="${hl}"]`);
        row?.scrollIntoView({ behavior: "smooth", block: "center" });
        row?.classList.add("bg-amber-50");
        setTimeout(() => row?.classList.remove("bg-amber-50"), 3000);
      }, 200);
      if (opn === "split") setSplitting(target);
    }
  }, [params, txns]);

  const acctById = useMemo(() => Object.fromEntries(accts.map(a => [a.id, a])), [accts]);

  const toggleSel = (id) => {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  };
  const allChecked = txns.length > 0 && txns.every(t => selected.has(t.id));

  const bulkApprove = async () => {
    if (!selected.size) return;
    setBusy(true);
    await api.post(`/companies/${currentId}/transactions/bulk-approve`, [...selected]);
    setBusy(false); setSelected(new Set()); toast.success(`Approved ${selected.size} transactions.`);
    load();
  };

  const bulkCreateRules = async () => {
    if (!selected.size) return;
    const grouped = {};
    for (const id of selected) {
      const t = txns.find(x => x.id === id);
      if (!t || !t.merchant || !t.category_account_code) continue;
      grouped[`${t.merchant}::${t.category_account_code}`] = t;
    }
    const items = Object.values(grouped);
    setBusy(true);
    for (const t of items) {
      await api.post(`/companies/${currentId}/rules`, {
        match_type: "merchant_contains",
        match_value: t.merchant,
        account_code: t.category_account_code,
        apply_to_existing: true,
      });
    }
    setBusy(false); setSelected(new Set());
    toast.success(`Created ${items.length} rule${items.length === 1 ? "" : "s"} and applied to existing transactions.`);
    load();
  };

  const approve = async (id) => {
    await api.post(`/companies/${currentId}/transactions/${id}/approve`);
    load();
  };
  const recategorize = async (id) => {
    setBusy(true);
    await api.post(`/companies/${currentId}/ai/recategorize/${id}`);
    setBusy(false); toast.success("Re-categorized by AI"); load();
  };
  const updateCategory = async (id, acctId) => {
    await api.patch(`/companies/${currentId}/transactions/${id}`, { category_account_id: acctId });
    load();
  };
  const del = async (id) => {
    if (!confirm("Delete this transaction?")) return;
    await api.delete(`/companies/${currentId}/transactions/${id}`);
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Transactions</h1>
          <p className="text-slate-500 text-sm mt-1">
            AI has posted the confident ones. Review the flagged. Hover a row to give the assistant context.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border bg-white">
            {["all", "review"].map(f => (
              <button
                key={f}
                data-testid={f === "review" ? TID.txnFilterReview : `txn-filter-${f}`}
                onClick={() => { setFilter(f); setPage(1); }}
                className={`px-3 py-1.5 text-xs font-medium ${filter === f ? "bg-slate-900 text-white" : "text-slate-600"}`}
              >
                {f === "all" ? "All" : "Needs Review"}
                {filter === f && (
                  <span data-testid={`txn-filter-count-${f}`}
                        className="ml-1.5 px-1.5 py-0.5 rounded bg-white/20 font-mono-num">
                    {pagination.total}
                  </span>
                )}
              </button>
            ))}
          </div>
          <button
            data-testid={TID.txnAddBtn}
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs"
          >
            <Plus size={13} /> Manual Transaction
          </button>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="rounded-md border bg-slate-900 text-white px-4 py-2.5 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <button data-testid={TID.txnBulkApprove} disabled={busy} onClick={bulkApprove}
                  className="inline-flex items-center gap-1 px-3 py-1 rounded bg-white text-slate-900 text-xs font-medium">
            <Check size={12} /> Approve all
          </button>
          <button data-testid={TID.txnBulkCreateRules} disabled={busy} onClick={bulkCreateRules}
                  className="inline-flex items-center gap-1 px-3 py-1 rounded bg-indigo-500 text-xs font-medium">
            <Wand2 size={12} /> Make these rules
          </button>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-xs opacity-70 hover:opacity-100">Clear</button>
        </div>
      )}

      <div className="rounded-xl border bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b bg-slate-50">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input type="checkbox" data-testid={TID.txnBulkCheckbox}
                    checked={allChecked}
                    onChange={(e) => setSelected(e.target.checked ? new Set(txns.map(t => t.id)) : new Set())} />
                </th>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Merchant / Description</th>
                <th className="px-3 py-2 text-left">Category</th>
                <th className="px-3 py-2 text-left">AI</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-right">Bank Balance</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {txns.map(t => (
                <tr key={t.id} data-testid={TID.txnRow} data-txn-id={t.id}
                    onMouseEnter={() => setFocus({ id: t.id, merchant: t.merchant, amount: t.amount, date: t.date })}
                    onMouseLeave={() => setFocus(null)}
                    className="border-b hover:bg-slate-50 transition-colors">
                  <td className="px-3 py-2">
                    <input type="checkbox" data-testid={TID.txnRowCheckbox}
                      checked={selected.has(t.id)} onChange={() => toggleSel(t.id)} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-slate-600 font-mono-num">{fmtDate(t.date)}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{t.merchant || t.description}</div>
                    {t.splits?.length > 0 && <div className="text-[10px] text-indigo-600">Split into {t.splits.length}</div>}
                    {(t.linked_invoice_id || t.linked_bill_id) && (
                      <div className="text-[10px] text-emerald-700">Linked to {t.linked_invoice_id ? "invoice" : "bill"}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <select data-testid={TID.txnEditCategory} value={t.category_account_id || ""}
                            onChange={(e) => updateCategory(t.id, e.target.value)}
                            className="text-xs border rounded px-1.5 py-1 bg-white max-w-[180px]">
                      <option value="">— Uncategorized —</option>
                      {accts.map(a => (
                        <option key={a.id} value={a.id}>{a.code} {a.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2"><ConfidenceChip conf={t.ai_confidence} needs_review={t.needs_review} /></td>
                  <td className={`px-3 py-2 text-right font-mono-num ${t.amount < 0 ? "text-slate-800" : "text-emerald-700 font-semibold"}`}>
                    {fmtMoney(t.amount)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono-num text-slate-500 text-xs">{t.bank_balance_after ? fmtMoney(t.bank_balance_after) : "—"}</td>
                  <td className="px-3 py-2">
                    {t.posted && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">Posted</span>}
                    {t.human_reviewed && <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-700">Reviewed</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1 justify-end">
                      <button title="Approve" data-testid={TID.txnApprove} onClick={() => approve(t.id)}
                              className="p-1 rounded hover:bg-emerald-100 text-emerald-600"><Check size={14} /></button>
                      <button title="AI re-categorize" data-testid={TID.txnRecategorize} onClick={() => recategorize(t.id)}
                              className="p-1 rounded hover:bg-indigo-100 text-indigo-600"><RotateCw size={14} /></button>
                      <button title="Split" data-testid={TID.txnSplit} onClick={() => setSplitting(t)}
                              className="p-1 rounded hover:bg-violet-100 text-violet-600"><Split size={14} /></button>
                      <button title="Link to invoice/bill" data-testid={TID.txnLink} onClick={() => setLinking(t)}
                              className="p-1 rounded hover:bg-blue-100 text-blue-600"><LinkIcon size={14} /></button>
                      <button title="Delete" data-testid={TID.deleteBtn} onClick={() => del(t.id)}
                              className="p-1 rounded hover:bg-red-100 text-red-500"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {!txns.length && (
                <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-500">No transactions.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <PaginationBar
          pagination={pagination}
          pageSize={pageSize}
          setPageSize={setPageSize}
          page={page}
          setPage={setPage}
          visibleCount={txns.length}
        />
      </div>

      {creating && <ManualTxnModal accts={accts} currentId={currentId} onClose={() => { setCreating(false); load(); }} />}
      {splitting && <SplitModal txn={splitting} accts={accts} currentId={currentId} onClose={() => { setSplitting(null); load(); }} />}
      {linking && <LinkModal txn={linking} invoices={invoices} bills={bills} currentId={currentId} onClose={() => { setLinking(null); load(); }} />}
    </div>
  );
}

function PaginationBar({ pagination, pageSize, setPageSize, page, setPage, visibleCount }) {
  const total = pagination?.total || 0;
  const pages = Math.max(1, pagination?.pages || 1);
  const currentPage = Math.min(pages, Math.max(1, pagination?.page || page));
  const startIdx = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endIdx = total === 0 ? 0 : (currentPage - 1) * pageSize + visibleCount;

  const canPrev = currentPage > 1;
  const canNext = currentPage < pages;

  return (
    <div className="flex items-center justify-between gap-3 flex-wrap border-t bg-slate-50/60 px-4 py-2.5">
      <div className="flex items-center gap-2 text-xs text-slate-600">
        <span data-testid={TID.txnPageIndicator}>
          {total === 0
            ? "No transactions"
            : <>Showing <span className="font-mono-num font-medium text-slate-900">{startIdx.toLocaleString()}</span>–<span className="font-mono-num font-medium text-slate-900">{endIdx.toLocaleString()}</span> of <span className="font-mono-num font-medium text-slate-900">{total.toLocaleString()}</span></>
          }
        </span>
        <span className="text-slate-300">·</span>
        <label className="inline-flex items-center gap-1.5">
          <span className="text-slate-500">Rows</span>
          <select
            data-testid={TID.txnPageSize}
            value={pageSize}
            onChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(1); }}
            className="border rounded px-1.5 py-0.5 bg-white text-xs font-mono-num"
          >
            {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-1">
        <button
          data-testid={TID.txnPagePrev}
          disabled={!canPrev}
          onClick={() => setPage(currentPage - 1)}
          className="inline-flex items-center gap-1 px-2 py-1 rounded border bg-white text-xs disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100"
        >
          <ChevronLeft size={14} /> Prev
        </button>
        <span className="px-2 text-xs text-slate-600 font-mono-num">
          Page {currentPage} of {pages}
        </span>
        <button
          data-testid={TID.txnPageNext}
          disabled={!canNext}
          onClick={() => setPage(currentPage + 1)}
          className="inline-flex items-center gap-1 px-2 py-1 rounded border bg-white text-xs disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100"
        >
          Next <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

function Modal({ title, children, onClose, wide }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className={`rounded-xl bg-white shadow-2xl w-full ${wide ? "max-w-2xl" : "max-w-md"}`}>
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-heading font-semibold">{title}</h3>
          <button data-testid={TID.cancelBtn} onClick={onClose} className="p-1 rounded hover:bg-slate-100"><X size={16} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function ManualTxnModal({ accts, currentId, onClose }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    await api.post(`/companies/${currentId}/transactions`, {
      date, description, merchant, amount: parseFloat(amount),
      category_account_id: categoryId || null, auto_categorize: !categoryId,
    });
    setBusy(false); toast.success("Transaction created (AI categorized)"); onClose();
  };
  return (
    <Modal title="Add manual transaction" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div><label className="text-xs text-slate-600">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border rounded px-2 py-1.5" /></div>
        <div><label className="text-xs text-slate-600">Merchant</label>
          <input value={merchant} onChange={(e) => setMerchant(e.target.value)} className="w-full border rounded px-2 py-1.5" /></div>
        <div><label className="text-xs text-slate-600">Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="w-full border rounded px-2 py-1.5" /></div>
        <div><label className="text-xs text-slate-600">Amount (negative = expense)</label>
          <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full border rounded px-2 py-1.5 font-mono-num" /></div>
        <div><label className="text-xs text-slate-600">Category (leave blank for AI)</label>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-full border rounded px-2 py-1.5">
            <option value="">Let AI decide</option>
            {accts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </select></div>
        <button data-testid={TID.saveBtn} onClick={save} disabled={busy}
                className="w-full py-2 rounded-md bg-slate-900 text-white text-sm">Save</button>
      </div>
    </Modal>
  );
}

function SplitModal({ txn, accts, currentId, onClose }) {
  const [rows, setRows] = useState([
    { amount: (txn.amount / 2).toFixed(2), category_account_id: txn.category_account_id, description: "" },
    { amount: (txn.amount / 2).toFixed(2), category_account_id: "", description: "" },
  ]);
  const total = rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
  const save = async () => {
    if (Math.abs(total - txn.amount) > 0.01) { toast.error(`Must total ${txn.amount}`); return; }
    await api.post(`/companies/${currentId}/transactions/${txn.id}/split`, { splits: rows });
    toast.success("Transaction split"); onClose();
  };
  return (
    <Modal title={`Split ${fmtMoney(txn.amount)} · ${txn.merchant}`} onClose={onClose} wide>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-center">
            <input type="number" step="0.01" value={r.amount}
                   onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))}
                   className="col-span-3 border rounded px-2 py-1.5 font-mono-num text-sm" />
            <select value={r.category_account_id}
                    onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, category_account_id: e.target.value } : x))}
                    className="col-span-5 border rounded px-2 py-1.5 text-sm">
              <option value="">Category…</option>
              {accts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            </select>
            <input placeholder="Description" value={r.description}
                   onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, description: e.target.value } : x))}
                   className="col-span-3 border rounded px-2 py-1.5 text-sm" />
            <button onClick={() => setRows(rows.filter((_, j) => j !== i))} className="col-span-1 text-red-500"><Trash2 size={14} /></button>
          </div>
        ))}
        <button onClick={() => setRows([...rows, { amount: "0", category_account_id: "", description: "" }])}
                className="text-xs text-slate-600 border border-dashed rounded px-2 py-1">+ Add split</button>
        <div className="flex items-center justify-between border-t pt-3 mt-3">
          <div className={`text-sm ${Math.abs(total - txn.amount) < 0.01 ? "text-emerald-600" : "text-red-600"}`}>
            Split total: <span className="font-mono-num font-semibold">{fmtMoney(total)}</span> · Target: <span className="font-mono-num">{fmtMoney(txn.amount)}</span>
          </div>
          <button data-testid={TID.saveBtn} onClick={save} className="px-4 py-1.5 rounded-md bg-slate-900 text-white text-sm">Save split</button>
        </div>
      </div>
    </Modal>
  );
}

function LinkModal({ txn, invoices, bills, currentId, onClose }) {
  const [kind, setKind] = useState(txn.amount > 0 ? "invoice" : "bill");
  const [selId, setSelId] = useState("");
  const save = async () => {
    const body = kind === "invoice" ? { invoice_id: selId } : { bill_id: selId };
    const q = new URLSearchParams(body).toString();
    await api.post(`/companies/${currentId}/transactions/${txn.id}/link?${q}`);
    toast.success(`Linked to ${kind}`); onClose();
  };
  const list = kind === "invoice" ? invoices : bills;
  return (
    <Modal title="Link transaction to invoice or bill" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div className="flex gap-2">
          <button onClick={() => setKind("invoice")}
                  className={`px-3 py-1.5 rounded ${kind === "invoice" ? "bg-slate-900 text-white" : "border"}`}>Invoice</button>
          <button onClick={() => setKind("bill")}
                  className={`px-3 py-1.5 rounded ${kind === "bill" ? "bg-slate-900 text-white" : "border"}`}>Bill</button>
        </div>
        <select value={selId} onChange={(e) => setSelId(e.target.value)} className="w-full border rounded px-2 py-1.5">
          <option value="">Select {kind}…</option>
          {list.map(x => <option key={x.id} value={x.id}>{x.number} · {x.contact_name} · {fmtMoney(x.total)}</option>)}
        </select>
        <button data-testid={TID.saveBtn} disabled={!selId} onClick={save}
                className="w-full py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50">Link</button>
      </div>
    </Modal>
  );
}
