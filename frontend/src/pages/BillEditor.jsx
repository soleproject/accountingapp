import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";
import {
  ArrowLeft, Save, Send, Plus, Trash2, Paperclip, Eye, Pencil, X, Copy,
} from "lucide-react";
import PaymentHistoryBlock from "@/components/PaymentHistoryBlock";

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
 * Full-page Bill Editor — Wave-style, mirrors InvoiceEditor with vendor
 * semantics. Routes: /bills/new and /bills/:id/edit.
 *
 * Kept intentionally close to InvoiceEditor so the two editors stay in
 * lockstep; if you fix a UX bug here, port it there and vice-versa.
 */
export default function BillEditor() {
  const { id } = useParams();
  const editMode = !!id;
  const navigate = useNavigate();
  const { currentId } = useCompany();

  const [tab, setTab] = useState("edit");
  const [loading, setLoading] = useState(editMode);
  const [saving, setSaving] = useState(false);

  const [contacts, setContacts] = useState([]);
  const [itemsCatalog, setItemsCatalog] = useState([]);
  const [expenseAccounts, setExpenseAccounts] = useState([]);
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
  const [payments, setPayments] = useState([]);

  const [pdfBlobUrl, setPdfBlobUrl] = useState(null);
  const pdfUrlRef = useRef(null);

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
        // Expense-type accounts only, sorted by numeric code so 6000s
        // (SG&A) appear before 8000s (other expenses) etc.
        const accs = (ac.data.accounts || [])
          .filter(a => (a.type || "").toLowerCase() === "expense")
          .sort((x, y) => String(x.code || "").localeCompare(String(y.code || "")));
        setExpenseAccounts(accs);
        if (editMode) {
          const r = await api.get(`/companies/${currentId}/bills/${id}`);
          if (cancelled) return;
          const b = r.data.bill;
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
          try {
            const pr = await api.get(`/companies/${currentId}/payments`);
            if (!cancelled) {
              setPayments((pr.data.payments || []).filter(p => p.linked_bill_id === id));
            }
          } catch { /* payments optional context */ }
        }
      } catch (e) {
        toast.error(e.response?.data?.detail || "Failed to load bill");
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
        const r = await api.patch(`/companies/${currentId}/bills/${id}`, body);
        if (r.data?.number_conflict) toast.warning(`Heads up — another bill already uses ${body.number}.`);
        else if (!silent) toast.success("Bill saved");
      } else {
        const r = await api.post(`/companies/${currentId}/bills`, body);
        bid = r.data.id;
        if (!silent) toast.success("Bill created");
        navigate(`/bills/${bid}/edit`, { replace: true });
      }
      return bid;
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setSaving(false); }
  };

  const goPreview = async () => {
    let bid = id;
    if (!editMode) { bid = await save({ silent: true }); if (!bid) return; }
    else { await save({ silent: true }); }
    setTab("preview");
  };

  // ── Duplicate + Send-email + Apply-tax-all (parity with InvoiceEditor) ──
  const duplicate = async () => {
    if (!editMode) { toast.info("Save the bill first, then duplicate."); return; }
    try {
      await save({ silent: true });
      const r = await api.post(`/companies/${currentId}/bills/${id}/duplicate`);
      toast.success(`Duplicated as ${r.data.bill?.number || "new draft"}`);
      navigate(`/bills/${r.data.id}/edit`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Duplicate failed");
    }
  };

  const [sendOpen, setSendOpen] = useState(false);
  const [sendTo, setSendTo] = useState("");
  const [sending, setSending] = useState(false);
  const openSend = async () => {
    const bid = await save({ silent: true });
    if (!bid) return;
    const c = contacts.find(x => x.id === contact);
    setSendTo(c?.email || "");
    setSendOpen(true);
  };
  const doSend = async () => {
    setSending(true);
    try {
      const r = await api.post(`/companies/${currentId}/bills/${id}/send-email`, null, {
        params: sendTo ? { to: sendTo } : {},
      });
      if (r.data.status === "sent") toast.success(`Emailed to ${r.data.to}`);
      else if (r.data.status === "failed") toast.error("Send failed — check Communications log");
      else toast.info(`Email skipped: ${r.data.status}`);
      setSendOpen(false);
    } catch (e) { toast.error(e.response?.data?.detail || "Send failed"); }
    finally { setSending(false); }
  };

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

  useEffect(() => {
    if (tab !== "preview" || !currentId || !id) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(`/companies/${currentId}/bills/${id}/pdf`, { responseType: "blob" });
        if (cancelled) return;
        if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
        const url = URL.createObjectURL(new Blob([r.data], { type: "application/pdf" }));
        pdfUrlRef.current = url;
        setPdfBlobUrl(url);
      } catch (e) { toast.error("Could not load preview"); }
    })();
    return () => { cancelled = true; };
  }, [tab, id, currentId]);
  useEffect(() => () => { if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current); }, []);

  if (loading) return <div className="p-8 text-slate-500">Loading bill…</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-4 pb-16">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            data-testid="bill-editor-back"
            onClick={() => navigate("/bills")}
            className="p-2 rounded-md hover:bg-slate-100 text-slate-600"
            title="Back to bills"
          ><ArrowLeft size={16} /></button>
          <div className="min-w-0">
            <h1 className="font-heading text-2xl font-bold tracking-tight truncate">
              {editMode ? `Bill ${number || ""}` : "New Bill"}
            </h1>
            <p className="text-xs text-slate-500">
              {editMode ? `Status: ${status.toUpperCase()}` : "Not yet saved"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {editMode && (
            <>
              <button
                data-testid="bill-editor-duplicate"
                onClick={duplicate}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-slate-200 bg-white text-slate-700 text-sm hover:bg-slate-50"
                title="Duplicate as fresh draft"
              ><Copy size={14} /> Duplicate</button>
              <button
                data-testid="bill-editor-send"
                onClick={openSend}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm hover:bg-emerald-100"
              ><Send size={14} /> Send to vendor</button>
            </>
          )}
          <button
            data-testid="bill-editor-save"
            onClick={() => save()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50 shadow-sm"
          ><Save size={14} /> {saving ? "Saving…" : (editMode ? "Save changes" : "Save bill")}</button>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b" data-testid="bill-editor-tabs">
        <button
          data-testid="bill-editor-tab-edit"
          onClick={() => setTab("edit")}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 -mb-px transition ${
            tab === "edit" ? "border-slate-900 text-slate-900 font-medium" : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
        ><Pencil size={13} /> Edit</button>
        <button
          data-testid="bill-editor-tab-preview"
          onClick={goPreview}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 -mb-px transition ${
            tab === "preview" ? "border-emerald-600 text-emerald-700 font-medium" : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
        ><Eye size={13} /> Preview</button>
      </div>

      {tab === "preview" ? (
        <div className="rounded-xl border bg-slate-50 p-2 shadow-sm">
          {pdfBlobUrl ? (
            <iframe title="Bill preview" src={pdfBlobUrl}
              className="w-full h-[80vh] rounded-md bg-white border"
              data-testid="bill-editor-preview-iframe" />
          ) : (
            <div className="h-[80vh] flex items-center justify-center text-slate-400 text-sm">Loading preview…</div>
          )}
        </div>
      ) : (
          <EditForm
            {...{
              contacts, itemsCatalog, taxes, setTaxes, expenseAccounts,
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
              currentId,
              taxModalLineIdx, setTaxModalLineIdx,
              applyTaxToAllLines,
              payments,
            }}
          />
      )}

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

      {sendOpen && (
        <SendEmailDialog
          to={sendTo} setTo={setSendTo}
          sending={sending}
          onClose={() => setSendOpen(false)}
          onSend={doSend}
        />
      )}
    </div>
  );
}

function SendEmailDialog({ to, setTo, sending, onClose, onSend }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3" data-testid="bill-send-dialog">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold inline-flex items-center gap-2">
            <Send size={16} /> Send bill to vendor
          </h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        <div className="space-y-1">
          <label className="block text-[10px] uppercase tracking-wide text-slate-500">Send to</label>
          <input
            type="email" value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="vendor@example.com"
            className="w-full border rounded px-2 py-1.5 text-sm"
            data-testid="bill-send-to"
          />
          <p className="text-[11px] text-slate-400">A PDF of this bill will be attached.</p>
        </div>
        <div className="flex items-center justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
          <button
            onClick={onSend}
            disabled={sending || !to || !to.includes("@")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-50"
            data-testid="bill-send-submit"
          ><Send size={13} /> {sending ? "Sending…" : "Send"}</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave-style Bill EditForm — compact meta grid on top, inline-columns line
// items (Item · Expense Category · Description · Qty · Price · Tax · Amount),
// right-aligned totals stack, attachments below.
//
// Deliberately DOES NOT render the branding/logo card that Invoices have —
// bills are internal purchase records and never leave the pro's inbox.
// ─────────────────────────────────────────────────────────────────────────────

const TERMS_LABEL_TO_DAYS = {
  "Due on receipt": 0, "Net 15": 15, "Net 30": 30, "Net 60": 60,
};

function EditForm({
  contacts, itemsCatalog, taxes, setTaxes, expenseAccounts,
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
  currentId,
  taxModalLineIdx, setTaxModalLineIdx,
  applyTaxToAllLines,
  payments = [],
}) {
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
      // — respect any hand-typed override.
      description: (lines[i]?.description) || it.description || it.name || "",
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
    <section className="rounded-lg border bg-white shadow-xl overflow-hidden ring-1 ring-slate-100" data-testid="bill-editor-form">
      {/* Compact top meta grid — Wave-style single band above the table */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4 px-6 py-5">
        {/* Column 1 — Vendor + Currency */}
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-slate-500 mb-1">Vendor <span className="text-red-500">*</span></label>
            <select
              data-testid="bill-editor-vendor"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm bg-white"
            >
              <option value="">Choose…</option>
              {vendorContacts.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-1">Currency</label>
            <div
              className="w-full border rounded px-3 py-2 text-sm bg-slate-50 text-slate-500 select-none"
              data-testid="bill-editor-currency"
              title="Uses the company's default currency"
            >USD — U.S. dollar</div>
          </div>
        </div>

        {/* Column 2 — Dates + PO */}
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-slate-500 mb-1">Bill Date</label>
            <input
              data-testid="bill-editor-issue"
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
                data-testid="bill-editor-terms"
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
              data-testid="bill-editor-due"
              type="date"
              value={due}
              onChange={(e) => { setDue(e.target.value); setTermsLabel("Custom"); }}
              className="w-full border rounded px-3 py-2 text-sm mt-1"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-1">P.O./S.O.</label>
            <input
              data-testid="bill-editor-po"
              value={poNumber}
              onChange={(e) => setPoNumber(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm font-mono-num"
            />
          </div>
        </div>

        {/* Column 3 — Bill # + Notes + Status */}
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-slate-500 mb-1">Bill #</label>
            <input
              data-testid="bill-editor-number"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="Auto-assigned"
              className="w-full border rounded px-3 py-2 text-sm font-mono-num"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-1">Notes</label>
            <textarea
              data-testid="bill-editor-notes"
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
              data-testid="bill-editor-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm bg-white"
            >
              <option value="open">Open</option>
              <option value="partial">Partial</option>
              <option value="paid">Paid</option>
            </select>
          </div>
        </div>
      </div>

      {/* Line items — Wave-style inline columns */}
      <div className="border-t bg-slate-50/50 px-4 py-4">
        <div className="overflow-x-auto rounded-md border bg-white">
          <table className="w-full text-sm" data-testid="bill-editor-lines-table">
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
                  <tr key={i} data-testid={`bill-editor-line-${i}`}
                      className={missingCat ? "bg-red-50/40" : ""}>
                    <td className="px-2 py-1.5">
                      <select
                        value={l.item_id || ""}
                        onChange={(e) => applyItemToLine(i, e.target.value)}
                        className="w-full border rounded px-2 py-1 text-sm bg-white"
                        data-testid={`bill-editor-line-${i}-item`}
                      >
                        <option value="">Choose…</option>
                        {itemsCatalog.map(it => (
                          <option key={it.id} value={it.id}>{it.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <select
                        value={l.expense_account_id || ""}
                        onChange={(e) => applyExpenseToLine(i, e.target.value)}
                        className={`w-full border rounded px-2 py-1 text-sm bg-white ${missingCat ? "border-red-300" : ""}`}
                        data-testid={`bill-editor-line-${i}-category`}
                      >
                        <option value="">Choose…</option>
                        {expenseAccounts.map(a => (
                          <option key={a.id} value={a.id}>
                            {a.code ? `${a.code} · ` : ""}{a.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        value={l.description || ""}
                        onChange={(e) => updLine(i, { description: e.target.value })}
                        placeholder="Add a description"
                        className="w-full border rounded px-2 py-1 text-sm"
                        data-testid={`bill-editor-line-${i}-desc`}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number" step="0.01"
                        value={l.quantity}
                        onChange={(e) => updLine(i, { quantity: Number(e.target.value) })}
                        className="w-full border rounded px-2 py-1 text-sm text-right font-mono-num"
                        data-testid={`bill-editor-line-${i}-qty`}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number" step="0.01"
                        value={l.rate}
                        onChange={(e) => updLine(i, { rate: Number(e.target.value) })}
                        className="w-full border rounded px-2 py-1 text-sm text-right font-mono-num"
                        data-testid={`bill-editor-line-${i}-rate`}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <select
                        value={l.tax_id || ""}
                        onChange={(e) => applyTaxToLine(i, e.target.value)}
                        className="w-full border rounded px-2 py-1 text-sm bg-white"
                        data-testid={`bill-editor-line-${i}-tax`}
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
                        data-testid={`bill-editor-line-${i}-remove`}
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
            data-testid="bill-editor-line-add"
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
                  data-testid="bill-editor-apply-tax-all"
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
              <span className="text-[11px] text-red-600 inline-flex items-center gap-1" data-testid="bill-editor-cat-warning">
                {missingCategoryCount} line{missingCategoryCount > 1 ? "s" : ""} still need an expense category.
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Right-aligned totals stack — Wave layout */}
      <div className="px-6 py-5 border-t">
        <div className="ml-auto max-w-sm space-y-2">
          <TotalsRow label="Subtotal" value={fmtMoney(totals.subtotal)} testId="bill-editor-subtotal" />
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-slate-500">Discount</span>
            <div className="flex items-center gap-2">
              <input type="number" step="0.01" value={discount}
                     onChange={(e) => setDiscount(e.target.value)}
                     className="w-20 border rounded px-2 py-1 text-sm text-right font-mono-num"
                     data-testid="bill-editor-discount" />
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
                   data-testid="bill-editor-shipping" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-slate-500">
              Tax {totals.lineTax > 0 && <span className="text-[10px] text-slate-400">(includes ${totals.lineTax.toFixed(2)} per-line)</span>}
            </span>
            <input type="number" step="0.01" value={tax}
                   onChange={(e) => setTax(e.target.value)}
                   className="w-28 border rounded px-2 py-1 text-sm text-right font-mono-num"
                   data-testid="bill-editor-tax" />
          </div>
          <div className="flex items-center justify-between pt-2 border-t">
            <span className="text-base font-semibold text-slate-800">Total (USD)</span>
            <span className="text-lg font-mono-num font-semibold text-slate-900" data-testid="bill-editor-total">{fmtMoney(totals.total)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">Total Paid (USD)</span>
            <span className="text-sm font-mono-num text-slate-800" data-testid="bill-editor-paid">
              {fmtMoney((payments || []).reduce((s, p) => s + Number(p.amount || 0), 0))}
            </span>
          </div>
          <div className="flex items-center justify-between border-t pt-2">
            <span className="text-sm font-medium text-slate-700">Amount Due (USD)</span>
            <span
              className="text-sm font-mono-num font-semibold text-red-700"
              data-testid="bill-editor-due-amt"
            >{fmtMoney(Math.max(totals.total - (payments || []).reduce((s, p) => s + Number(p.amount || 0), 0), 0))}</span>
          </div>
        </div>
      </div>

      {payments && payments.length > 0 && (
        <PaymentHistoryBlock payments={payments} original={totals.total} kind="bill" />
      )}

      {/* Attachments + Internal notes — always useful for bills */}
      <div className="px-6 py-5 border-t bg-slate-50/50 grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <div className="text-xs font-semibold text-slate-700 mb-1">Internal notes</div>
          <p className="text-[11px] text-slate-500 mb-2">Private. Never leaves the app.</p>
          <textarea data-testid="bill-editor-internal-notes" value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)}
                    rows={3} className="w-full border rounded px-2 py-1.5 text-sm bg-white"
                    placeholder="For your team's eyes only." />
        </div>
        <div>
          <div className="text-xs font-semibold text-slate-700 mb-1">Attachments</div>
          <p className="text-[11px] text-slate-500 mb-2">Attach the vendor PDF, receipts, or supporting docs.</p>
          <input type="file" multiple onChange={(e) => onAttach(Array.from(e.target.files || []))}
                 className="text-xs" data-testid="bill-editor-attach" />
          {attachments.length > 0 && (
            <ul className="mt-2 divide-y border rounded bg-white">
              {attachments.map((a, i) => (
                <li key={i} className="flex items-center justify-between px-3 py-2 text-xs" data-testid={`bill-editor-attachment-${i}`}>
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
