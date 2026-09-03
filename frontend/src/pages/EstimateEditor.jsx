import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams, Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import { toast } from "sonner";
import {
  ArrowLeft, Save, Send, Plus, Trash2, Paperclip, Eye, Pencil, Mail,
  FileText, X, ChevronDown, ChevronUp, Upload, Copy,
} from "lucide-react";
import ItemPicker from "@/components/ItemPicker";
import ContactCombobox from "@/components/ContactCombobox";
import PaymentHistoryBlock from "@/components/PaymentHistoryBlock";
import FollowupHistoryBlock from "@/components/FollowupHistoryBlock";
import ProjectPhaseClassPicker from "@/components/ProjectPhaseClassPicker";

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
 * Full-page Estimate Editor — Wave-style layout (parity with InvoiceEditor).
 * Routes: /estimates/new  and  /estimates/:id/edit
 */
export default function EstimateEditor({ embed } = {}) {
  const routeParams = useParams();
  const [searchParams] = useSearchParams();
  const routeNavigate = useNavigate();
  const embedded = !!embed;

  const id = embedded ? (embed.estimateId || null) : routeParams.id;
  const editMode = !!id;
  const preProjectFromQuery = embedded
    ? (embed.projectId || null)
    : searchParams.get("project_id");
  const navigate = embedded ? (() => {}) : routeNavigate;
  const { currentId, current, refresh: refreshCompany } = useCompany();

  const [loading, setLoading] = useState(editMode);
  const [saving, setSaving] = useState(false);

  const [contacts, setContacts] = useState([]);
  const [itemsCatalog, setItemsCatalog] = useState([]);
  const [taxes, setTaxes] = useState([]);
  const [revenueAccounts, setRevenueAccounts] = useState([]);
  const [taxModalLineIdx, setTaxModalLineIdx] = useState(null);

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
  const [discountType, setDiscountType] = useState("amount");
  const [notes, setNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [projectLink, setProjectLink] = useState({
    class_id: null, project_id: null, phase_id: null,
  });

  // Load contacts, items, and (if editing) the estimate itself.
  useEffect(() => {
    if (!currentId) return;
    let cancelled = false;
    (async () => {
      try {
        const [c, it, tx, ac] = await Promise.all([
          api.get(`/companies/${currentId}/contacts`),
          api.get(`/companies/${currentId}/items?usage=sales`),
          api.get(`/companies/${currentId}/taxes`),
          api.get(`/companies/${currentId}/accounts`),
        ]);
        if (cancelled) return;
        setContacts(c.data.contacts || []);
        setItemsCatalog(it.data.items || []);
        setTaxes(tx.data.taxes || []);
        setRevenueAccounts(
          ((ac.data.accounts || [])
            .filter(a => a.type === "revenue"))
            .sort((a, b) => (a.code || "").localeCompare(b.code || ""))
        );
        if (editMode) {
          const r = await api.get(`/companies/${currentId}/estimates/${id}`);
          if (cancelled) return;
          const inv = r.data.estimate;
          setNumber(inv.number || "");
          setContact(inv.contact_id || "");
          setIssue(inv.issue_date || iso(new Date()));
          setDue(inv.expiration_date || inv.due_date || addDays(iso(new Date()), 30));
          setPoNumber(inv.po_number || "");
          setTermsLabel(inv.terms || "Custom");
          setStatus(inv.status || "sent");
          const loadedLines = (inv.line_items || []).length
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
                // Preserve per-line sales tax across refresh — see
                // matching comment in InvoiceEditor.jsx.
                tax_id: l.tax_id || null,
                tax_name: l.tax_name || "",
                tax_rate: Number(l.tax_rate || 0),
                tax_amount: Number(l.tax_amount || 0),
              }))
            : [{ description: "", quantity: 1, rate: 0, amount: 0 }];
          setLines(loadedLines);
          // Peel the rolled-up line tax back off inv.tax so the
          // displayed / persisted total doesn't double on save.
          const lineTaxSum = loadedLines.reduce(
            (s, l) => s + Number(l.tax_amount || 0), 0
          );
          setTax(+(Number(inv.tax || 0) - lineTaxSum).toFixed(2));
          setShipping(Number(inv.shipping || 0));
          setDiscount(Number(inv.discount || 0));
          setDiscountType(inv.discount_type || "amount");
          setNotes(inv.notes || "");
          setInternalNotes(inv.internal_notes || "");
          setAttachments(inv.attachments || []);
          setTitle(inv.title || "");
          setSummary(inv.summary || "");
          setProjectLink({
            class_id: inv.class_id || null,
            project_id: inv.project_id || null,
            phase_id: inv.phase_id || null,
          });
        }
      } catch (e) {
        toast.error(e.response?.data?.detail || "Failed to load estimate");
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

  // In new-mode, pre-fill Project + Customer from ?project_id= query
  // OR the embed prop when rendered in a drawer.
  useEffect(() => {
    if (editMode) return;
    const preProject = preProjectFromQuery;
    const prePhase = embed?.phaseId;
    if (!preProject) return;
    (async () => {
      try {
        const r = await api.get(`/companies/${currentId}/projects`);
        const proj = (r.data?.projects || []).find(p => p.id === preProject);
        if (!proj) return;
        setProjectLink({
          class_id: null, project_id: proj.id, phase_id: prePhase || null,
        });
        if (proj.contact_id) setContact(proj.contact_id);
      } catch { /* silent */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, editMode]);

  // Line-level helpers.
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

  // Attachments (base64).
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

  // Company logo — uploads through PATCH /companies/{cid} and refreshes context.
  const onLogoUpload = async (file) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast.error("Logo must be under 5 MB"); return; }
    if (!/^image\//.test(file.type)) { toast.error("Please choose an image file"); return; }
    const dataUrl = await new Promise((res) => {
      const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file);
    });
    try {
      await api.patch(`/companies/${currentId}`, { logo_data_url: dataUrl });
      await refreshCompany();
      toast.success("Logo saved");
    } catch (e) { toast.error(e.response?.data?.detail || "Logo save failed"); }
  };
  const onLogoRemove = async () => {
    try {
      await api.patch(`/companies/${currentId}`, { logo_data_url: "" });
      await refreshCompany();
      toast.success("Logo removed");
    } catch (e) { toast.error(e.response?.data?.detail || "Remove failed"); }
  };

  const buildBody = () => {
    const c = contacts.find(x => x.id === contact);
    return {
      contact_id: contact || null,
      contact_name: c?.name || "",
      issue_date: issue,
      expiration_date: due,
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
      class_id: projectLink.class_id || null,
      project_id: projectLink.project_id || null,
      phase_id: projectLink.phase_id || null,
      ...(number ? { number: number.trim() } : {}),
    };
  };

  const save = async ({ silent = false } = {}) => {
    if (saving) return;
    setSaving(true);
    try {
      const body = buildBody();
      let iid = id;
      if (editMode) {
        const r = await api.patch(`/companies/${currentId}/estimates/${id}`, body);
        if (r.data?.number_conflict) toast.warning(`Heads up — another estimate already uses ${body.number}.`);
        else if (!silent) toast.success("Estimate saved");
      } else {
        const r = await api.post(`/companies/${currentId}/estimates`, body);
        iid = r.data.id;
        if (!silent) toast.success("Estimate created");
        if (embedded) embed?.onSaved?.(iid);
        else navigate(`/estimates/${iid}/edit`, { replace: true });
      }
      return iid;
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const goPreview = async () => {
    // Estimates have no PDF preview backend yet; keep it as a plain save.
    await save({ silent: false });
  };

  // "Apply tax to all lines" — set the same tax on every line item.
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

  if (loading) return <div className="p-8 text-slate-500">Loading estimate…</div>;

  return (
    <div className={embedded ? "space-y-4 pb-16" : "max-w-5xl mx-auto space-y-4 pb-16"}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {!embedded && (
            <button
              data-testid="invoice-editor-back"
              onClick={() => navigate("/estimates")}
              className="p-2 rounded-md hover:bg-slate-100 text-slate-600"
              title="Back to estimates"
            ><ArrowLeft size={16} /></button>
          )}
          <div className="min-w-0">
            <h1 className="font-heading text-2xl font-bold tracking-tight truncate">
              {editMode ? `Estimate ${number || ""}` : "New Estimate"}
            </h1>
            <p className="text-xs text-slate-500">
              {editMode ? `Status: ${status.toUpperCase()}` : "Draft — not yet saved"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            data-testid="invoice-editor-save"
            onClick={() => save()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50 shadow-sm"
          ><Save size={14} /> {saving ? "Saving…" : (editMode ? "Save changes" : "Save estimate")}</button>
        </div>
      </div>

      <BusinessHeaderCard
        company={current}
        title={title} setTitle={setTitle}
        summary={summary} setSummary={setSummary}
        onLogoUpload={onLogoUpload}
        onLogoRemove={onLogoRemove}
      />
      <ProjectPhaseClassPicker
        value={projectLink}
        onChange={(patch) => setProjectLink(prev => ({ ...prev, ...patch }))}
        contactId={contact}
        direction="customer"
      />
      <EditForm
        {...{
          contacts, setContacts, itemsCatalog, setItemsCatalog, taxes, setTaxes,
          contact, setContact,
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
          currentId,
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
            // Apply to the line that opened the modal.
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
// Business header — Wave-style collapsible card with logo + title/summary + biz info
// ─────────────────────────────────────────────────────────────────────────────
function BusinessHeaderCard({ company, title, setTitle, summary, setSummary, onLogoUpload, onLogoRemove }) {
  const [open, setOpen] = useState(true);
  const logo = company?.logo_data_url || "";
  const fileRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (e) => {
    e.preventDefault(); e.stopPropagation();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onLogoUpload(f);
  };

  return (
    <section className="rounded-lg border bg-white shadow-sm overflow-hidden" data-testid="invoice-editor-business-card">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
        data-testid="invoice-editor-business-toggle"
      >
        <span>Business address and contact details, title, summary, and logo</span>
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {open && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 px-4 pb-4">
          {/* Logo (left) */}
          <div>
            {logo ? (
              <div className="rounded-lg border bg-slate-50 p-4 flex flex-col items-start gap-3" data-testid="invoice-editor-logo-present">
                <img src={logo} alt="Company logo" className="max-h-24 max-w-full rounded" />
                <div className="flex items-center gap-3 text-xs">
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="inline-flex items-center gap-1 text-indigo-600 hover:underline"
                    data-testid="invoice-editor-logo-replace"
                  ><Upload size={12} /> Replace logo</button>
                  <button
                    onClick={onLogoRemove}
                    className="text-red-600 hover:underline"
                    data-testid="invoice-editor-logo-remove"
                  >Remove logo</button>
                </div>
              </div>
            ) : (
              <label
                htmlFor="invoice-logo-upload"
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                className={`block rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition ${
                  dragOver ? "border-indigo-400 bg-indigo-50" : "border-slate-300 bg-slate-50 hover:bg-slate-100"
                }`}
                data-testid="invoice-editor-logo-dropzone"
              >
                <div className="mx-auto w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center mb-2">
                  <Upload className="text-indigo-500" size={18} />
                </div>
                <div className="text-sm">
                  <span className="text-indigo-600 font-medium">Browse</span>
                  <span className="text-slate-500"> or drop your logo here</span>
                </div>
                <div className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                  Maximum 5 MB in size.<br/>
                  JPG, PNG, or GIF formats.<br/>
                  Recommended size: 300 x 200 pixels.
                </div>
              </label>
            )}
            <input
              id="invoice-logo-upload"
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onLogoUpload(f); e.target.value = ""; }}
              data-testid="invoice-editor-logo-input"
            />
          </div>

          {/* Title + summary + business info (right) */}
          <div className="flex flex-col gap-3">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Estimate"
              className="w-full text-right text-2xl font-heading font-semibold text-slate-800 border rounded px-3 py-2 focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
              data-testid="invoice-editor-title"
            />
            <input
              type="text"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Summary (e.g. project name, description of estimate)"
              className="w-full text-right text-sm text-slate-600 border rounded px-3 py-2 italic focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
              data-testid="invoice-editor-summary"
            />
            <div className="text-right text-sm text-slate-700 leading-relaxed">
              <div className="font-semibold text-slate-800">{company?.name || "Your Company"}</div>
              {company?.address && <div>{company.address}</div>}
              {company?.phone && <div>{company.phone}</div>}
              {company?.email && <div>{company.email}</div>}
              {company?.website && <div>{company.website}</div>}
              {company?.tax_id && <div>Tax ID: {company.tax_id}</div>}
              <Link
                to="/settings"
                className="inline-block text-xs text-indigo-600 hover:underline mt-1"
                data-testid="invoice-editor-edit-business-info"
              >Edit business info</Link>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main invoice form — customer/meta + line items + INLINE totals + notes
// ─────────────────────────────────────────────────────────────────────────────
function EditForm({
  contacts, setContacts, itemsCatalog, setItemsCatalog, taxes, setTaxes,
  contact, setContact,
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
  currentId,
  taxModalLineIdx, setTaxModalLineIdx,
  applyTaxToAllLines,
  editMode,
  docId,
}) {
  const fmtMoney = useMoneyFmt();
  const customerContacts = useMemo(
    () => contacts.filter(c => c.type === "customer" || c.type === "both"),
    [contacts]
  );
  const applyTaxToLine = (i, taxId) => {
    if (taxId === "__new__") { setTaxModalLineIdx(i); return; }
    if (!taxId) { updLine(i, { tax_id: null, tax_name: "", tax_rate: 0 }); return; }
    const t = taxes.find(x => x.id === taxId);
    if (!t) return;
    updLine(i, { tax_id: t.id, tax_name: t.name, tax_rate: Number(t.rate || 0) });
  };
  return (
    <section className="rounded-lg border bg-white shadow-xl overflow-hidden ring-1 ring-slate-100">
      {/* Top: customer + invoice meta grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 px-6 py-5">
        {/* Left — customer picker (searchable + inline-create) */}
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Customer</label>
          <ContactCombobox
            contacts={contacts}
            value={contact}
            onChange={setContact}
            onCreated={(c) => setContacts(prev => [...prev, c])}
            type="customer"
            currentId={currentId}
            testId="invoice-editor-customer"
          />
        </div>
        {/* Right — invoice meta */}
        <div className="space-y-2 text-sm">
          <MetaRow label="Estimate number">
            <input
              data-testid="invoice-editor-number"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="Auto-assigned"
              className="w-40 border rounded px-2 py-1 text-sm font-mono-num text-right"
            />
          </MetaRow>
          <MetaRow label="P.O./S.O. number">
            <input
              data-testid="invoice-editor-po"
              value={poNumber}
              onChange={(e) => setPoNumber(e.target.value)}
              className="w-40 border rounded px-2 py-1 text-sm font-mono-num text-right"
            />
          </MetaRow>
          <MetaRow label="Estimate date">
            <input
              data-testid="invoice-editor-issue"
              type="date"
              value={issue}
              onChange={(e) => setIssue(e.target.value)}
              className="w-40 border rounded px-2 py-1 text-sm"
            />
          </MetaRow>
          <MetaRow label="Expiration" hint={termsLabel !== "Custom" ? termsLabel : ""}>
            <div className="flex flex-col items-end gap-1">
              <input
                data-testid="invoice-editor-due"
                type="date"
                value={due}
                onChange={(e) => { setDue(e.target.value); setTermsLabel("Custom"); }}
                className="w-40 border rounded px-2 py-1 text-sm"
              />
              <select
                data-testid="invoice-editor-terms"
                value={termsLabel}
                onChange={(e) => setTermsLabel(e.target.value)}
                className="w-40 border rounded px-2 py-1 text-xs text-slate-600 bg-white"
              >
                {TERMS_OPTIONS.map(o => (
                  <option key={o.label} value={o.label}>{o.label}</option>
                ))}
              </select>
            </div>
          </MetaRow>
          <MetaRow label="Status">
            <select
              data-testid="invoice-editor-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-40 border rounded px-2 py-1 text-sm"
            >
              <option value="draft">Draft</option>
              <option value="sent">Sent</option>
              <option value="accepted">Accepted</option>
              <option value="rejected">Rejected</option>
              <option value="closed">Closed</option>
              <option value="converted">Converted</option>
            </select>
          </MetaRow>
        </div>
      </div>

      {/* Line items table */}
      <div className="px-6">
        <div className="border-t border-b bg-slate-50 grid grid-cols-12 gap-2 px-1 py-2 text-[10px] uppercase tracking-wide text-slate-500">
          <div className="col-span-6">Items</div>
          <div className="col-span-2 text-right">Quantity</div>
          <div className="col-span-2 text-right">Price</div>
          <div className="col-span-2 text-right">Amount</div>
        </div>
        <div className="divide-y">
          {lines.map((l, i) => (
            <div key={i} className="py-2" data-testid={`invoice-editor-line-${i}`}>
              <div className="grid grid-cols-12 gap-2 items-center">
                <div className="col-span-6">
                  <ItemPicker
                    items={itemsCatalog}
                    value={l.description}
                    usage="sales"
                    onChangeText={(txt) => updLine(i, { description: txt })}
                    onPickItem={(it) => {
                      const taxHit = it.tax_rate_id
                        ? (taxes || []).find(t => t.id === it.tax_rate_id)
                        : null;
                      updLine(i, {
                        item_id: it.id, item_name: it.name,
                        description: it.name,
                        rate: Number(it.price || 0),
                        income_account_id: it.income_account_id || null,
                        income_account_name: it.income_account_name || "",
                        category: it.income_account_name || "",
                        ...(taxHit ? {
                          tax_id:   taxHit.id,
                          tax_name: taxHit.name,
                          tax_rate: Number(taxHit.rate || 0),
                        } : {}),
                      });
                    }}
                    onItemCreated={(it) => setItemsCatalog && setItemsCatalog(prev => [...prev, it])}
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
              {/* Per-line Income Account + Tax selectors — QBO
                   parity: the income destination lives on the line,
                   defaulting from the picked item, override per-line. */}
              <div className="grid grid-cols-12 gap-2 items-center mt-1 pl-1">
                <div className="col-span-6 flex items-center gap-2">
                  <span className="text-xs text-slate-500 whitespace-nowrap">Income</span>
                  <select
                    value={l.income_account_id || ""}
                    onChange={(e) => {
                      const aid = e.target.value || null;
                      const hit = (revenueAccounts || []).find(a => a.id === aid);
                      updLine(i, {
                        income_account_id: aid,
                        income_account_name: hit?.name || "",
                        category: hit?.name || "",
                      });
                    }}
                    className="border rounded px-2 py-1 text-xs bg-white flex-1 min-w-0"
                    data-testid={`estimate-editor-line-${i}-income-acct`}
                  >
                    <option value="">Default revenue account</option>
                    {revenueAccounts.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.code ? `${a.code} · ` : ""}{a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-span-4 flex items-center justify-end gap-2">
                  <span className="text-xs text-slate-500">Tax</span>
                  <select
                    value={l.tax_id || ""}
                    onChange={(e) => applyTaxToLine(i, e.target.value)}
                    className="border rounded px-2 py-1 text-xs bg-white min-w-[160px]"
                    data-testid={`invoice-editor-line-${i}-tax`}
                  >
                    <option value="">Select a tax</option>
                    {taxes.map(t => (
                      <option key={t.id} value={t.id}>{t.name} · {Number(t.rate).toFixed(2)}%</option>
                    ))}
                    <option value="__new__">+ Create a new tax…</option>
                  </select>
                </div>
                <div className="col-span-2 text-right text-xs font-mono-num text-slate-500">
                  {Number(l.tax_rate || 0) > 0
                    ? fmtMoney(Number(l.amount || 0) * Number(l.tax_rate) / 100)
                    : "—"}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between">
          <button
            onClick={addLine}
            className="inline-flex items-center gap-1.5 text-xs text-indigo-600 hover:underline py-2"
            data-testid="invoice-editor-line-add"
          ><Plus size={12} /> Add an item</button>
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
                data-testid="invoice-editor-apply-tax-all"
              >
                <option value="" disabled>Choose tax…</option>
                {taxes.map(t => (
                  <option key={t.id} value={t.id}>{t.name} · {Number(t.rate).toFixed(2)}%</option>
                ))}
                <option value="__clear__">— clear —</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* INLINE totals — right-aligned block under the items table */}
      <div className="px-6 pb-5">
        <div className="ml-auto max-w-sm space-y-2 pt-3 border-t">
          <TotalsRow label="Subtotal" value={fmtMoney(totals.subtotal)} testId="invoice-editor-subtotal" />
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-slate-500">Discount</span>
            <div className="flex items-center gap-2">
              <input
                type="number" step="0.01" value={discount}
                onChange={(e) => setDiscount(e.target.value)}
                className="w-20 border rounded px-2 py-1 text-sm text-right font-mono-num"
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
          </div>
          {totals.discAmt > 0 && (
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>Discount applied</span>
              <span className="font-mono-num">−{fmtMoney(totals.discAmt)}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-slate-500">Shipping</span>
            <input
              type="number" step="0.01" value={shipping}
              onChange={(e) => setShipping(e.target.value)}
              className="w-28 border rounded px-2 py-1 text-sm text-right font-mono-num"
              data-testid="invoice-editor-shipping"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-slate-500">Tax {totals.lineTax > 0 && <span className="text-[10px] text-slate-400">(includes ${totals.lineTax.toFixed(2)} per-line)</span>}</span>
            <input
              type="number" step="0.01" value={tax}
              onChange={(e) => setTax(e.target.value)}
              className="w-28 border rounded px-2 py-1 text-sm text-right font-mono-num"
              data-testid="invoice-editor-tax"
            />
          </div>
          <div className="flex items-center justify-between pt-2 border-t">
            <span className="text-base font-semibold text-slate-800">Total</span>
            <span
              className="text-lg font-mono-num font-semibold text-slate-900"
              data-testid="invoice-editor-total"
            >{fmtMoney(totals.total)}</span>
          </div>
        </div>
      </div>

      {/* Notes / Terms + attachments */}
      <div className="px-6 py-5 border-t bg-slate-50/50 grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <div className="text-xs font-semibold text-slate-700 mb-1">Notes / Terms</div>
          <p className="text-[11px] text-slate-500 mb-2">Enter notes or terms of service that are visible to your customer</p>
          <textarea
            data-testid="invoice-editor-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="w-full border rounded px-2 py-1.5 text-sm bg-white"
            placeholder="Thanks for your business!"
          />
        </div>
        <div>
          <div className="text-xs font-semibold text-slate-700 mb-1">Internal notes</div>
          <p className="text-[11px] text-slate-500 mb-2">Private. Never shown on the PDF.</p>
          <textarea
            data-testid="invoice-editor-internal-notes"
            value={internalNotes}
            onChange={(e) => setInternalNotes(e.target.value)}
            rows={3}
            className="w-full border rounded px-2 py-1.5 text-sm bg-white"
            placeholder="For your team's eyes only."
          />
        </div>
        <div className="md:col-span-2">
          <div className="text-xs font-semibold text-slate-700 mb-1">Attachments</div>
          <input
            type="file"
            multiple
            onChange={(e) => onAttach(Array.from(e.target.files || []))}
            className="text-xs"
            data-testid="invoice-editor-attach"
          />
          {attachments.length > 0 && (
            <ul className="mt-2 divide-y border rounded bg-white">
              {attachments.map((a, i) => (
                <li key={i} className="flex items-center justify-between px-3 py-2 text-xs"
                    data-testid={`invoice-editor-attachment-${i}`}>
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
      </div>
    </section>
  );
}

function MetaRow({ label, hint, children }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="text-sm text-slate-500">
        {label}
        {hint && <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400">{hint}</span>}
      </div>
      {children}
    </div>
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
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to create tax");
    } finally { setSaving(false); }
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
            <label className="block text-sm text-slate-700 mb-1">
              Tax name <span className="text-red-500">*</span>
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. GST"
              className="w-full border rounded px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
              data-testid="create-tax-name"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">
              Tax rate <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <input
                type="number" step="0.01" min="0" max="100"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="0.00"
                className="w-full border rounded px-3 py-2 text-sm pr-8 focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
                data-testid="create-tax-rate"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">%</span>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 pt-3 border-t">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
          <button
            onClick={submit}
            disabled={saving || !name.trim() || rate === ""}
            className="px-4 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50"
            data-testid="create-tax-submit"
          >{saving ? "Saving…" : "Create tax"}</button>
        </div>
      </div>
    </div>
  );
}

