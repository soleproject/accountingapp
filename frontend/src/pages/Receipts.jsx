import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useCompany, useMoneyFmt, useDateFmt } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X, Paperclip, Loader2, FileText, Pencil, Sparkles, Camera, Upload } from "lucide-react";
import { toast } from "sonner";
import SearchableAccountPicker from "@/components/SearchableAccountPicker";

export default function Receipts() {

  const fmtMoney = useMoneyFmt();

  const fmtDate = useDateFmt();
  const { currentId } = useCompany();
  const [items, setItems] = useState([]);
  const [accts, setAccts] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null); // receipt object being edited
  const load = async () => {
    if (!currentId) return;
    const [r, a, c] = await Promise.all([
      api.get(`/companies/${currentId}/receipts`),
      api.get(`/companies/${currentId}/accounts`),
      api.get(`/companies/${currentId}/contacts`),
    ]);
    setItems(r.data.receipts || []);
    setAccts(a.data.accounts || []);
    setContacts(c.data.contacts || []);
  };
  useEffect(() => { load(); }, [currentId]);
  const del = async (id) => { if (confirm("Delete?")) { await api.delete(`/companies/${currentId}/receipts/${id}`); load(); } };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Receipts</h1>
          <p className="text-slate-500 text-sm mt-1">Cash / card expense receipts.</p>
        </div>
        <button data-testid={TID.addBtn} onClick={() => setCreating(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
          <Plus size={13} /> New Receipt
        </button>
      </div>
      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-left">Merchant</th>
              <th className="px-3 py-2 text-left">Paid from</th>
              <th className="px-3 py-2 text-left">Notes</th>
              <th className="px-3 py-2 text-center">Receipt</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map(r => {
              const pay = accts.find(a => a.id === r.payment_account_id);
              return (
                <tr key={r.id} className="border-b hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono-num text-slate-500">{fmtDate(r.date)}</td>
                  <td className="px-3 py-2">{r.merchant}</td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {pay ? `${pay.code} ${pay.name}` : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{r.notes}</td>
                  <td className="px-3 py-2 text-center">
                    {r.attachment_data_url ? (
                      <a href={r.attachment_data_url} target="_blank" rel="noreferrer"
                         className="text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-1 text-xs"
                         title={r.attachment_filename || "View receipt"}>
                        <Paperclip size={12} /> View
                      </a>
                    ) : <span className="text-slate-300 text-xs">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(r.amount)}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => setEditing(r)}
                      className="text-slate-500 hover:text-slate-800 p-1"
                      title="Edit"
                      data-testid={`receipt-edit-${r.id}`}
                    >
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => del(r.id)} className="text-red-500 p-1" title="Delete"><Trash2 size={13} /></button>
                  </td>
                </tr>
              );
            })}
            {!items.length && <tr><td colSpan={7} className="text-center py-8 text-slate-500">No receipts.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && <RecModal currentId={currentId} accts={accts} contacts={contacts} onClose={() => { setCreating(false); load(); }} />}
      {editing && <RecModal currentId={currentId} accts={accts} contacts={contacts} initial={editing} onClose={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function RecModal({ currentId, accts, contacts, initial, onClose }) {
  const isEdit = !!initial;
  const [date, setDate] = useState(initial?.date || new Date().toISOString().slice(0, 10));
  const [contactId, setContactId] = useState(initial?.contact_id || "");
  const [amount, setAmount] = useState(initial?.amount != null ? String(initial.amount) : "");
  const [cat, setCat] = useState(initial?.category_account_id || "");
  const [payAcct, setPayAcct] = useState(initial?.payment_account_id || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [attachment, setAttachment] = useState(
    initial?.attachment_data_url
      ? { data_url: initial.attachment_data_url, filename: initial.attachment_filename || "receipt", size: 0 }
      : null
  );
  const [busy, setBusy] = useState(false);
  const [addingVendor, setAddingVendor] = useState(false);
  const [newVendorName, setNewVendorName] = useState("");
  const [creatingVendor, setCreatingVendor] = useState(false);
  const fileRef = useRef(null);
  // ── AI receipt-split vision (GPT-4o) ─────────────────────────
  // After an attachment is picked, the user can tap "Scan receipt"
  // to run GPT-4o vision. The AI reads each line item, marks it
  // business or personal for this company's industry, and returns
  // a proposed split. Users can flip any line business↔personal
  // before applying. Applying the split fills the amount + category
  // fields with the business subtotal, and appends the breakdown
  // to notes so the pro can audit later.
  const [scanning, setScanning] = useState(false);
  const [analysis, setAnalysis] = useState(null);   // full GPT-4o payload
  const [lineItems, setLineItems] = useState([]);    // editable working copy
  // Mode toggle at the top of the modal. "manual" shows the classic
  // full form; "ai" shows a big Take-photo / Upload-photo landing
  // page — after a scan lands we auto-populate the same fields and
  // reveal them for a quick review-and-save.
  //
  // Preference is persisted in localStorage so a bookkeeper who
  // consistently uses one flow doesn't have to re-toggle every time
  // they log a receipt. Editing is always manual — a persisted "ai"
  // preference doesn't override the edit path.
  const [mode, setMode] = useState(() => {
    if (initial) return "manual";
    try {
      const saved = localStorage.getItem("receipt_modal_mode");
      return saved === "ai" || saved === "manual" ? saved : "manual";
    } catch { return "manual"; }
  });
  useEffect(() => {
    if (isEdit) return;
    try { localStorage.setItem("receipt_modal_mode", mode); } catch { /* quota / ssr */ }
  }, [mode, isEdit]);
  const cameraRef = useRef(null);
  // When we auto-scan after an AI-mode pick, `setAttachment` from
  // inside FileReader.onload hasn't committed to React state by the
  // time `runScan` runs synchronously — so `runScan` reads the stale
  // empty attachment and toasts "Attach a receipt first". We flip
  // this flag inside onPickFile and a useEffect watches (attachment,
  // pendingAutoScan) to fire the scan on the next render, after the
  // state has definitively committed.
  const [pendingAutoScan, setPendingAutoScan] = useState(false);
  useEffect(() => {
    if (!pendingAutoScan) return;
    if (!attachment?.data_url) return;
    setPendingAutoScan(false);
    runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoScan, attachment?.data_url]);

  const flipLine = (idx) => {
    setLineItems((prev) => prev.map((it, i) => {
      if (i !== idx) return it;
      const k = (it.kind || "unknown").toLowerCase();
      if (k !== "business" && k !== "personal") return it;
      return { ...it, kind: k === "business" ? "personal" : "business" };
    }));
  };

  const runScan = async () => {
    if (!attachment?.data_url) {
      toast.error("Attach a receipt first."); return;
    }
    setScanning(true);
    try {
      const r = await api.post(`/companies/${currentId}/receipts/analyze`, {
        attachment_data_url: attachment.data_url,
        amount: amount ? parseFloat(amount) : null,
        merchant: (contacts.find((x) => x.id === contactId) || {}).name || null,
      });
      const a = r.data?.analysis;
      if (!a) {
        toast.error("Couldn't read that receipt. Try a sharper photo.");
        return;
      }
      setAnalysis(a);
      setLineItems((a.line_items || []).map((x, i) => ({ ...x, _idx: i })));

      // Auto-populate top-level fields from what the AI read on the
      // receipt so the user doesn't retype what's already visible.
      // Everything remains editable — this is a suggestion, not a
      // lock. `analyze_receipt_for_split` returns `vendor`, `date`,
      // and `totals.grand_total` per the prompt schema.
      const grandTotal = Number(a?.totals?.grand_total || 0);
      if (grandTotal > 0 && !amount) setAmount(grandTotal.toFixed(2));
      if (a?.date && /^\d{4}-\d{2}-\d{2}$/.test(a.date)) setDate(a.date);
      if (a?.vendor && !contactId) {
        // Try to match the AI-detected vendor to an existing contact
        // (case-insensitive substring). If none matches, leave the
        // "Pick vendor" empty so the user can Add-new-vendor in one
        // click without accidentally posting to a wrong contact.
        const v = String(a.vendor).trim().toLowerCase();
        const hit = contacts.find(
          (c) => c.name && c.name.toLowerCase().includes(v),
        ) || contacts.find(
          (c) => c.name && v.includes(c.name.toLowerCase()),
        );
        if (hit) setContactId(hit.id);
        else {
          // Seed the "add vendor" flow so the user just hits Save.
          setAddingVendor(true);
          setNewVendorName(a.vendor);
        }
      }
      // Flip to manual view so the user can review + save what the
      // AI extracted. The scan preview lives inline below the
      // Attach section as usual.
      setMode("manual");
      toast.success("Receipt scanned — review the details and save.");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Scan failed.");
    } finally {
      setScanning(false);
    }
  };

  // Live totals from the editable line items.
  const money = (n) => `$${(Number(n) || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
  const bizTotal = lineItems.filter((x) => x.kind === "business")
    .reduce((s, x) => s + Math.abs(Number(x.amount || 0)), 0);
  const perTotal = lineItems.filter((x) => x.kind === "personal")
    .reduce((s, x) => s + Math.abs(Number(x.amount || 0)), 0);
  const otherTotal = lineItems.filter((x) => !["business", "personal"].includes(x.kind))
    .reduce((s, x) => s + Math.abs(Number(x.amount || 0)), 0);
  const base = bizTotal + perTotal || 1;
  const bizFinal = Math.round((bizTotal + otherTotal * (bizTotal / base)) * 100) / 100;
  const perFinal = Math.round((perTotal + otherTotal * (perTotal / base)) * 100) / 100;

  const applySplit = () => {
    if (!analysis) return;
    // Fill amount with the business subtotal — the personal chunk is
    // an owner's draw / non-business and is dropped from the receipt.
    setAmount(String(bizFinal.toFixed(2)));
    // Append the AI's read to notes so the pro (and audit trail)
    // sees exactly what was extracted.
    const bizLines = lineItems.filter((x) => x.kind === "business")
      .map((x) => `${x.description} $${Number(x.amount || 0).toFixed(2)}`);
    const perLines = lineItems.filter((x) => x.kind === "personal")
      .map((x) => `${x.description} $${Number(x.amount || 0).toFixed(2)}`);
    const parts = [];
    parts.push(`AI split — Business ${money(bizFinal)} · Personal ${money(perFinal)}`);
    if (bizLines.length) parts.push(`Business: ${bizLines.join("; ")}`);
    if (perLines.length) parts.push(`Personal (owner draw): ${perLines.join("; ")}`);
    const stamped = parts.join("\n");
    setNotes((prev) => prev ? `${prev}\n${stamped}` : stamped);
    toast.success(`Amount set to ${money(bizFinal)} (business portion).`);
  };

  // Vendors first, then any other contacts as a fallback so users can
  // still pick e.g. an employee reimbursement recipient. Sorted alpha
  // for consistent scanability.
  const vendors = contacts
    .filter(c => c.type === "vendor")
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const otherContacts = contacts
    .filter(c => c.type !== "vendor")
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const createVendor = async () => {
    const nm = newVendorName.trim();
    if (!nm) { toast.error("Vendor name is required."); return; }
    setCreatingVendor(true);
    try {
      const r = await api.post(`/companies/${currentId}/contacts`, { name: nm, type: "vendor" });
      const newId = r.data?.id;
      // Optimistically add so the picker updates immediately without a
      // full parent reload (parent reloads on close anyway).
      contacts.push({ id: newId, name: nm, type: "vendor" });
      setContactId(newId);
      setAddingVendor(false);
      setNewVendorName("");
      toast.success(`Vendor "${nm}" added`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not add vendor.");
    } finally { setCreatingVendor(false); }
  };

  // Accounts eligible as a "paid from" source — true payment instruments
  // only (bank, cash-on-hand, credit card). Excludes A/R, Inventory,
  // Prepaids, A/P, Sales Tax Payable which are NOT payment sources.
  // Match by explicit subtype OR by name pattern (bank / checking /
  // savings / cash / credit card) for CoAs without subtype tagging.
  const NAME_RE = /(bank|checking|savings|cash on hand|petty cash|credit card|amex|visa|mastercard)/i;
  const paySource = accts.filter(a => {
    if (a.subtype === "cash" || a.subtype === "credit_card") return true;
    if (a.type === "asset" && NAME_RE.test(a.name)) return true;
    if (a.type === "liability" && NAME_RE.test(a.name)) return true;
    return false;
  });
  const paymentOptions = paySource;

  const onPickFile = (f) => {
    if (!f) return;
    // Guard the raw size AND the base64-encoded size (~4/3 larger).
    // Warn near 6 MB raw so the encoded payload stays under typical
    // 10 MB proxy limits.
    if (f.size > 6 * 1024 * 1024) {
      toast.error("Attachment too large. Max 6 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setAttachment({ data_url: reader.result, filename: f.name, size: f.size });
      // New file → drop any prior AI read so the user can rescan.
      setAnalysis(null);
      setLineItems([]);
    };
    reader.readAsDataURL(f);
  };

  const save = async () => {
    const c = contacts.find(x => x.id === contactId);
    if (!c || !amount) { toast.error("Vendor and amount are required."); return; }
    setBusy(true);
    try {
      const payload = {
        date,
        merchant: c.name,
        contact_id: c.id,
        contact_name: c.name,
        amount: parseFloat(amount),
        category_account_id: cat || null,
        payment_account_id: payAcct || null,
        notes,
        attachment_data_url: attachment?.data_url || null,
        attachment_filename: attachment?.filename || null,
      };
      if (isEdit) {
        await api.patch(`/companies/${currentId}/receipts/${initial.id}`, payload);
        toast.success("Receipt updated");
      } else {
        await api.post(`/companies/${currentId}/receipts`, payload);
        toast.success("Receipt saved");
      }
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold">{isEdit ? "Edit Receipt" : "New Receipt"}</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>

        {/* Mode toggle — AI vs Manual entry. AI-first shows a big
            "take a picture / upload a picture" landing that runs
            GPT-4o vision (same model + endpoint as the Quick
            Check-in flow) and auto-populates the manual form on
            successful scan. Manual shows the classic full form.
            Hidden on Edit — editing is always manual. */}
        {!isEdit && (
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1" role="tablist">
            <button
              type="button"
              onClick={() => setMode("ai")}
              className={`flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-semibold transition ${
                mode === "ai" ? "bg-white shadow text-indigo-700" : "text-slate-500 hover:text-slate-800"
              }`}
              data-testid="receipt-mode-ai"
            >
              <Sparkles size={12} /> AI
            </button>
            <button
              type="button"
              onClick={() => setMode("manual")}
              className={`flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-semibold transition ${
                mode === "manual" ? "bg-white shadow text-slate-900" : "text-slate-500 hover:text-slate-800"
              }`}
              data-testid="receipt-mode-manual"
            >
              Manual
            </button>
          </div>
        )}

        {/* Shared hidden file input — must live OUTSIDE the mode
            branch so the AI-mode "Upload a photo" button (which
            triggers `fileRef.current.click()`) still fires when
            fileRef is unmounted from the manual form. */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*,.pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const wasAiMode = mode === "ai";
            onPickFile(f);
            // Wait for the attachment state to commit before firing
            // the scan (see `pendingAutoScan` above).
            if (wasAiMode) setPendingAutoScan(true);
          }}
          data-testid="receipt-file-input"
        />

        {mode === "ai" && !isEdit ? (
          /* AI-first landing — two big CTAs. Camera capture uses the
             device camera on mobile (falls back to picker on
             desktop). Upload opens the standard file dialog. Both
             paths funnel into `onPickFile` which stashes the base64
             image; then `runScan` fires the same
             /receipts/analyze endpoint the manual mode uses. */
          <div className="py-6 space-y-3 text-center" data-testid="receipt-ai-landing">
            <div className="text-sm text-slate-600 leading-relaxed">
              Snap or upload a receipt — I'll read the merchant, date,
              amount and category and fill this in for you.
            </div>
            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={() => cameraRef.current?.click()}
                disabled={scanning}
                className="rounded-xl border-2 border-dashed border-indigo-200 bg-indigo-50 hover:bg-indigo-100 py-8 px-4 text-indigo-800 font-semibold text-base inline-flex items-center justify-center gap-3 disabled:opacity-60"
                data-testid="receipt-ai-camera"
              >
                <Camera size={28} />
                Take a photo
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={scanning}
                className="rounded-xl border-2 border-dashed border-slate-200 bg-white hover:bg-slate-50 py-8 px-4 text-slate-800 font-semibold text-base inline-flex items-center justify-center gap-3 disabled:opacity-60"
                data-testid="receipt-ai-upload"
              >
                <Upload size={28} />
                Upload a photo
              </button>
            </div>
            {scanning && (
              <div className="pt-2 text-xs text-indigo-700 inline-flex items-center gap-1.5 justify-center">
                <Loader2 size={12} className="animate-spin" /> Scanning receipt with AI…
              </div>
            )}
            <div className="text-[11px] text-slate-400 pt-1">
              Uses GPT-4o vision — same engine as Quick Check-in.
            </div>
            {/* Hidden pickers driven by the two big buttons. `capture`
                nudges mobile browsers to open the camera; on desktop
                it silently falls back to the standard file picker. */}
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                onPickFile(f);
                setPendingAutoScan(true);
              }}
              className="hidden"
            />
          </div>
        ) : null}

        {mode === "manual" || isEdit ? (
        <>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm" />

        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Vendor</label>
          {addingVendor ? (
            <div className="flex gap-1.5">
              <input
                autoFocus
                placeholder="New vendor name"
                value={newVendorName}
                onChange={(e) => setNewVendorName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") createVendor(); if (e.key === "Escape") { setAddingVendor(false); setNewVendorName(""); } }}
                className="flex-1 border rounded px-2 py-1.5 text-sm"
                data-testid="receipt-new-vendor-input"
              />
              <button
                type="button"
                onClick={createVendor}
                disabled={creatingVendor}
                className="px-3 py-1.5 rounded bg-slate-900 text-white text-xs inline-flex items-center gap-1 disabled:opacity-60"
                data-testid="receipt-new-vendor-save"
              >
                {creatingVendor && <Loader2 size={12} className="animate-spin" />}
                Add
              </button>
              <button
                type="button"
                onClick={() => { setAddingVendor(false); setNewVendorName(""); }}
                className="px-2 py-1.5 rounded border text-xs"
                data-testid="receipt-new-vendor-cancel"
              >
                Cancel
              </button>
            </div>
          ) : (
            <select
              value={contactId}
              onChange={(e) => {
                if (e.target.value === "__add__") { setAddingVendor(true); return; }
                setContactId(e.target.value);
              }}
              className="w-full border rounded px-2 py-1.5 text-sm bg-white"
              data-testid="receipt-vendor-select"
            >
              <option value="">— Pick vendor —</option>
              {vendors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              {otherContacts.length > 0 && (
                <optgroup label="Other contacts">
                  {otherContacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              )}
              <option value="__add__">+ Add new vendor…</option>
            </select>
          )}
        </div>

        <input type="number" step="0.01" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm font-mono-num" />

        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Paid from</label>
          <select
            value={payAcct}
            onChange={(e) => setPayAcct(e.target.value)}
            className="w-full border rounded px-2 py-1.5 text-sm bg-white"
            data-testid="receipt-payment-account"
          >
            <option value="">— Pick bank / credit card / cash —</option>
            {paymentOptions.map(a => (
              <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Category (expense)</label>
          <SearchableAccountPicker
            value={cat || null}
            onChange={(id) => setCat(id || "")}
            accounts={accts.filter(a => a.type === "expense")}
            allAccounts={accts}
            placeholder="— Category —"
            kindLabel="expense"
            newDefaults={{ type: "expense" }}
            currentId={currentId}
            onCreated={(acct) => {
              if (!acct?.id) return;
              // Fold the freshly-created account into the local list
              // so it shows up on subsequent receipts without a page
              // reload, and auto-select it on this receipt.
              accts.push(acct);
              setCat(acct.id);
            }}
            testId="receipt-category"
          />
        </div>

        <input placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm" />

        {/* Receipt attachment — image or PDF. Stored as a data URL on
            the receipt doc so it renders inline without a separate
            file service. Capped at 8 MB. */}
        <div className="rounded-md border border-dashed border-slate-300 p-3">
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1.5">Receipt image / PDF</label>
          {attachment ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs">
                {attachment.data_url?.startsWith("data:image/") ? (
                  <img src={attachment.data_url} alt="preview" className="w-12 h-12 object-cover rounded border" />
                ) : (
                  <div className="w-12 h-12 rounded border bg-slate-50 flex items-center justify-center"><FileText size={16} className="text-slate-400" /></div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium text-slate-800">{attachment.filename}</div>
                  <div className="text-slate-500">{(attachment.size / 1024).toFixed(1)} KB</div>
                </div>
                <button
                  onClick={() => { setAttachment(null); setAnalysis(null); setLineItems([]); }}
                  className="text-rose-600 hover:bg-rose-50 rounded p-1"
                  title="Remove"
                  data-testid="receipt-attach-remove"
                ><X size={12} /></button>
              </div>
              {!analysis && attachment.data_url?.startsWith("data:image/") && (
                <button
                  type="button"
                  onClick={runScan}
                  disabled={scanning}
                  className="w-full py-2 rounded border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 text-xs text-indigo-700 inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
                  data-testid="receipt-scan-btn"
                >
                  {scanning
                    ? <><Loader2 size={12} className="animate-spin" /> Scanning receipt with AI…</>
                    : <><Sparkles size={12} /> Scan receipt for line-item split (AI)</>}
                </button>
              )}
              {analysis && (
                <ReceiptSplitPreview
                  narrative={analysis.narrative}
                  lineItems={lineItems}
                  bizTotal={bizFinal}
                  perTotal={perFinal}
                  onFlip={flipLine}
                  onApply={applySplit}
                  onRescan={() => { setAnalysis(null); setLineItems([]); runScan(); }}
                />
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-full py-2 rounded border border-slate-200 bg-white hover:bg-slate-50 text-xs text-slate-700 inline-flex items-center justify-center gap-1.5"
              data-testid="receipt-attach-btn"
            >
              <Paperclip size={12} /> Attach receipt (image or PDF, max 6 MB)
            </button>
          )}
        </div>

        <button
          data-testid={TID.saveBtn}
          onClick={save}
          disabled={busy}
          className="w-full py-2 rounded-md bg-slate-900 text-white text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          {isEdit ? "Update receipt" : "Save receipt"}
        </button>
        </>
        ) : null}
      </div>
    </div>
  );
}


function ReceiptSplitPreview({ narrative, lineItems, bizTotal, perTotal, onFlip, onApply, onRescan }) {
  // Renders the GPT-4o vision breakdown with editable business ↔
  // personal toggles. Mirrors the shape of the client-review page's
  // SplitBreakdown so the pro-side and client-side stay consistent.
  const money = (n) => `$${(Number(n) || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
  const groups = { business: [], personal: [], tax: [], shipping: [], unknown: [] };
  lineItems.forEach((it, i) => {
    const k = (it.kind || "unknown").toLowerCase();
    (groups[k] || groups.unknown).push({ ...it, _idx: i });
  });
  const groupStyle = {
    business: { label: "Business", bg: "bg-emerald-50",  text: "text-emerald-700", border: "border-emerald-200" },
    personal: { label: "Personal", bg: "bg-slate-50",   text: "text-slate-700",   border: "border-slate-200" },
    tax:      { label: "Tax",      bg: "bg-blue-50",    text: "text-blue-700",    border: "border-blue-200" },
    shipping: { label: "Shipping", bg: "bg-blue-50",    text: "text-blue-700",    border: "border-blue-200" },
    unknown:  { label: "Unclear",  bg: "bg-amber-50",   text: "text-amber-700",   border: "border-amber-200" },
  };
  return (
    <div className="mt-2 space-y-2 max-h-72 overflow-y-auto" data-testid="receipt-split-preview">
      {narrative && (
        <div className="text-[11px] text-slate-600 italic px-1">
          {narrative}
        </div>
      )}
      <div className="text-[11px] text-slate-500 italic px-1">
        Tap a line to flip it between business and personal.
      </div>
      {["business", "personal", "tax", "shipping", "unknown"].map((k) => {
        const group = groups[k];
        if (!group || group.length === 0) return null;
        const style = groupStyle[k];
        const subtotal = group.reduce((s, x) => s + Math.abs(Number(x.amount || 0)), 0);
        return (
          <div key={k} className={`rounded-lg border ${style.border} ${style.bg} p-2`}>
            <div className={`flex items-center justify-between mb-1 text-[11px] font-semibold uppercase tracking-wide ${style.text}`}>
              <span>{style.label} · {group.length} item{group.length === 1 ? "" : "s"}</span>
              <span className="font-mono-num tabular-nums">{money(subtotal)}</span>
            </div>
            <div className="space-y-0.5">
              {group.map((it) => (
                <button
                  type="button"
                  key={it._idx}
                  onClick={() => (k === "business" || k === "personal") && onFlip(it._idx)}
                  disabled={k !== "business" && k !== "personal"}
                  className={`w-full text-left flex items-center justify-between text-[12px] rounded px-1 py-0.5 ${
                    (k === "business" || k === "personal")
                      ? "text-slate-700 hover:bg-white/60 cursor-pointer"
                      : "text-slate-500 cursor-default"
                  }`}
                  data-testid={`receipt-scan-line-${it._idx}`}
                >
                  <span className="truncate pr-2">{it.description}</span>
                  <span className="font-mono-num tabular-nums text-slate-500 shrink-0">
                    {money(it.amount)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <div className="rounded-lg border border-slate-300 bg-white p-2">
        <div className="flex items-center justify-between text-sm text-slate-800">
          <span>Business subtotal</span>
          <span className="font-mono-num tabular-nums font-semibold">{money(bizTotal)}</span>
        </div>
        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>Personal (owner draw)</span>
          <span className="font-mono-num tabular-nums">{money(perTotal)}</span>
        </div>
      </div>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={onApply}
          className="flex-1 py-1.5 rounded-md bg-slate-900 text-white text-xs inline-flex items-center justify-center gap-1"
          data-testid="receipt-scan-apply"
        >
          Use business subtotal ({money(bizTotal)})
        </button>
        <button
          type="button"
          onClick={onRescan}
          className="px-2 py-1.5 rounded-md border border-slate-300 text-xs text-slate-700"
          data-testid="receipt-scan-rescan"
        >
          Rescan
        </button>
      </div>
    </div>
  );
}
