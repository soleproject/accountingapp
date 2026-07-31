import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";
import {
  ArrowLeft, Save, Send, Plus, Trash2, Paperclip, Eye, Pencil,
  FileText, X,
} from "lucide-react";
import ItemPicker from "@/components/ItemPicker";

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
 * Full-page Invoice Editor — replaces the popup for both create and edit.
 * Routes: /invoices/new  and  /invoices/:id/edit
 */
export default function InvoiceEditor() {
  const { id } = useParams();
  const editMode = !!id;
  const navigate = useNavigate();
  const { currentId } = useCompany();

  const [tab, setTab] = useState("edit"); // "edit" | "preview"
  const [loading, setLoading] = useState(editMode);
  const [saving, setSaving] = useState(false);

  const [contacts, setContacts] = useState([]);
  const [itemsCatalog, setItemsCatalog] = useState([]);

  // Form state
  const [number, setNumber] = useState("");
  const [contact, setContact] = useState("");
  const [issue, setIssue] = useState(iso(new Date()));
  const [termsLabel, setTermsLabel] = useState("Net 30");
  const [due, setDue] = useState(addDays(iso(new Date()), 30));
  const [poNumber, setPoNumber] = useState("");
  const [status, setStatus] = useState("draft");
  const [lines, setLines] = useState([{ description: "", quantity: 1, rate: 0, amount: 0 }]);
  const [tax, setTax] = useState(0);
  const [shipping, setShipping] = useState(0);
  const [discount, setDiscount] = useState(0);
  const [discountType, setDiscountType] = useState("amount"); // "amount" | "percent"
  const [notes, setNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [attachments, setAttachments] = useState([]); // [{filename,data_url,size}]

  const [pdfBlobUrl, setPdfBlobUrl] = useState(null);
  const pdfUrlRef = useRef(null);

  // Load contacts, items, and (if editing) the invoice itself.
  useEffect(() => {
    if (!currentId) return;
    let cancelled = false;
    (async () => {
      try {
        const [c, it] = await Promise.all([
          api.get(`/companies/${currentId}/contacts`),
          api.get(`/companies/${currentId}/items?usage=sales`),
        ]);
        if (cancelled) return;
        setContacts(c.data.contacts || []);
        setItemsCatalog(it.data.items || []);
        if (editMode) {
          const r = await api.get(`/companies/${currentId}/invoices/${id}`);
          if (cancelled) return;
          const inv = r.data.invoice;
          setNumber(inv.number || "");
          setContact(inv.contact_id || "");
          setIssue(inv.issue_date || iso(new Date()));
          setDue(inv.due_date || addDays(iso(new Date()), 30));
          setPoNumber(inv.po_number || "");
          setTermsLabel(inv.terms || "Custom");
          setStatus(inv.status || "sent");
          setLines((inv.line_items || []).length
            ? inv.line_items.map(l => ({
                description: l.description || "",
                quantity: Number(l.quantity || 1),
                rate: Number(l.rate || 0),
                amount: Number(l.amount || 0),
                item_id: l.item_id,
                item_name: l.item_name,
                income_account_id: l.income_account_id || null,
                income_account_name: l.income_account_name || "",
                category: l.category || "",
              }))
            : [{ description: "", quantity: 1, rate: 0, amount: 0 }]);
          setTax(Number(inv.tax || 0));
          setShipping(Number(inv.shipping || 0));
          setDiscount(Number(inv.discount || 0));
          setDiscountType(inv.discount_type || "amount");
          setNotes(inv.notes || "");
          setInternalNotes(inv.internal_notes || "");
          setAttachments(inv.attachments || []);
        }
      } catch (e) {
        toast.error(e.response?.data?.detail || "Failed to load invoice");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentId, id, editMode]);

  // Recompute due date whenever terms or issue changes (unless "Custom").
  useEffect(() => {
    const opt = TERMS_OPTIONS.find(o => o.label === termsLabel);
    if (opt && opt.days !== null && issue) {
      setDue(addDays(issue, opt.days));
    }
  }, [termsLabel, issue]);

  // Line-level helpers.
  const updLine = (i, patch) => setLines(prev => prev.map((x, j) => {
    if (j !== i) return x;
    const q = patch.quantity !== undefined ? Number(patch.quantity) : Number(x.quantity || 0);
    const r = patch.rate !== undefined ? Number(patch.rate) : Number(x.rate || 0);
    return { ...x, ...patch, quantity: q, rate: r, amount: Number((q * r).toFixed(2)) };
  }));
  const addLine = () => setLines(prev => [...prev, { description: "", quantity: 1, rate: 0, amount: 0 }]);
  const removeLine = (i) => setLines(prev => prev.length > 1 ? prev.filter((_, j) => j !== i) : prev);

  // Totals math — mirrors backend _sum_lines.
  const totals = useMemo(() => {
    const subtotal = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
    const disc = Number(discount || 0);
    const discAmt = discountType === "percent" ? +(subtotal * disc / 100).toFixed(2) : +(disc).toFixed(2);
    const ship = Number(shipping || 0);
    const taxV = Number(tax || 0);
    const total = +(subtotal - discAmt + ship + taxV).toFixed(2);
    return { subtotal, discAmt, ship, taxV, total };
  }, [lines, discount, discountType, shipping, tax]);

  // Attachments (base64 for now — matches receipts pattern).
  const onAttach = async (files) => {
    for (const f of files) {
      if (f.size > 6 * 1024 * 1024) { toast.error(`${f.name} > 6 MB, skipped`); continue; }
      const dataUrl = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.readAsDataURL(f);
      });
      setAttachments(prev => [...prev, { filename: f.name, data_url: dataUrl, size: f.size }]);
    }
  };
  const removeAttachment = (i) => setAttachments(prev => prev.filter((_, j) => j !== i));

  // Build request body.
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
      ...(number ? { number: number.trim() } : {}),
    };
  };

  // Save handler — returns invoice id on success.
  const save = async ({ silent = false } = {}) => {
    if (saving) return;
    setSaving(true);
    try {
      const body = buildBody();
      let iid = id;
      if (editMode) {
        const r = await api.patch(`/companies/${currentId}/invoices/${id}`, body);
        if (r.data?.number_conflict) toast.warning(`Heads up — another invoice already uses ${body.number}.`);
        else if (!silent) toast.success("Invoice saved");
      } else {
        const r = await api.post(`/companies/${currentId}/invoices`, body);
        iid = r.data.id;
        if (!silent) toast.success("Invoice created");
        navigate(`/invoices/${iid}/edit`, { replace: true });
      }
      return iid;
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // Preview tab needs a saved invoice — auto-save silently before showing.
  const goPreview = async () => {
    let iid = id;
    if (!editMode) {
      iid = await save({ silent: true });
      if (!iid) return;
    } else {
      // Save latest edits first so the preview reflects them.
      await save({ silent: true });
    }
    setTab("preview");
  };

  // Fetch PDF blob whenever we hit preview.
  useEffect(() => {
    if (tab !== "preview" || !currentId || !id) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(`/companies/${currentId}/invoices/${id}/pdf`, { responseType: "blob" });
        if (cancelled) return;
        if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
        const url = URL.createObjectURL(new Blob([r.data], { type: "application/pdf" }));
        pdfUrlRef.current = url;
        setPdfBlobUrl(url);
      } catch (e) { toast.error("Could not load preview"); }
    })();
    return () => { cancelled = true; };
  }, [tab, id, currentId]);
  // Revoke blob on unmount.
  useEffect(() => () => { if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current); }, []);

  // Send-via-email flow.
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTo, setSendTo] = useState("");
  const [sending, setSending] = useState(false);
  const openSend = async () => {
    const iid = await save({ silent: true });
    if (!iid) return;
    const c = contacts.find(x => x.id === contact);
    setSendTo(c?.email || "");
    setSendOpen(true);
  };
  const doSend = async () => {
    setSending(true);
    try {
      const r = await api.post(`/companies/${currentId}/invoices/${id}/send-email`, null, {
        params: sendTo ? { to: sendTo } : {},
      });
      if (r.data.status === "sent") toast.success(`Emailed to ${r.data.to}`);
      else if (r.data.status === "failed") toast.error("Send failed — check Communications log");
      else toast.info(`Email skipped: ${r.data.status}`);
      setSendOpen(false);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Send failed");
    } finally {
      setSending(false);
    }
  };

  if (loading) return <div className="p-8 text-slate-500">Loading invoice…</div>;

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            data-testid="invoice-editor-back"
            onClick={() => navigate("/invoices")}
            className="p-2 rounded-md hover:bg-slate-100 text-slate-600"
            title="Back to invoices"
          ><ArrowLeft size={16} /></button>
          <div className="min-w-0">
            <h1 className="font-heading text-2xl font-bold tracking-tight truncate">
              {editMode ? `Invoice ${number || ""}` : "New Invoice"}
            </h1>
            <p className="text-xs text-slate-500">
              {editMode ? `Status: ${status.toUpperCase()}` : "Draft — not yet saved"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {editMode && (
            <button
              data-testid="invoice-editor-send"
              onClick={openSend}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm hover:bg-emerald-100"
              title="Email this invoice"
            ><Send size={14} /> Send email</button>
          )}
          <button
            data-testid="invoice-editor-save"
            onClick={() => save()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50"
          ><Save size={14} /> {saving ? "Saving…" : (editMode ? "Save changes" : "Save invoice")}</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b" data-testid="invoice-editor-tabs">
        <button
          data-testid="invoice-editor-tab-edit"
          onClick={() => setTab("edit")}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 -mb-px transition ${
            tab === "edit"
              ? "border-slate-900 text-slate-900 font-medium"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
        ><Pencil size={13} /> Edit</button>
        <button
          data-testid="invoice-editor-tab-preview"
          onClick={goPreview}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 -mb-px transition ${
            tab === "preview"
              ? "border-emerald-600 text-emerald-700 font-medium"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
        ><Eye size={13} /> Preview</button>
      </div>

      {tab === "preview" ? (
        <div className="rounded-xl border bg-slate-50 p-2">
          {pdfBlobUrl ? (
            <iframe
              title="Invoice preview"
              src={pdfBlobUrl}
              className="w-full h-[78vh] rounded-md bg-white border"
              data-testid="invoice-editor-preview-iframe"
            />
          ) : (
            <div className="h-[78vh] flex items-center justify-center text-slate-400 text-sm">
              Loading preview…
            </div>
          )}
        </div>
      ) : (
        <EditForm
          {...{
            contacts, itemsCatalog, contact, setContact,
            number, setNumber,
            issue, setIssue, due, setDue,
            termsLabel, setTermsLabel,
            poNumber, setPoNumber,
            status, setStatus,
            lines, addLine, updLine, removeLine,
            tax, setTax, shipping, setShipping,
            discount, setDiscount, discountType, setDiscountType,
            notes, setNotes, internalNotes, setInternalNotes,
            attachments, onAttach, removeAttachment,
            totals,
          }}
        />
      )}

      {sendOpen && (
        <SendEmailDialog
          to={sendTo}
          setTo={setSendTo}
          sending={sending}
          onClose={() => setSendOpen(false)}
          onSend={doSend}
        />
      )}
    </div>
  );
}

function EditForm({
  contacts, itemsCatalog, contact, setContact,
  number, setNumber,
  issue, setIssue, due, setDue,
  termsLabel, setTermsLabel,
  poNumber, setPoNumber,
  status, setStatus,
  lines, addLine, updLine, removeLine,
  tax, setTax, shipping, setShipping,
  discount, setDiscount, discountType, setDiscountType,
  notes, setNotes, internalNotes, setInternalNotes,
  attachments, onAttach, removeAttachment,
  totals,
}) {
  const customerContacts = useMemo(
    () => contacts.filter(c => c.type === "customer" || c.type === "both"),
    [contacts]
  );
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* LEFT (2/3) — form */}
      <div className="lg:col-span-2 space-y-4">
        {/* Bill-to + core meta */}
        <section className="rounded-xl border bg-white p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Customer">
              <select
                data-testid="invoice-editor-customer"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-sm"
              >
                <option value="">Choose customer…</option>
                {customerContacts.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Invoice number">
              <input
                data-testid="invoice-editor-number"
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                placeholder="INV-1001 (auto-assigned if blank)"
                className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Field label="Issue date">
              <input
                data-testid="invoice-editor-issue"
                type="date"
                value={issue}
                onChange={(e) => setIssue(e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </Field>
            <Field label="Terms">
              <select
                data-testid="invoice-editor-terms"
                value={termsLabel}
                onChange={(e) => setTermsLabel(e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-sm"
              >
                {TERMS_OPTIONS.map(o => (
                  <option key={o.label} value={o.label}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Due date">
              <input
                data-testid="invoice-editor-due"
                type="date"
                value={due}
                onChange={(e) => { setDue(e.target.value); setTermsLabel("Custom"); }}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </Field>
            <Field label="Status">
              <select
                data-testid="invoice-editor-status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-sm"
              >
                <option value="draft">Draft</option>
                <option value="sent">Sent</option>
                <option value="partial">Partial</option>
                <option value="paid">Paid</option>
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="PO number">
              <input
                data-testid="invoice-editor-po"
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
                placeholder="Optional purchase-order reference"
                className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
              />
            </Field>
          </div>
        </section>

        {/* Line items */}
        <section className="rounded-xl border bg-white p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-heading font-semibold text-sm text-slate-700">Line items</h3>
          </div>
          <div className="grid grid-cols-12 gap-2 text-[10px] uppercase tracking-wide text-slate-500 pb-1 border-b">
            <div className="col-span-6">Description / item</div>
            <div className="col-span-2 text-right">Qty</div>
            <div className="col-span-2 text-right">Rate</div>
            <div className="col-span-2 text-right">Amount</div>
          </div>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center" data-testid={`invoice-editor-line-${i}`}>
                <div className="col-span-6">
                  <ItemPicker
                    items={itemsCatalog}
                    value={l.description}
                    onChangeText={(txt) => updLine(i, { description: txt })}
                    onPickItem={(it) => updLine(i, {
                      item_id: it.id, item_name: it.name,
                      description: it.description || it.name,
                      rate: Number(it.price || 0),
                      income_account_id: it.income_account_id || null,
                      income_account_name: it.income_account_name || "",
                      category: it.income_account_name || "",
                    })}
                    testId={`invoice-editor-line-${i}`}
                  />
                </div>
                <input
                  type="number" step="0.01" value={l.quantity}
                  onChange={(e) => updLine(i, { quantity: Number(e.target.value) })}
                  className="col-span-2 border rounded px-2 py-1.5 text-sm text-right font-mono-num"
                  data-testid={`invoice-editor-line-${i}-qty`}
                />
                <input
                  type="number" step="0.01" value={l.rate}
                  onChange={(e) => updLine(i, { rate: Number(e.target.value) })}
                  className="col-span-2 border rounded px-2 py-1.5 text-sm text-right font-mono-num"
                  data-testid={`invoice-editor-line-${i}-rate`}
                />
                <div className="col-span-1 py-1.5 text-right font-mono-num text-sm">{fmtMoney(l.amount)}</div>
                <button
                  onClick={() => removeLine(i)}
                  disabled={lines.length === 1}
                  className="col-span-1 justify-self-end p-1 rounded hover:bg-red-50 text-red-500 disabled:opacity-30"
                  data-testid={`invoice-editor-line-${i}-remove`}
                ><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
          <button
            onClick={addLine}
            className="inline-flex items-center gap-1.5 text-xs text-slate-600 border border-dashed rounded px-2 py-1.5 hover:bg-slate-50"
            data-testid="invoice-editor-line-add"
          ><Plus size={12} /> Add line</button>
        </section>

        {/* Notes + attachments */}
        <section className="rounded-xl border bg-white p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Notes to customer" hint="Renders at the bottom of the PDF.">
              <textarea
                data-testid="invoice-editor-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="Thanks for your business!"
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </Field>
            <Field label="Internal notes" hint="Private. Never shown on the PDF.">
              <textarea
                data-testid="invoice-editor-internal-notes"
                value={internalNotes}
                onChange={(e) => setInternalNotes(e.target.value)}
                rows={3}
                placeholder="For your team's eyes only."
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </Field>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">
              Attachments
            </label>
            <input
              type="file"
              multiple
              onChange={(e) => onAttach(Array.from(e.target.files || []))}
              className="text-xs"
              data-testid="invoice-editor-attach"
            />
            {attachments.length > 0 && (
              <ul className="mt-2 divide-y border rounded">
                {attachments.map((a, i) => (
                  <li key={i} className="flex items-center justify-between px-3 py-2 text-xs" data-testid={`invoice-editor-attachment-${i}`}>
                    <span className="inline-flex items-center gap-1.5 truncate">
                      <Paperclip size={12} /> {a.filename}
                      <span className="text-slate-400">({Math.round((a.size || 0) / 1024)} KB)</span>
                    </span>
                    <button
                      onClick={() => removeAttachment(i)}
                      className="text-red-500 hover:bg-red-50 rounded p-1"
                      data-testid={`invoice-editor-attachment-${i}-remove`}
                    ><Trash2 size={12} /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* RIGHT (1/3) — totals sidebar */}
      <aside className="space-y-4">
        <section className="rounded-xl border bg-white p-4 space-y-3 sticky top-4">
          <h3 className="font-heading font-semibold text-sm text-slate-700">Totals</h3>
          <Row label="Subtotal" value={fmtMoney(totals.subtotal)} />
          <div className="space-y-1.5 pt-1 border-t">
            <label className="block text-[10px] uppercase tracking-wide text-slate-500">Discount</label>
            <div className="flex items-center gap-2">
              <input
                type="number" step="0.01" value={discount}
                onChange={(e) => setDiscount(e.target.value)}
                className="flex-1 border rounded px-2 py-1.5 text-sm text-right font-mono-num"
                data-testid="invoice-editor-discount"
              />
              <div className="inline-flex rounded-md border overflow-hidden text-xs">
                <button
                  onClick={() => setDiscountType("amount")}
                  className={`px-2 py-1 ${discountType === "amount" ? "bg-slate-900 text-white" : "bg-white text-slate-600"}`}
                  data-testid="invoice-editor-discount-type-amount"
                >$</button>
                <button
                  onClick={() => setDiscountType("percent")}
                  className={`px-2 py-1 ${discountType === "percent" ? "bg-slate-900 text-white" : "bg-white text-slate-600"}`}
                  data-testid="invoice-editor-discount-type-percent"
                >%</button>
              </div>
            </div>
            {totals.discAmt > 0 && (
              <div className="text-[11px] text-slate-500 text-right">
                −{fmtMoney(totals.discAmt)} off
              </div>
            )}
          </div>
          <div className="space-y-1.5 pt-1 border-t">
            <label className="block text-[10px] uppercase tracking-wide text-slate-500">Shipping</label>
            <input
              type="number" step="0.01" value={shipping}
              onChange={(e) => setShipping(e.target.value)}
              className="w-full border rounded px-2 py-1.5 text-sm text-right font-mono-num"
              data-testid="invoice-editor-shipping"
            />
          </div>
          <div className="space-y-1.5 pt-1 border-t">
            <label className="block text-[10px] uppercase tracking-wide text-slate-500">Tax</label>
            <input
              type="number" step="0.01" value={tax}
              onChange={(e) => setTax(e.target.value)}
              className="w-full border rounded px-2 py-1.5 text-sm text-right font-mono-num"
              data-testid="invoice-editor-tax"
            />
          </div>
          <div className="pt-2 border-t flex items-center justify-between">
            <span className="text-sm font-heading font-semibold text-slate-800">Total</span>
            <span className="text-lg font-mono-num font-semibold text-slate-900" data-testid="invoice-editor-total">
              {fmtMoney(totals.total)}
            </span>
          </div>
        </section>
      </aside>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono-num text-slate-800">{value}</span>
    </div>
  );
}

function SendEmailDialog({ to, setTo, sending, onClose, onSend }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3" data-testid="invoice-send-dialog">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold inline-flex items-center gap-2">
            <FileText size={16} /> Email invoice
          </h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        <div className="space-y-1">
          <label className="block text-[10px] uppercase tracking-wide text-slate-500">Send to</label>
          <input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="customer@example.com"
            className="w-full border rounded px-2 py-1.5 text-sm"
            data-testid="invoice-send-to"
          />
          <p className="text-[11px] text-slate-400">A PDF of this invoice will be attached.</p>
        </div>
        <div className="flex items-center justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
          <button
            onClick={onSend}
            disabled={sending || !to || !to.includes("@")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-50"
            data-testid="invoice-send-submit"
          ><Send size={13} /> {sending ? "Sending…" : "Send"}</button>
        </div>
      </div>
    </div>
  );
}
