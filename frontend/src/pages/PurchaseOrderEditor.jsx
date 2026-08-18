import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import { toast } from "sonner";
import {
  ArrowLeft, Save, Plus, Trash2, Paperclip, X,
} from "lucide-react";
import ContactCombobox from "@/components/ContactCombobox";
import SearchableAccountPicker from "@/components/SearchableAccountPicker";

const TERMS_OPTIONS = [
  { label: "Due on receipt", days: 0 },
  { label: "Net 15", days: 15 },
  { label: "Net 30", days: 30 },
  { label: "Net 60", days: 60 },
  { label: "Custom", days: null },
];

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (baseIso, n) => iso(new Date(baseIso).getTime() + n * 86400000);

/**
 * Full-page Purchase Order Editor — Wave-style, mirrors InvoiceEditor with vendor
 * semantics. Routes: /bills/new and /bills/:id/edit.
 *
 * Kept intentionally close to InvoiceEditor so the two editors stay in
 * lockstep; if you fix a UX bug here, port it there and vice-versa.
 */
export default function PurchaseOrderEditor() {
  const { id } = useParams();
  const editMode = !!id;
  const navigate = useNavigate();
  const { currentId } = useCompany();

  const [loading, setLoading] = useState(editMode);
  const [saving, setSaving] = useState(false);

  const [contacts, setContacts] = useState([]);
  const [itemsCatalog, setItemsCatalog] = useState([]);
  const [expenseAccounts, setExpenseAccounts] = useState([]);
  // Full CoA — needed by SearchableAccountPicker so QuickCreate can
  // compute the next unused account code within the target GAAP range.
  const [allAccounts, setAllAccounts] = useState([]);
  const [taxes, setTaxes] = useState([]);
  const [taxModalLineIdx, setTaxModalLineIdx] = useState(null);

  const [number, setNumber] = useState("");
  const [contact, setContact] = useState("");
  const [issue, setIssue] = useState(iso(new Date()));
  const [termsLabel, setTermsLabel] = useState("Net 30");
  const [due, setDue] = useState(addDays(iso(new Date()), 30));
  const [poNumber, setPoNumber] = useState("");
  const [status, setStatus] = useState("open");
  const [lines, setLines] = useState([{ description: "", quantity: 1, rate: 0, amount: 0 }]);
  const [tax, setTax] = useState(0);
  const [shipping, setShipping] = useState(0);
  const [discount, setDiscount] = useState(0);
  const [discountType, setDiscountType] = useState("amount");
  const [notes, setNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");

  useEffect(() => {
    if (!currentId) return;
    let cancelled = false;
    (async () => {
      try {
        const [c, it, tx, ac] = await Promise.all([
          api.get(`/companies/${currentId}/contacts`),
          api.get(`/companies/${currentId}/items?usage=purchases`),
          api.get(`/companies/${currentId}/taxes`),
          api.get(`/companies/${currentId}/accounts`),
        ]);
        if (cancelled) return;
        setContacts(c.data.contacts || []);
        setItemsCatalog(it.data.items || []);
        setTaxes(tx.data.taxes || []);
        // Bill lines can post to either an EXPENSE account (typical
        // operating cost) or a LIABILITY account (paying down a loan,
        // credit card, or accrued balance the vendor bills you for).
        // Both share the same picker so a bill from a lender still
        // routes the payment straight against the liability instead
        // of forcing a manual JE. Sorted by numeric code so 2000-range
        // liabilities appear above 6000-range expenses in the dropdown.
        const rawAccounts = ac.data.accounts || [];
        setAllAccounts(rawAccounts);
        const accs = rawAccounts
          .filter(a => {
            const t = (a.type || "").toLowerCase();
            return t === "expense" || t === "liability";
          })
          .sort((x, y) => String(x.code || "").localeCompare(String(y.code || "")));
        setExpenseAccounts(accs);
        if (editMode) {
          const r = await api.get(`/companies/${currentId}/purchase-orders/${id}`);
          if (cancelled) return;
          const b = r.data.purchase_order;
          setNumber(b.number || "");
          setContact(b.contact_id || "");
          setIssue(b.issue_date || iso(new Date()));
          setDue(b.due_date || addDays(iso(new Date()), 30));
          setPoNumber(b.po_number || "");
          setTermsLabel(b.terms || "Custom");
          setStatus(b.status || "open");
          setLines((b.line_items || []).length
            ? b.line_items.map(l => ({
                description: l.description || "",
                quantity: Number(l.quantity || 1),
                rate: Number(l.rate || 0),
                amount: Number(l.amount || 0),
                item_id: l.item_id,
                item_name: l.item_name,
                expense_account_id: l.expense_account_id || l.income_account_id || null,
                expense_account_name: l.expense_account_name || l.income_account_name || "",
                category: l.category || "",
                tax_id: l.tax_id || null,
                tax_name: l.tax_name || "",
                tax_rate: Number(l.tax_rate || 0),
              }))
            : [{ description: "", quantity: 1, rate: 0, amount: 0 }]);
          setTax(Number(b.tax || 0));
          setShipping(Number(b.shipping || 0));
          setDiscount(Number(b.discount || 0));
          setDiscountType(b.discount_type || "amount");
          setNotes(b.notes || "");
          setInternalNotes(b.internal_notes || "");
          setAttachments(b.attachments || []);
          setTitle(b.title || "");
          setSummary(b.summary || "");
        }
      } catch (e) {
        toast.error(e.response?.data?.detail || "Failed to load purchase order");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentId, id, editMode]);

  useEffect(() => {
    const opt = TERMS_OPTIONS.find(o => o.label === termsLabel);
    if (opt && opt.days !== null && issue) setDue(addDays(issue, opt.days));
  }, [termsLabel, issue]);

  const updLine = (i, patch) => setLines(prev => prev.map((x, j) => {
    if (j !== i) return x;
    const q = patch.quantity !== undefined ? Number(patch.quantity) : Number(x.quantity || 0);
    const r = patch.rate !== undefined ? Number(patch.rate) : Number(x.rate || 0);
    return { ...x, ...patch, quantity: q, rate: r, amount: Number((q * r).toFixed(2)) };
  }));
  const addLine = () => setLines(prev => [...prev, { description: "", quantity: 1, rate: 0, amount: 0 }]);
  const removeLine = (i) => setLines(prev => prev.length > 1 ? prev.filter((_, j) => j !== i) : prev);

  const totals = useMemo(() => {
    const subtotal = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
    const lineTax = lines.reduce((s, l) => {
      const rate = Number(l.tax_rate || 0);
      return s + (rate ? Number(l.amount || 0) * rate / 100 : 0);
    }, 0);
    const disc = Number(discount || 0);
    const discAmt = discountType === "percent" ? +(subtotal * disc / 100).toFixed(2) : +(disc).toFixed(2);
    const ship = Number(shipping || 0);
    const taxV = +(Number(tax || 0) + lineTax).toFixed(2);
    const total = +(subtotal - discAmt + ship + taxV).toFixed(2);
    return { subtotal, discAmt, ship, taxV, total, lineTax: +lineTax.toFixed(2) };
  }, [lines, discount, discountType, shipping, tax]);

  const onAttach = async (files) => {
    for (const f of files) {
      if (f.size > 6 * 1024 * 1024) { toast.error(`${f.name} > 6 MB, skipped`); continue; }
      const dataUrl = await new Promise((res) => {
        const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f);
      });
      setAttachments(prev => [...prev, { filename: f.name, data_url: dataUrl, size: f.size }]);
    }
  };
  const removeAttachment = (i) => setAttachments(prev => prev.filter((_, j) => j !== i));
  const buildBody = () => {
    const c = contacts.find(x => x.id === contact);
    return {
      contact_id: contact || null,
      contact_name: c?.name || "",
      issue_date: issue,
      due_date: due,
      line_items: lines,
      tax: Number(tax || 0),
      shipping: Number(shipping || 0),
      discount: Number(discount || 0),
      discount_type: discountType,
      status,
      po_number: poNumber || "",
      terms: termsLabel || "",
      notes: notes || "",
      internal_notes: internalNotes || "",
      attachments,
      title: title || "",
      summary: summary || "",
      ...(number ? { number: number.trim() } : {}),
    };
  };

  const save = async ({ silent = false } = {}) => {
    if (saving) return;
    setSaving(true);
    try {
      const body = buildBody();
      let bid = id;
      if (editMode) {
        const r = await api.patch(`/companies/${currentId}/purchase-orders/${id}`, body);
        if (r.data?.number_conflict) toast.warning(`Heads up — another bill already uses ${body.number}.`);
        else if (!silent) toast.success("Purchase order saved");
      } else {
        const r = await api.post(`/companies/${currentId}/purchase-orders`, body);
        bid = r.data.id;
        if (!silent) toast.success("Purchase order created");
        navigate(`/purchase-orders/${bid}/edit`, { replace: true });
      }
      return bid;
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setSaving(false); }
  };

  const goPreview = async () => {
    await save({ silent: false });
  };

  // ── Apply-tax-all (parity with InvoiceEditor) ──
  const applyTaxToAllLines = (taxId) => {
    if (!taxId) {
      setLines(prev => prev.map(l => ({ ...l, tax_id: null, tax_name: "", tax_rate: 0 })));
      toast.success("Cleared tax on all lines");
      return;
    }
    const t = taxes.find(x => x.id === taxId);
    if (!t) return;
    setLines(prev => prev.map(l => ({
      ...l, tax_id: t.id, tax_name: t.name, tax_rate: Number(t.rate || 0),
    })));
    toast.success(`Applied ${t.name} · ${Number(t.rate).toFixed(2)}% to all lines`);
  };

  if (loading) return <div className="p-8 text-slate-500">Loading purchase order…</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-4 pb-16">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            data-testid="po-editor-back"
            onClick={() => navigate("/purchase-orders")}
            className="p-2 rounded-md hover:bg-slate-100 text-slate-600"
            title="Back to purchase orders"
          ><ArrowLeft size={16} /></button>
          <div className="min-w-0">
            <h1 className="font-heading text-2xl font-bold tracking-tight truncate">
              {editMode ? `PO ${number || ""}` : "New PO"}
            </h1>
            <p className="text-xs text-slate-500">
              {editMode ? `Status: ${status.toUpperCase()}` : "Not yet saved"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            data-testid="po-editor-save"
            onClick={() => save()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50 shadow-sm"
          ><Save size={14} /> {saving ? "Saving…" : (editMode ? "Save changes" : "Save PO")}</button>
        </div>
      </div>

      <EditForm
        {...{
          contacts, setContacts, itemsCatalog, taxes, setTaxes, expenseAccounts,
          setExpenseAccounts, allAccounts, setAllAccounts, currentId,
          contact, setContact,
          number, setNumber,
          issue, setIssue, due, setDue,
          termsLabel, setTermsLabel,
          poNumber, setPoNumber,
          status, setStatus,
          lines, setLines, addLine, updLine, removeLine,
          tax, setTax, shipping, setShipping,
          discount, setDiscount, discountType, setDiscountType,
          notes, setNotes, internalNotes, setInternalNotes,
          attachments, onAttach, removeAttachment,
          totals,
          taxModalLineIdx, setTaxModalLineIdx,
          applyTaxToAllLines,
          editMode,
          docId: id,
        }}
      />

      {taxModalLineIdx !== null && (
        <CreateTaxDialog
          onClose={() => setTaxModalLineIdx(null)}
          onCreated={(t) => {
            setTaxes(prev => [...prev, t].sort((a, b) => a.name.localeCompare(b.name)));
            const i = taxModalLineIdx;
            setLines(prev => prev.map((x, j) => j === i
              ? { ...x, tax_id: t.id, tax_name: t.name, tax_rate: Number(t.rate || 0) }
              : x));
            setTaxModalLineIdx(null);
          }}
          currentId={currentId}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave-style PO EditForm — compact meta grid on top, inline-columns line
// items (Item · Expense Category · Description · Qty · Price · Tax · Amount),
// right-aligned totals stack, attachments below.
//
// Deliberately DOES NOT render the branding/logo card that Invoices have —
// POs are internal purchase-commitment records sent to vendors.
// ─────────────────────────────────────────────────────────────────────────────

const TERMS_LABEL_TO_DAYS = {
  "Due on receipt": 0, "Net 15": 15, "Net 30": 30, "Net 60": 60,
};

function EditForm({
  contacts, setContacts, itemsCatalog, taxes, setTaxes, expenseAccounts,
  setExpenseAccounts, allAccounts, setAllAccounts, currentId,
  contact, setContact,
  number, setNumber,
  issue, setIssue, due, setDue,
  termsLabel, setTermsLabel,
  poNumber, setPoNumber,
  status, setStatus,
  lines, setLines, addLine, updLine, removeLine,
  tax, setTax, shipping, setShipping,
  discount, setDiscount, discountType, setDiscountType,
  notes, setNotes, internalNotes, setInternalNotes,
  attachments, onAttach, removeAttachment,
  totals,
  taxModalLineIdx, setTaxModalLineIdx,
  applyTaxToAllLines,
  editMode,
  docId,
}) {

  const fmtMoney = useMoneyFmt();
  const vendorContacts = useMemo(
    () => contacts.filter(c => c.type === "vendor" || c.type === "both"),
    [contacts]
  );
  const applyTaxToLine = (i, taxId) => {
    if (taxId === "__new__") { setTaxModalLineIdx(i); return; }
    if (!taxId) { updLine(i, { tax_id: null, tax_name: "", tax_rate: 0 }); return; }
    const t = taxes.find(x => x.id === taxId);
    if (!t) return;
    updLine(i, { tax_id: t.id, tax_name: t.name, tax_rate: Number(t.rate || 0) });
  };
  const applyItemToLine = (i, itemId) => {
    if (!itemId) {
      updLine(i, { item_id: null, item_name: "" });
      return;
    }
    const it = itemsCatalog.find(x => x.id === itemId);
    if (!it) return;
    updLine(i, {
      item_id: it.id,
      item_name: it.name,
      // Only auto-fill description when the row description is empty
      // — respect any hand-typed override. Item NAME takes precedence
      // over the internal catalog description on customer-facing docs.
      description: (lines[i]?.description) || it.name || "",
      rate: Number(it.expense_price ?? it.price ?? lines[i]?.rate ?? 0),
      expense_account_id: it.expense_account_id || lines[i]?.expense_account_id || null,
      expense_account_name: it.expense_account_name || lines[i]?.expense_account_name || "",
    });
  };
  const applyExpenseToLine = (i, acctId) => {
    if (!acctId) {
      updLine(i, { expense_account_id: null, expense_account_name: "" });
      return;
    }
    const a = expenseAccounts.find(x => x.id === acctId);
    if (!a) return;
    updLine(i, { expense_account_id: a.id, expense_account_name: a.name });
  };
  // Every line needs a category before Save enables — accountant-strict.
  const missingCategoryCount = lines.filter(l => !l.expense_account_id).length;

  return (
    <section className="rounded-lg border bg-white shadow-xl overflow-hidden ring-1 ring-slate-100" data-testid="po-editor-form">
      {/* Compact top meta grid — Wave-style single band above the table */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4 px-6 py-5">
        {/* Column 1 — Vendor + Currency */}
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-slate-500 mb-1">Vendor <span className="text-red-500">*</span></label>
            <ContactCombobox
              contacts={contacts}
              value={contact}
              onChange={setContact}
              onCreated={(c) => setContacts(prev => [...prev, c])}
              type="vendor"
              currentId={currentId}
              testId="po-editor-vendor"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-1">Currency</label>
            <div
              className="w-full border rounded px-3 py-2 text-sm bg-slate-50 text-slate-500 select-none"
              data-testid="po-editor-currency"
              title="Uses the company's default currency"
            >USD — U.S. dollar</div>
          </div>
        </div>

        {/* Column 2 — Dates + PO */}
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-slate-500 mb-1">PO Date</label>
            <input
              data-testid="po-editor-issue"
              type="date"
              value={issue}
              onChange={(e) => setIssue(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <label className="text-sm text-slate-500">Due Date</label>
              <select
                data-testid="po-editor-terms"
                value={termsLabel}
                onChange={(e) => setTermsLabel(e.target.value)}
                className="text-xs text-slate-500 bg-transparent border-0 focus:outline-none"
              >
                {["Due on receipt", "Net 15", "Net 30", "Net 60", "Custom"].map(l => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </div>
            <input
              data-testid="po-editor-due"
              type="date"
              value={due}
              onChange={(e) => { setDue(e.target.value); setTermsLabel("Custom"); }}
              className="w-full border rounded px-3 py-2 text-sm mt-1"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-1">P.O./S.O.</label>
            <input
              data-testid="po-editor-po"
              value={poNumber}
              onChange={(e) => setPoNumber(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm font-mono-num"
            />
          </div>
        </div>

        {/* Column 3 — PO # + Notes + Status */}
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-slate-500 mb-1">PO #</label>
            <input
              data-testid="po-editor-number"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="Auto-assigned"
              className="w-full border rounded px-3 py-2 text-sm font-mono-num"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-1">Notes</label>
            <textarea
              data-testid="po-editor-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full border rounded px-3 py-2 text-sm resize-none"
              placeholder="Payment terms, ACH details, memo…"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-1">Status</label>
            <select
              data-testid="po-editor-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm bg-white"
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="converted">Converted</option>
            </select>
          </div>
        </div>
      </div>

      {/* Line items — Wave-style inline columns */}
      <div className="border-t bg-slate-50/50 px-4 py-4">
        <div className="overflow-x-auto rounded-md border bg-white">
          <table className="w-full text-sm" data-testid="po-editor-lines-table">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="text-left px-3 py-2 w-[140px]">Item</th>
                <th className="text-left px-3 py-2 w-[170px]">
                  Expense Category <span className="text-red-500 normal-case">*</span>
                </th>
                <th className="text-left px-3 py-2">Description</th>
                <th className="text-right px-3 py-2 w-[70px]">Qty</th>
                <th className="text-right px-3 py-2 w-[90px]">Price</th>
                <th className="text-left px-3 py-2 w-[160px]">Tax</th>
                <th className="text-right px-3 py-2 w-[100px]">Amount</th>
                <th className="w-[40px]"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.map((l, i) => {
                const missingCat = !l.expense_account_id;
                return (
                  <tr key={i} data-testid={`po-editor-line-${i}`}
                      className={missingCat ? "bg-red-50/40" : ""}>
                    <td className="px-2 py-1.5">
                      <select
                        value={l.item_id || ""}
                        onChange={(e) => applyItemToLine(i, e.target.value)}
                        className="w-full border rounded px-2 py-1 text-sm bg-white"
                        data-testid={`po-editor-line-${i}-item`}
                      >
                        <option value="">Choose…</option>
                        {itemsCatalog.map(it => (
                          <option key={it.id} value={it.id}>{it.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <SearchableAccountPicker
                        value={l.expense_account_id || null}
                        onChange={(id) => applyExpenseToLine(i, id)}
                        accounts={expenseAccounts}
                        allAccounts={allAccounts}
                        placeholder="Choose category…"
                        kindLabel="expense"
                        newDefaults={{ type: "expense" }}
                        currentId={currentId}
                        onCreated={(acct) => {
                          // Fold the freshly-created account into both lists so
                          // it shows up immediately on the next line without a
                          // page reload. Same sort as the initial load.
                          setAllAccounts(prev => [...prev, acct]);
                          setExpenseAccounts(prev => {
                            const next = [...prev, acct];
                            next.sort((x, y) => String(x.code || "").localeCompare(String(y.code || "")));
                            return next;
                          });
                        }}
                        testId={`po-editor-line-${i}-category`}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        value={l.description || ""}
                        onChange={(e) => updLine(i, { description: e.target.value })}
                        placeholder="Add a description"
                        className="w-full border rounded px-2 py-1 text-sm"
                        data-testid={`po-editor-line-${i}-desc`}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number" step="0.01"
                        value={l.quantity}
                        onChange={(e) => updLine(i, { quantity: Number(e.target.value) })}
                        className="w-full border rounded px-2 py-1 text-sm text-right font-mono-num"
                        data-testid={`po-editor-line-${i}-qty`}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number" step="0.01"
                        value={l.rate}
                        onChange={(e) => updLine(i, { rate: Number(e.target.value) })}
                        className="w-full border rounded px-2 py-1 text-sm text-right font-mono-num"
                        data-testid={`po-editor-line-${i}-rate`}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <select
                        value={l.tax_id || ""}
                        onChange={(e) => applyTaxToLine(i, e.target.value)}
                        className="w-full border rounded px-2 py-1 text-sm bg-white"
                        data-testid={`po-editor-line-${i}-tax`}
                      >
                        <option value="">—</option>
                        {taxes.map(t => (
                          <option key={t.id} value={t.id}>{t.name} · {Number(t.rate).toFixed(2)}%</option>
                        ))}
                        <option value="__new__">+ Create a new tax…</option>
                      </select>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono-num text-sm text-slate-800">
                      {fmtMoney(l.amount)}
                    </td>
                    <td className="px-2 py-1.5">
                      <button
                        onClick={() => removeLine(i)}
                        disabled={lines.length === 1}
                        className="p-1 rounded hover:bg-red-50 text-red-500 disabled:opacity-30"
                        data-testid={`po-editor-line-${i}-remove`}
                      ><Trash2 size={13} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between mt-3">
          <button
            onClick={addLine}
            className="inline-flex items-center gap-1.5 text-sm text-indigo-600 hover:underline"
            data-testid="po-editor-line-add"
          ><Plus size={14} /> Add a line</button>
          <div className="flex items-center gap-4">
            {taxes.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-slate-500">Apply tax to every line:</span>
                <select
                  onChange={(e) => {
                    const v = e.target.value;
                    applyTaxToAllLines(v === "__clear__" ? "" : v);
                    e.target.value = "";
                  }}
                  defaultValue=""
                  className="border rounded px-2 py-1 text-xs bg-white"
                  data-testid="po-editor-apply-tax-all"
                >
                  <option value="" disabled>Choose tax…</option>
                  {taxes.map(t => (
                    <option key={t.id} value={t.id}>{t.name} · {Number(t.rate).toFixed(2)}%</option>
                  ))}
                  <option value="__clear__">— clear —</option>
                </select>
              </div>
            )}
            {missingCategoryCount > 0 && (
              <span className="text-[11px] text-red-600 inline-flex items-center gap-1" data-testid="po-editor-cat-warning">
                {missingCategoryCount} line{missingCategoryCount > 1 ? "s" : ""} still need an expense category.
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Right-aligned totals stack — Wave layout */}
      <div className="px-6 py-5 border-t">
        <div className="ml-auto max-w-sm space-y-2">
          <TotalsRow label="Subtotal" value={fmtMoney(totals.subtotal)} testId="po-editor-subtotal" />
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-slate-500">Discount</span>
            <div className="flex items-center gap-2">
              <input type="number" step="0.01" value={discount}
                     onChange={(e) => setDiscount(e.target.value)}
                     className="w-20 border rounded px-2 py-1 text-sm text-right font-mono-num"
                     data-testid="po-editor-discount" />
              <div className="inline-flex rounded-md border overflow-hidden text-xs">
                <button onClick={() => setDiscountType("amount")}
                        className={`px-2 py-1 ${discountType === "amount" ? "bg-slate-900 text-white" : "bg-white text-slate-600"}`}>$</button>
                <button onClick={() => setDiscountType("percent")}
                        className={`px-2 py-1 ${discountType === "percent" ? "bg-slate-900 text-white" : "bg-white text-slate-600"}`}>%</button>
              </div>
            </div>
          </div>
          {totals.discAmt > 0 && (
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>Discount applied</span>
              <span className="font-mono-num">−{fmtMoney(totals.discAmt)}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-slate-500">Shipping</span>
            <input type="number" step="0.01" value={shipping}
                   onChange={(e) => setShipping(e.target.value)}
                   className="w-28 border rounded px-2 py-1 text-sm text-right font-mono-num"
                   data-testid="po-editor-shipping" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-slate-500">
              Tax {totals.lineTax > 0 && <span className="text-[10px] text-slate-400">(includes ${totals.lineTax.toFixed(2)} per-line)</span>}
            </span>
            <input type="number" step="0.01" value={tax}
                   onChange={(e) => setTax(e.target.value)}
                   className="w-28 border rounded px-2 py-1 text-sm text-right font-mono-num"
                   data-testid="po-editor-tax" />
          </div>
          <div className="flex items-center justify-between pt-2 border-t">
            <span className="text-base font-semibold text-slate-800">Total (USD)</span>
            <span className="text-lg font-mono-num font-semibold text-slate-900" data-testid="po-editor-total">{fmtMoney(totals.total)}</span>
          </div>
        </div>
      </div>

      {/* Attachments + Internal notes — always useful for POs */}
      <div className="px-6 py-5 border-t bg-slate-50/50 grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <div className="text-xs font-semibold text-slate-700 mb-1">Internal notes</div>
          <p className="text-[11px] text-slate-500 mb-2">Private. Never leaves the app.</p>
          <textarea data-testid="po-editor-internal-notes" value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)}
                    rows={3} className="w-full border rounded px-2 py-1.5 text-sm bg-white"
                    placeholder="For your team's eyes only." />
        </div>
        <div>
          <div className="text-xs font-semibold text-slate-700 mb-1">Attachments</div>
          <p className="text-[11px] text-slate-500 mb-2">Attach the vendor PDF, receipts, or supporting docs.</p>
          <input type="file" multiple onChange={(e) => onAttach(Array.from(e.target.files || []))}
                 className="text-xs" data-testid="po-editor-attach" />
          {attachments.length > 0 && (
            <ul className="mt-2 divide-y border rounded bg-white">
              {attachments.map((a, i) => (
                <li key={i} className="flex items-center justify-between px-3 py-2 text-xs" data-testid={`po-editor-attachment-${i}`}>
                  <span className="inline-flex items-center gap-1.5 truncate">
                    <Paperclip size={12} /> {a.filename}
                    <span className="text-slate-400">({Math.round((a.size || 0) / 1024)} KB)</span>
                  </span>
                  <button onClick={() => removeAttachment(i)} className="text-red-500 hover:bg-red-50 rounded p-1">
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function TotalsRow({ label, value, testId }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-sm font-mono-num text-slate-800" data-testid={testId}>{value}</span>
    </div>
  );
}



function CreateTaxDialog({ onClose, onCreated, currentId }) {
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    const clean = name.trim();
    const r = parseFloat(rate);
    if (!clean) { toast.error("Tax name is required"); return; }
    if (isNaN(r) || r < 0 || r > 100) { toast.error("Rate must be between 0 and 100"); return; }
    setSaving(true);
    try {
      const resp = await api.post(`/companies/${currentId}/taxes`, { name: clean, rate: r });
      toast.success(`Tax "${clean}" created`);
      onCreated(resp.data.tax);
    } catch (e) { toast.error(e.response?.data?.detail || "Failed to create tax"); }
    finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-4" data-testid="create-tax-dialog">
        <div className="flex items-center justify-between border-b pb-3">
          <h3 className="font-heading font-semibold text-lg">Create a new tax</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Tax name <span className="text-red-500">*</span></label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                   placeholder="e.g. GST"
                   className="w-full border rounded px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
                   data-testid="create-tax-name" />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Tax rate <span className="text-red-500">*</span></label>
            <div className="relative">
              <input type="number" step="0.01" min="0" max="100" value={rate}
                     onChange={(e) => setRate(e.target.value)}
                     placeholder="0.00"
                     className="w-full border rounded px-3 py-2 text-sm pr-8 focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
                     data-testid="create-tax-rate" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">%</span>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 pt-3 border-t">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
          <button onClick={submit} disabled={saving || !name.trim() || rate === ""}
                  className="px-4 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50"
                  data-testid="create-tax-submit">
            {saving ? "Saving…" : "Create tax"}
          </button>
        </div>
      </div>
    </div>
  );
}
