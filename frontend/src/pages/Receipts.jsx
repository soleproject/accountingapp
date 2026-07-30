import { useEffect, useRef, useState } from "react";
import { api, fmtMoney, fmtDate } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X, Paperclip, Loader2, FileText } from "lucide-react";
import { toast } from "sonner";

export default function Receipts() {
  const { currentId } = useCompany();
  const [items, setItems] = useState([]);
  const [accts, setAccts] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [creating, setCreating] = useState(false);
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
                  <td className="px-3 py-2 text-right"><button onClick={() => del(r.id)} className="text-red-500 p-1"><Trash2 size={13} /></button></td>
                </tr>
              );
            })}
            {!items.length && <tr><td colSpan={7} className="text-center py-8 text-slate-500">No receipts.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && <RecModal currentId={currentId} accts={accts} contacts={contacts} onClose={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function RecModal({ currentId, accts, contacts, onClose }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [contactId, setContactId] = useState("");
  const [amount, setAmount] = useState("");
  const [cat, setCat] = useState("");
  const [payAcct, setPayAcct] = useState("");
  const [notes, setNotes] = useState("");
  const [attachment, setAttachment] = useState(null); // {data_url, filename, size}
  const [busy, setBusy] = useState(false);
  const [addingVendor, setAddingVendor] = useState(false);
  const [newVendorName, setNewVendorName] = useState("");
  const [creatingVendor, setCreatingVendor] = useState(false);
  const fileRef = useRef(null);

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
    reader.onload = () => setAttachment({ data_url: reader.result, filename: f.name, size: f.size });
    reader.readAsDataURL(f);
  };

  const save = async () => {
    const c = contacts.find(x => x.id === contactId);
    if (!c || !amount) { toast.error("Vendor and amount are required."); return; }
    setBusy(true);
    try {
      await api.post(`/companies/${currentId}/receipts`, {
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
      });
      toast.success("Receipt saved");
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold">New Receipt</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
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
          <select value={cat} onChange={(e) => setCat(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm bg-white">
            <option value="">— Category —</option>
            {accts.filter(a => a.type === "expense").map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </select>
        </div>

        <input placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm" />

        {/* Receipt attachment — image or PDF. Stored as a data URL on
            the receipt doc so it renders inline without a separate
            file service. Capped at 8 MB. */}
        <div className="rounded-md border border-dashed border-slate-300 p-3">
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1.5">Receipt image / PDF</label>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,.pdf"
            className="hidden"
            onChange={(e) => onPickFile(e.target.files?.[0])}
            data-testid="receipt-file-input"
          />
          {attachment ? (
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
              <button onClick={() => setAttachment(null)} className="text-rose-600 hover:bg-rose-50 rounded p-1"><X size={12} /></button>
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
          Save receipt
        </button>
      </div>
    </div>
  );
}
