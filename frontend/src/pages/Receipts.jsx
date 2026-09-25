import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useCompany, useMoneyFmt, useDateFmt } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X, Paperclip, Loader2, FileText, Pencil, Sparkles, Camera, Upload, Mic, Square, ArrowLeft, StickyNote, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import SearchableAccountPicker from "@/components/SearchableAccountPicker";
import useVoiceRecorder from "@/hooks/useVoiceRecorder";

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
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-800">{r.merchant}</div>
                    {r.ai_narrative && (
                      <div
                        className="text-[11px] text-slate-500 italic leading-snug mt-0.5 line-clamp-2"
                        title={r.ai_narrative}
                        data-testid={`receipt-narrative-${r.id}`}
                      >
                        {r.ai_narrative}
                      </div>
                    )}
                  </td>
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

  // ── Compact "review card" state (AI Phase 2 only) ─────────────
  // After a scan lands, the AI-mode modal collapses the four small
  // header fields (date / vendor / amount / paid from) into a single
  // clickable summary pill so the line-item breakdown has room to
  // breathe. Tapping the pill opens an inline editor. Notes get their
  // own dedicated sub-screen with a big mic button for voice dictation
  // via Whisper (`/api/reviewv2/transcribe`).
  const [pillOpen, setPillOpen]         = useState(false);
  const [noteView, setNoteView]         = useState(false);
  const [noteDraft, setNoteDraft]       = useState(initial?.notes || "");
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError]     = useState(null);

  // Whenever the user enters the note screen, seed the draft from the
  // current notes so cancelling discards the in-progress edit cleanly.
  useEffect(() => {
    if (noteView) {
      setNoteDraft(notes || "");
      setVoiceError(null);
    }
  }, [noteView]); // eslint-disable-line react-hooks/exhaustive-deps

  const onNoteAudio = async (blob) => {
    setTranscribing(true);
    setVoiceError(null);
    try {
      const fd = new FormData();
      fd.append("audio", blob, "note.webm");
      const r = await api.post(`/reviewv2/transcribe`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const text = (r.data?.text || "").trim();
      if (!text) {
        setVoiceError("Didn't catch that. Try again.");
        return;
      }
      // Smart insert: replace when the draft is empty, append with a
      // space when it already has content so dictated additions don't
      // clobber typed notes.
      setNoteDraft((prev) => {
        const p = (prev || "").trim();
        return p ? `${p} ${text}` : text;
      });
    } catch (e) {
      setVoiceError(e.response?.data?.detail || "Transcription failed.");
    } finally {
      setTranscribing(false);
    }
  };
  const voice = useVoiceRecorder(onNoteAudio);

  // ── Drill-into-a-category state (AI Phase 2 only) ─────────────
  // Users can tap any category bubble on the review card to open a
  // dedicated screen where they see every line item in that group,
  // re-categorize items individually, or bulk-move them via checkbox
  // mode. Edits live on `editedLines` (a full working copy of the AI
  // extracted line-items with resolved CoA ids), and are persisted
  // onto the receipt at save-time so the JE splits into one credit
  // line per unique account.
  const [drillKey, setDrillKey]             = useState(null);
  const [editedLines, setEditedLines]       = useState(null);
  const [checkboxMode, setCheckboxMode]     = useState(false);
  const [selectedIdxs, setSelectedIdxs]     = useState(() => new Set());
  const [bulkAccountId, setBulkAccountId]   = useState("");

  // Whenever a fresh scan lands, seed the editable working copy from
  // the categorization arm (preferred — has account_code + name per
  // line) with an eager CoA lookup so per-line pickers show a
  // resolved account rather than "Uncategorized".
  useEffect(() => {
    if (!analysis) { setEditedLines(null); return; }
    const src = analysis?.categorization?.line_items?.length
      ? analysis.categorization.line_items
      : (analysis?.line_items || []);
    setEditedLines(src.map((x, i) => {
      // Backend's curated resolver already returns a real `account_id`
      // (may point at an auto-created account not in the local accts
      // list yet). Trust it as the source of truth; only fall back to
      // a local lookup by code/name for legacy scans without the
      // resolver's stamps.
      const local = accts.find(
        (a) => (a.id && x.account_id && a.id === x.account_id)
            || (x.account_code && a.code === x.account_code)
            || (x.account_name && a.name
                && a.name.toLowerCase() === String(x.account_name).toLowerCase()),
      );
      return {
        description:  x.description || "",
        amount:       Number(x.amount || 0),
        account_code: local?.code || x.account_code || "",
        account_name: local?.name || x.account_name || "Uncategorized",
        account_id:   x.account_id || local?.id || null,
        _idx:         i,
      };
    }));
  }, [analysis, accts]);

  const setLineAccount = (idx, accountId) => {
    const hit = accts.find((a) => a.id === accountId);
    setEditedLines((prev) => (prev || []).map((l) => l._idx === idx ? {
      ...l,
      account_id:   accountId || null,
      account_code: hit?.code || "",
      account_name: hit?.name || l.account_name,
    } : l));
  };

  const applyBulk = () => {
    if (!bulkAccountId || !editedLines) return;
    const hit = accts.find((a) => a.id === bulkAccountId);
    if (!hit) return;
    const groupLines = editedLines.filter(
      (l) => `${l.account_code || ""}|${l.account_name}` === drillKey,
    );
    const targetIdxs = checkboxMode
      ? new Set(groupLines.filter((l) => selectedIdxs.has(l._idx)).map((l) => l._idx))
      : new Set(groupLines.map((l) => l._idx));
    if (targetIdxs.size === 0) {
      toast.error(checkboxMode ? "Nothing selected." : "No items to move.");
      return;
    }
    setEditedLines((prev) => (prev || []).map((l) => targetIdxs.has(l._idx) ? {
      ...l,
      account_id:   bulkAccountId,
      account_code: hit.code || "",
      account_name: hit.name || l.account_name,
    } : l));
    setBulkAccountId("");
    setSelectedIdxs(new Set());
    toast.success(`Moved ${targetIdxs.size} to ${hit.code} · ${hit.name}`);
    // After a bulk move the current group's key no longer matches
    // any lines — pop back to the review card automatically.
    setDrillKey(null);
    setCheckboxMode(false);
  };

  const closeDrill = () => {
    setDrillKey(null);
    setCheckboxMode(false);
    setSelectedIdxs(new Set());
    setBulkAccountId("");
  };

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
      const grandTotal = Number(
        a?.categorization?.totals?.grand_total ?? a?.totals?.grand_total ?? 0,
      );
      if (grandTotal > 0) setAmount(grandTotal.toFixed(2));
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
          // No match in existing contacts — auto-create the vendor
          // in the background so the compact review card can just
          // hit Save. Falls back to the manual "add vendor" flow if
          // creation fails (rate limit / offline).
          try {
            const cr = await api.post(`/companies/${currentId}/contacts`, {
              name: a.vendor, type: "vendor",
            });
            const newId = cr.data?.id;
            if (newId) {
              contacts.push({ id: newId, name: a.vendor, type: "vendor" });
              setContactId(newId);
            } else {
              setAddingVendor(true);
              setNewVendorName(a.vendor);
            }
          } catch (_) {
            setAddingVendor(true);
            setNewVendorName(a.vendor);
          }
        }
      }
      // Auto-select the CoA account for the receipt from the
      // biggest categorization bucket. In AI mode the Category
      // dropdown is hidden, so this happens transparently — the
      // save handler still writes a valid `account_id`.
      const catLines = a?.categorization?.line_items || a?.line_items || [];
      if (catLines.length) {
        const totals = new Map();
        for (const it of catLines) {
          const key = it.account_code || it.account_name || "";
          if (!key) continue;
          totals.set(key, (totals.get(key) || 0) + Math.abs(Number(it.amount || 0)));
        }
        const top = [...totals.entries()].sort((x, y) => y[1] - x[1])[0];
        if (top) {
          const [key] = top;
          const row = catLines.find(
            (l) => (l.account_code || l.account_name) === key,
          ) || {};
          const hit = accts.find(
            (ac) => (row.account_code && ac.code === row.account_code)
                 || (row.account_name && ac.name
                     && ac.name.toLowerCase() === row.account_name.toLowerCase())
                 || (row.account_name && ac.name
                     && ac.name.toLowerCase().includes(row.account_name.toLowerCase())),
          );
          if (hit) setCat(hit.id);
        }
      }
      toast.success("Receipt scanned — review and save.");
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

  // ── Paid-from resolver (opens when Save is pressed with no payAcct) ─
  // A dedicated modal appears on Save when the user hasn't picked a
  // payment source. Top pill = "Personal Account" (auto-creates/finds
  // a Due-to-Owner liability); below that, a scrollable list of asset
  // + liability accounts. When user resolves, the receipt gets saved
  // with the picked account. Backend then attempts auto-match against
  // an existing bank/CC transaction on (account, date, amount) so
  // the ledger doesn't double-count the purchase.
  const [paidFromResolverOpen, setPaidFromResolverOpen] = useState(false);
  const [resolverBusy, setResolverBusy] = useState(false);

  const save = async () => {
    // First — if the AI parked a detected vendor in "add vendor" state
    // (fallback path when the background auto-create failed at scan
    // time), finalize it now so the user isn't blocked on save.
    if (!contactId && addingVendor && newVendorName.trim()) {
      try {
        const cr = await api.post(`/companies/${currentId}/contacts`, {
          name: newVendorName.trim(), type: "vendor",
        });
        const newId = cr.data?.id;
        if (newId) {
          contacts.push({ id: newId, name: newVendorName.trim(), type: "vendor" });
          setContactId(newId);
          setAddingVendor(false);
          setNewVendorName("");
          // Re-run save on the next tick after state settles.
          setTimeout(() => save(), 0);
          return;
        }
      } catch (_) { /* fall through to the normal validation error */ }
    }
    const c = contacts.find(x => x.id === contactId);
    if (!c || !amount) { toast.error("Vendor and amount are required."); return; }
    // Missing payment source? Route through the resolver instead of
    // silently posting to an "Uncategorized Cash" fallback — the
    // resolver hands the user a first-class choice between "Personal
    // Account" (auto-books a Due-to-Owner liability) and a scrollable
    // list of real asset/liability accounts.
    if (!payAcct && !isEdit) {
      setPaidFromResolverOpen(true);
      return;
    }
    await commitSave(payAcct, /*paidPersonally=*/false);
  };

  const commitSave = async (paymentAcctId, paidPersonally) => {
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
        payment_account_id: paymentAcctId || null,
        paid_personally: !!paidPersonally,
        notes,
        attachment_data_url: attachment?.data_url || null,
        attachment_filename: attachment?.filename || null,
        // Persist the AI narrative so it can render as a second-line
        // description under the merchant on the Receipts list.
        ai_narrative:
          (analysis?.narrative || analysis?.categorization?.narrative || "").trim() || null,
        // Per-line categorization overrides — sent whenever the AI
        // scan produced editable lines. Backend groups by account_id
        // and books a split credit-per-account JE; empty/absent
        // triggers the single-category fallback.
        line_items: (editedLines && editedLines.length)
          ? editedLines.map((l) => ({
              description:  l.description,
              amount:       Number(l.amount || 0),
              account_id:   l.account_id || null,
              account_code: l.account_code || "",
              account_name: l.account_name || "",
            }))
          : null,
      };
      if (isEdit) {
        await api.patch(`/companies/${currentId}/receipts/${initial.id}`, payload);
        toast.success("Receipt updated");
      } else {
        await api.post(`/companies/${currentId}/receipts`, payload);
        toast.success(paidPersonally
          ? "Receipt saved — booked as owner reimbursement"
          : "Receipt saved");
      }
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setBusy(false); }
  };

  const pickPersonalAccount = async () => {
    setResolverBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/accounts/owner-liability`);
      const acctId = r.data?.id;
      if (!acctId) { toast.error("Couldn't create owner liability."); return; }
      setPayAcct(acctId);
      setPaidFromResolverOpen(false);
      await commitSave(acctId, /*paidPersonally=*/true);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Personal account setup failed.");
    } finally { setResolverBusy(false); }
  };

  const pickAccountFromList = async (accountId) => {
    setResolverBusy(true);
    try {
      setPayAcct(accountId);
      setPaidFromResolverOpen(false);
      await commitSave(accountId, /*paidPersonally=*/false);
    } finally { setResolverBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md flex flex-col max-h-[calc(100dvh-2rem)] h-[720px] overflow-hidden relative">
        <div className="px-5 pt-5 pb-3 flex items-center justify-between shrink-0">
          <h3 className="font-heading font-semibold">{isEdit ? "Edit Receipt" : "New Receipt"}</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        <div className="px-5 pb-5 space-y-3 flex-1 flex flex-col min-h-0 overflow-y-auto">

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

        {mode === "ai" && !isEdit && !analysis ? (
          /* AI phase 1 — landing. Two big CTAs. Camera capture uses
             the device camera on mobile (falls back to picker on
             desktop). Upload opens the standard file dialog. Both
             paths funnel into `onPickFile` which stashes the base64
             image; then `runScan` fires the same
             /receipts/analyze endpoint the manual mode uses. */
          <div className="flex-1 flex flex-col text-center" data-testid="receipt-ai-landing">
            <div className="text-sm text-slate-600 leading-relaxed pb-4">
              Snap or upload a receipt — I'll read the merchant, date,
              amount and category and fill this in for you.
            </div>
            <div className="flex flex-col gap-3 flex-1 min-h-0">
              <button
                type="button"
                onClick={() => cameraRef.current?.click()}
                disabled={scanning}
                className="rounded-xl border-2 border-dashed border-indigo-200 bg-indigo-50 hover:bg-indigo-100 px-4 text-indigo-800 font-semibold text-lg inline-flex flex-col items-center justify-center gap-2 disabled:opacity-60 flex-1 min-h-[120px]"
                data-testid="receipt-ai-camera"
              >
                <Camera size={40} />
                Take a photo
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={scanning}
                className="rounded-xl border-2 border-dashed border-slate-200 bg-white hover:bg-slate-50 px-4 text-slate-800 font-semibold text-lg inline-flex flex-col items-center justify-center gap-2 disabled:opacity-60 flex-1 min-h-[120px]"
                data-testid="receipt-ai-upload"
              >
                <Upload size={40} />
                Upload a photo
              </button>
            </div>
            {scanning && (
              <div className="pt-3 text-xs text-indigo-700 inline-flex items-center gap-1.5 justify-center">
                <Loader2 size={12} className="animate-spin" /> Scanning receipt with AI…
              </div>
            )}
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

        {mode === "manual" || isEdit || (mode === "ai" && analysis) ? (
        <>
        {(() => {
          // ── Compact "review card" for AI Phase 2 ─────────────
          // After a scan lands, the four small header fields collapse
          // into a summary pill (Date · Vendor · Amount · Paid from)
          // to give the line-item breakdown more room. Everything is
          // still editable — tapping the pill drops an inline editor
          // right underneath. Notes get their own sub-screen with a
          // dedicated big-mic voice-dictation button.
          const compact = mode === "ai" && analysis && !isEdit;
          if (!compact) return null;

          const vendorLabel = (contacts.find((c) => c.id === contactId) || {}).name
            || (addingVendor && newVendorName)
            || "Pick vendor";
          const dateLabel = date
            ? new Date(date + "T00:00:00").toLocaleDateString(undefined, {
                month: "short", day: "numeric", year: "numeric",
              })
            : "Pick date";
          const amountLabel = amount
            ? `$${Number(amount).toLocaleString("en-US", {
                minimumFractionDigits: 2, maximumFractionDigits: 2,
              })}`
            : "Amount";
          const payLabel = (() => {
            const p = paymentOptions.find((a) => a.id === payAcct);
            return p ? p.name : "Paid from";
          })();
          const missingPay = !payAcct;

          // Chart-of-accounts options for both the bulk picker and
          // per-line pickers. Filtered to expense accounts so users
          // don't accidentally book a receipt to Revenue or A/R.
          const expenseOptions = accts.filter((a) => a.type === "expense");

          // ── Drill screen — one category bubble at a time ─────
          if (drillKey && editedLines) {
            const groupLines = editedLines.filter(
              (l) => `${l.account_code || ""}|${l.account_name}` === drillKey,
            );
            const subtotal = groupLines.reduce(
              (s, l) => s + Math.abs(Number(l.amount || 0)), 0,
            );
            const headerName = groupLines[0]?.account_name || "Uncategorized";
            const headerCode = groupLines[0]?.account_code || "";
            const money = (n) => `$${Math.abs(Number(n) || 0).toLocaleString("en-US", {
              minimumFractionDigits: 2, maximumFractionDigits: 2,
            })}`;
            return (
              <div className="flex-1 flex flex-col gap-3 min-h-0" data-testid="receipt-drill-screen">
                <button
                  type="button"
                  onClick={closeDrill}
                  className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 self-start"
                  data-testid="receipt-drill-back"
                >
                  <ArrowLeft size={13} /> Back
                </button>

                {/* Header — current group name / count / subtotal. */}
                <div className="shrink-0">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Current category</div>
                  <div className="text-sm font-semibold text-slate-800" data-testid="receipt-drill-header">
                    {headerCode ? `${headerCode} · ` : ""}{headerName}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 font-mono-num tabular-nums">
                    {groupLines.length} item{groupLines.length === 1 ? "" : "s"} · {money(subtotal)}
                  </div>
                </div>

                {/* Bulk toolbar — checkbox mode toggle + target picker. */}
                <div className="shrink-0 rounded-lg border border-slate-200 bg-slate-50 p-2.5 space-y-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <label className="inline-flex items-center gap-1.5 text-slate-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checkboxMode}
                        onChange={(e) => {
                          setCheckboxMode(e.target.checked);
                          if (!e.target.checked) setSelectedIdxs(new Set());
                        }}
                        data-testid="receipt-drill-checkbox-mode"
                      />
                      <span className="font-semibold">Select items</span>
                      {checkboxMode && (
                        <span className="text-slate-500">· {selectedIdxs.size} of {groupLines.length}</span>
                      )}
                    </label>
                    {checkboxMode && (
                      <button
                        type="button"
                        onClick={() => {
                          const allIn = groupLines.every((l) => selectedIdxs.has(l._idx));
                          setSelectedIdxs(allIn ? new Set() : new Set(groupLines.map((l) => l._idx)));
                        }}
                        className="text-indigo-600 hover:underline font-medium"
                        data-testid="receipt-drill-select-all"
                      >
                        {groupLines.every((l) => selectedIdxs.has(l._idx)) ? "Clear" : "Select all"}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <select
                      value={bulkAccountId}
                      onChange={(e) => setBulkAccountId(e.target.value)}
                      className="flex-1 border rounded px-2 py-1.5 text-xs bg-white"
                      data-testid="receipt-drill-bulk-select"
                    >
                      <option value="">
                        {checkboxMode
                          ? `Move ${selectedIdxs.size || 0} selected to…`
                          : `Move all ${groupLines.length} to…`}
                      </option>
                      {expenseOptions.map((a) => (
                        <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={applyBulk}
                      disabled={!bulkAccountId || (checkboxMode && !selectedIdxs.size)}
                      className="px-3 py-1.5 rounded bg-indigo-600 text-white text-xs font-semibold disabled:opacity-40"
                      data-testid="receipt-drill-bulk-apply"
                    >
                      Move
                    </button>
                  </div>
                </div>

                {/* Scrollable list — one card per line with its own picker. */}
                <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
                  {groupLines.map((line) => (
                    <div
                      key={line._idx}
                      className="rounded-lg border border-slate-200 bg-white p-2 space-y-1.5"
                      data-testid={`receipt-drill-line-${line._idx}`}
                    >
                      <div className="flex items-center gap-2">
                        {checkboxMode && (
                          <input
                            type="checkbox"
                            checked={selectedIdxs.has(line._idx)}
                            onChange={(e) => {
                              const s = new Set(selectedIdxs);
                              if (e.target.checked) s.add(line._idx);
                              else s.delete(line._idx);
                              setSelectedIdxs(s);
                            }}
                            className="shrink-0"
                            data-testid={`receipt-drill-line-check-${line._idx}`}
                          />
                        )}
                        <span className="text-sm text-slate-800 flex-1 truncate" title={line.description}>
                          {line.description}
                        </span>
                        <span className="text-sm font-mono-num tabular-nums text-slate-700 shrink-0">
                          {money(line.amount)}
                        </span>
                      </div>
                      <select
                        value={line.account_id || ""}
                        onChange={(e) => setLineAccount(line._idx, e.target.value)}
                        className="w-full border rounded px-2 py-1 text-[11px] bg-white text-slate-700"
                        data-testid={`receipt-drill-line-select-${line._idx}`}
                      >
                        <option value="">— Uncategorized —</option>
                        {expenseOptions.map((a) => (
                          <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                  {groupLines.length === 0 && (
                    <div className="text-center text-xs text-slate-400 py-8">
                      No items left in this group.
                    </div>
                  )}
                </div>

                {/* Done — commits nothing new; edits are already in state. */}
                <button
                  type="button"
                  onClick={closeDrill}
                  className="shrink-0 py-2 rounded-md bg-slate-900 text-white text-sm font-semibold"
                  data-testid="receipt-drill-done"
                >
                  Done
                </button>
              </div>
            );
          }

          // ── Note screen — full modal takeover ─────────────
          if (noteView) {
            const secs = Math.floor(voice.elapsedMs / 1000);
            const mm = String(Math.floor(secs / 60)).padStart(1, "0");
            const ss = String(secs % 60).padStart(2, "0");
            return (
              <div className="flex-1 flex flex-col gap-3 min-h-0" data-testid="receipt-note-screen">
                <button
                  type="button"
                  onClick={() => setNoteView(false)}
                  className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 self-start"
                  data-testid="receipt-note-back"
                >
                  <ArrowLeft size={13} /> Back
                </button>
                <div className="flex flex-col shrink-0">
                  <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Note</label>
                  <textarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder="Type a note, or tap the mic to dictate…"
                    rows={4}
                    className="w-full border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-200"
                    data-testid="receipt-note-textarea"
                  />
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50/60 flex-1 min-h-0 flex flex-col items-center justify-center gap-3 p-4">
                  <button
                    type="button"
                    onClick={voice.recording ? voice.stop : voice.start}
                    disabled={transcribing}
                    className={`w-32 h-32 rounded-full inline-flex items-center justify-center shadow-lg transition-all border-4 ${
                      voice.recording
                        ? "bg-red-600 border-red-200 animate-pulse text-white"
                        : transcribing
                          ? "bg-slate-200 border-slate-100 text-slate-500 cursor-wait"
                          : "bg-indigo-600 border-indigo-100 text-white hover:bg-indigo-700 hover:scale-[1.03]"
                    }`}
                    data-testid="receipt-note-mic"
                    aria-label={voice.recording ? "Stop recording" : "Start recording"}
                  >
                    {transcribing ? <Loader2 size={44} className="animate-spin" />
                     : voice.recording ? <Square size={40} />
                     : <Mic size={48} />}
                  </button>
                  <div className="text-sm text-slate-600 h-5">
                    {transcribing
                      ? "Transcribing…"
                      : voice.recording
                        ? <span className="font-mono-num text-red-600">Recording · {mm}:{ss}</span>
                        : noteDraft ? "Tap to add more" : "Tap to dictate"}
                  </div>
                  {(voice.error || voiceError) && (
                    <div className="text-[11px] text-red-600" data-testid="receipt-note-mic-error">
                      {voice.error || voiceError}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => { setNotes(noteDraft); setNoteView(false); }}
                    className="flex-1 py-2 rounded-md bg-slate-900 text-white text-sm font-semibold"
                    data-testid="receipt-note-save"
                  >
                    Save note
                  </button>
                  <button
                    type="button"
                    onClick={() => setNoteView(false)}
                    className="px-4 py-2 rounded-md border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"
                    data-testid="receipt-note-cancel"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            );
          }

          // ── Review card — pill + note button + preview ─────
          return (
            <div className="flex-1 flex flex-col gap-3 min-h-0" data-testid="receipt-review-card">
              {/* Summary pill — click to edit the four small fields. */}
              <button
                type="button"
                onClick={() => setPillOpen((o) => !o)}
                className={`w-full text-left rounded-lg border px-3 py-2 text-xs transition ${
                  pillOpen
                    ? "border-indigo-300 bg-indigo-50"
                    : "border-slate-200 bg-slate-50 hover:bg-slate-100"
                }`}
                data-testid="receipt-summary-pill"
              >
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-slate-700 font-medium">{dateLabel}</span>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-700 font-semibold truncate max-w-[140px]" title={vendorLabel}>
                    {vendorLabel}
                  </span>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-900 font-mono-num tabular-nums font-semibold">
                    {amountLabel}
                  </span>
                  <span className="text-slate-300">·</span>
                  <span
                    className={`truncate max-w-[140px] ${
                      missingPay
                        ? "text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded font-semibold animate-pulse"
                        : "text-slate-700"
                    }`}
                    title={payLabel}
                  >
                    {payLabel}
                  </span>
                  <Pencil size={11} className="ml-auto text-slate-400 shrink-0" />
                </div>
              </button>

              {pillOpen && (
                <div className="rounded-lg border border-indigo-200 bg-white p-3 space-y-2.5" data-testid="receipt-pill-editor">
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Date</label>
                    <input
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      className="w-full border rounded px-2 py-1.5 text-sm"
                      data-testid="receipt-pill-date"
                    />
                  </div>
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
                          data-testid="receipt-pill-new-vendor-input"
                        />
                        <button
                          type="button"
                          onClick={createVendor}
                          disabled={creatingVendor}
                          className="px-3 py-1.5 rounded bg-slate-900 text-white text-xs inline-flex items-center gap-1 disabled:opacity-60"
                        >
                          {creatingVendor && <Loader2 size={12} className="animate-spin" />}
                          Add
                        </button>
                        <button
                          type="button"
                          onClick={() => { setAddingVendor(false); setNewVendorName(""); }}
                          className="px-2 py-1.5 rounded border text-xs"
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
                        data-testid="receipt-pill-vendor"
                      >
                        <option value="">— Pick vendor —</option>
                        {vendors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        {otherContacts.length > 0 && (
                          <optgroup label="Other contacts">
                            {otherContacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </optgroup>
                        )}
                        <option value="__add__">+ Add new vendor…</option>
                      </select>
                    )}
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Amount</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="Amount"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
                      data-testid="receipt-pill-amount"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Paid from</label>
                    <select
                      value={payAcct}
                      onChange={(e) => setPayAcct(e.target.value)}
                      className="w-full border rounded px-2 py-1.5 text-sm bg-white"
                      data-testid="receipt-pill-paid-from"
                    >
                      <option value="">— Pick bank / credit card / cash —</option>
                      {paymentOptions.map((a) => (
                        <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => setPillOpen(false)}
                      className="px-3 py-1 rounded text-xs bg-slate-900 text-white"
                      data-testid="receipt-pill-done"
                    >
                      Done
                    </button>
                  </div>
                </div>
              )}

              {/* Notes button — click to open dedicated note screen. */}
              <button
                type="button"
                onClick={() => setNoteView(true)}
                className="w-full text-left rounded-lg border border-slate-200 bg-white hover:bg-slate-50 px-3 py-2 inline-flex items-center gap-2 transition"
                data-testid="receipt-note-open"
              >
                <StickyNote size={14} className="text-slate-400 shrink-0" />
                {notes ? (
                  <span className="flex-1 text-xs text-slate-700 truncate italic" title={notes}>
                    "{notes}"
                  </span>
                ) : (
                  <span className="flex-1 text-xs text-slate-500 font-medium">
                    + Add note
                  </span>
                )}
                <ChevronRight size={13} className="text-slate-400 shrink-0" />
              </button>

              {/* Category breakdown — the star of the show. Feeds
                  from `editedLines` (the working copy) so bulk /
                  per-line moves inside the drill screen reflect
                  immediately when the user pops back here. */}
              <ReceiptCategoryPreview
                fill
                hideActions
                hideNarrative
                narrative={analysis.narrative || analysis?.categorization?.narrative}
                lineItems={
                  (editedLines && editedLines.length
                    ? editedLines
                    : (analysis?.categorization?.line_items?.length
                        ? analysis.categorization.line_items
                        : (analysis?.line_items || [])
                      ).map((x, i) => ({ ...x, _idx: i }))
                  )
                }
                grandTotal={
                  Number(
                    analysis?.categorization?.totals?.grand_total
                    ?? analysis?.totals?.grand_total
                    ?? 0
                  )
                }
                onApply={() => {}}
                onRescan={() => {}}
                onGroupClick={(key) => setDrillKey(key)}
              />

              {/* Save + Rescan */}
              <div className="flex items-center gap-2 pt-1">
                <button
                  data-testid={TID.saveBtn}
                  onClick={save}
                  disabled={busy}
                  className="flex-1 py-2 rounded-md bg-slate-900 text-white text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
                >
                  {busy && <Loader2 size={13} className="animate-spin" />}
                  Save receipt
                </button>
                <button
                  type="button"
                  onClick={() => { setAnalysis(null); setLineItems([]); setAttachment(null); }}
                  disabled={busy}
                  className="px-4 py-2 rounded-md border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                  data-testid="receipt-ai-rescan-bottom"
                >
                  Rescan
                </button>
              </div>
            </div>
          );
        })()}
        {!(mode === "ai" && analysis && !isEdit) && (
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

        {/* Category dropdown — hidden in AI mode after a scan
            because each receipt line already carries its own CoA
            code from the categorization pass. The save handler still
            writes a valid top-level `account_id` (auto-selected in
            `runScan()` from the largest-bucket account). */}
        {!(mode === "ai" && analysis) && (
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
        )}

        <input placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm" />

        {/* Receipt attachment — image or PDF. Stored as a data URL on
            the receipt doc so it renders inline without a separate
            file service. Capped at 8 MB. */}
        <div className="rounded-md border border-dashed border-slate-300 p-3">
          {/* File-card + scan-CTA. Suppressed in AI Phase 2 because
              the categorization preview already implies the source
              image and the modal doesn't need a duplicate filename
              stub. */}
          {!(mode === "ai" && analysis) && (
            <>
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
                </div>
              ) : null}
            </>
          )}
              {analysis && (
                <ReceiptCategoryPreview
                  hideActions={mode === "ai"}
                  hideNarrative={mode === "ai"}
                  narrative={analysis.narrative || analysis?.categorization?.narrative}
                  lineItems={
                    // Prefer the categorization arm (it has
                    // account_code + account_name per line, which is
                    // what enables the emerald CoA grouping). Fall
                    // back to the split arm if categorization
                    // failed but split succeeded.
                    (analysis?.categorization?.line_items?.length
                       ? analysis.categorization.line_items
                       : (analysis?.line_items || [])
                    ).map((x, i) => ({ ...x, _idx: i }))
                  }
                  grandTotal={
                    Number(
                      analysis?.categorization?.totals?.grand_total
                      ?? analysis?.totals?.grand_total
                      ?? 0
                    )
                  }
                  onApply={() => {
                    const gt = Number(
                      analysis?.categorization?.totals?.grand_total
                      ?? analysis?.totals?.grand_total
                      ?? 0
                    );
                    if (gt > 0) setAmount(gt.toFixed(2));
                    // Auto-select the CoA account from the largest
                    // category bucket. Fuzzy-match by name (case-
                    // insensitive substring) against the loaded
                    // chart of accounts.
                    const lines = analysis?.categorization?.line_items
                                  || analysis?.line_items || [];
                    const totals = new Map();
                    for (const it of lines) {
                      const key = it.account_code || it.account_name || "";
                      if (!key) continue;
                      totals.set(key, (totals.get(key) || 0)
                                       + Math.abs(Number(it.amount || 0)));
                    }
                    const top = [...totals.entries()].sort(
                      (a, b) => b[1] - a[1],
                    )[0];
                    if (top) {
                      const [key] = top;
                      const bestName = (lines.find(
                        (l) => (l.account_code || l.account_name) === key,
                      ) || {}).account_name || "";
                      const bestCode = (lines.find(
                        (l) => (l.account_code || l.account_name) === key,
                      ) || {}).account_code || "";
                      const hit = accts.find(
                        (a) => (bestCode && a.code === bestCode)
                            || (bestName && a.name
                                && a.name.toLowerCase() === bestName.toLowerCase())
                            || (bestName && a.name
                                && a.name.toLowerCase().includes(bestName.toLowerCase())),
                      );
                      if (hit) setCat(hit.id);
                    }
                    toast.success("Applied AI category breakdown.");
                  }}
                  onRescan={() => { setAnalysis(null); setLineItems([]); runScan(); }}
                />
              )}
          {!attachment && !(mode === "ai" && analysis) && (
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

        {/* Bottom actions. Manual mode + Edit → single Save button.
            AI mode with an analysis → Save + Rescan pair (Rescan
            clears the current scan and returns to the two-CTA
            landing so the user can re-shoot). */}
        <div className="flex items-center gap-2">
          <button
            data-testid={TID.saveBtn}
            onClick={save}
            disabled={busy}
            className="flex-1 py-2 rounded-md bg-slate-900 text-white text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {isEdit ? "Update receipt" : "Save receipt"}
          </button>
          {mode === "ai" && analysis && !isEdit && (
            <button
              type="button"
              onClick={() => {
                setAnalysis(null);
                setLineItems([]);
                setAttachment(null);
              }}
              disabled={busy}
              className="px-4 py-2 rounded-md border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              data-testid="receipt-ai-rescan-bottom"
            >
              Rescan
            </button>
          )}
        </div>
        </>
        )}
        </>
        ) : null}
        </div>

        {/* Paid-from resolver — layered over the modal when the user
            tries to Save without picking a payment source. */}
        {paidFromResolverOpen && (
          <PaidFromResolver
            accts={accts}
            busy={resolverBusy}
            onPersonal={pickPersonalAccount}
            onPick={pickAccountFromList}
            onClose={() => setPaidFromResolverOpen(false)}
          />
        )}
      </div>
    </div>
  );
}


function PaidFromResolver({ accts, busy, onPersonal, onPick, onClose }) {
  // Modal-inside-modal — matches the SmartBooks convention of layering
  // a resolver on top of the parent form so the user never loses their
  // in-progress receipt when they need to clarify a payment source.
  //
  // Top pill = Personal Account (auto-books a Due-to-Owner liability
  // so the ledger tracks reimbursement owed to the user).
  // Below = scrollable list of asset + liability accounts, alpha
  // sorted within type so cash / bank / CC accounts stack together
  // and liability accounts (loans, cards, owner-debt) sit below.
  const [query, setQuery] = useState("");
  const eligible = accts
    .filter((a) => a.type === "asset" || a.type === "liability")
    .sort((a, b) => {
      // Assets before liabilities; then by code, then by name.
      if (a.type !== b.type) return a.type === "asset" ? -1 : 1;
      const ac = (a.code || "").localeCompare(b.code || "");
      if (ac) return ac;
      return (a.name || "").localeCompare(b.name || "");
    });
  const q = query.trim().toLowerCase();
  const filtered = q
    ? eligible.filter((a) =>
        (a.name || "").toLowerCase().includes(q)
        || (a.code || "").toLowerCase().includes(q))
    : eligible;
  return (
    <div
      className="absolute inset-0 z-10 bg-black/50 flex items-center justify-center p-3"
      data-testid="receipt-paid-from-resolver"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm flex flex-col max-h-[80%] overflow-hidden">
        <div className="px-4 pt-4 pb-2 shrink-0">
          <div className="flex items-center justify-between">
            <h4 className="font-heading font-semibold text-sm">Which account did this come out of?</h4>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={14} /></button>
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
            Pick the bank / card that paid, or tap Personal — we'll
            book what the company owes you and try to match the bank
            transaction when it arrives.
          </p>
        </div>

        {/* Personal — the always-first CTA. Distinct violet styling so
            it never gets buried in the alpha-sorted list below. */}
        <div className="px-4 pt-2 shrink-0">
          <button
            type="button"
            onClick={onPersonal}
            disabled={busy}
            className="w-full flex items-center gap-2.5 rounded-lg border-2 border-indigo-300 bg-indigo-50 hover:bg-indigo-100 p-3 text-left disabled:opacity-60"
            data-testid="receipt-paid-from-personal"
          >
            <div className="w-8 h-8 rounded-full bg-indigo-600 text-white inline-flex items-center justify-center shrink-0">
              <Sparkles size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-indigo-900">Personal Account</div>
              <div className="text-[11px] text-indigo-700/80">
                Books it as owner reimbursement (Due to Owner)
              </div>
            </div>
            <ChevronRight size={14} className="text-indigo-500 shrink-0" />
          </button>
        </div>

        {/* Search + scrollable account list */}
        <div className="px-4 pt-3 shrink-0">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search accounts…"
            className="w-full border rounded-md px-2.5 py-1.5 text-xs"
            data-testid="receipt-paid-from-search"
          />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2 space-y-1">
          {filtered.length === 0 && (
            <div className="text-center text-[11px] text-slate-400 py-4">
              No accounts match "{query}"
            </div>
          )}
          {filtered.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onPick(a.id)}
              disabled={busy}
              className="w-full flex items-center gap-2 rounded-md border border-slate-200 bg-white hover:bg-slate-50 px-2.5 py-1.5 text-left disabled:opacity-60"
              data-testid={`receipt-paid-from-option-${a.id}`}
            >
              <span className={`text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded shrink-0 ${
                a.type === "asset"
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-amber-100 text-amber-700"
              }`}>
                {a.type === "asset" ? "Asset" : "Liab"}
              </span>
              <span className="text-xs font-mono-num text-slate-500 shrink-0">{a.code}</span>
              <span className="text-xs text-slate-800 flex-1 truncate">{a.name}</span>
              <ChevronRight size={12} className="text-slate-400 shrink-0" />
            </button>
          ))}
        </div>
        <div className="px-4 py-3 border-t border-slate-100 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="w-full py-1.5 rounded-md border border-slate-300 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            data-testid="receipt-paid-from-cancel"
          >
            Cancel
          </button>
        </div>
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


function ReceiptCategoryPreview({ narrative, lineItems, grandTotal, onApply, onRescan, onGroupClick, hideActions = false, hideNarrative = false, fill = false }) {
  // CoA-grouped preview — mirrors the Quick Check-in
  // `CategorizationBreakdown` component so a receipt scan reads
  // identically no matter which entry point the merchant used.
  // Groups lines by (account_code | account_name); shows the
  // account header + emerald subtotal, then each SKU underneath.
  // When `onGroupClick` is provided each group renders as a button —
  // tap to drill into a screen that lets the user reassign items in
  // that category (individually or in bulk).
  const money = (n) => `$${Math.abs(Number(n) || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
  const groups = new Map();
  (lineItems || []).forEach((it) => {
    const key = `${it.account_code || ""}|${it.account_name || "Uncategorized"}`;
    const g = groups.get(key) || {
      key,
      account_code: it.account_code,
      account_name: it.account_name || "Uncategorized",
      subtotal:     0,
      items:        [],
    };
    g.subtotal = Math.round((g.subtotal + Math.abs(Number(it.amount || 0))) * 100) / 100;
    g.items.push(it);
    groups.set(key, g);
  });
  const groupList = [...groups.values()].sort((a, b) => b.subtotal - a.subtotal);
  return (
    <div className={`mt-2 space-y-2 ${fill ? "flex-1 min-h-0" : "max-h-72"} overflow-y-auto`} data-testid="receipt-category-preview">
      {narrative && !hideNarrative && (
        <div className="text-[11px] text-slate-600 italic px-1">
          {narrative}
        </div>
      )}
      {!hideNarrative && (
        <div className="text-[11px] text-slate-500 italic px-1">
          Every line is booked as a business expense. Categories inferred from your Chart of Accounts.
        </div>
      )}
      {onGroupClick && (
        <div className="text-[11px] text-slate-400 italic px-1">
          Tap a category to move or reassign its items.
        </div>
      )}
      {groupList.map((g, gi) => {
        const clickable = !!onGroupClick;
        const Wrapper = clickable ? "button" : "div";
        return (
          <Wrapper
            key={`${g.account_code || ""}-${gi}`}
            type={clickable ? "button" : undefined}
            onClick={clickable ? () => onGroupClick(g.key) : undefined}
            className={`w-full text-left rounded-lg border border-emerald-200 bg-emerald-50 p-2 block ${
              clickable ? "hover:bg-emerald-100 transition cursor-pointer" : ""
            }`}
            data-testid={`receipt-cat-group-${gi}`}
          >
            <div className="flex items-center justify-between mb-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
              <span className="truncate pr-2">
                {g.account_code ? `${g.account_code} · ` : ""}{g.account_name}
                <span className="ml-1 text-emerald-600/70 font-normal normal-case tracking-normal">
                  · {g.items.length} item{g.items.length === 1 ? "" : "s"}
                </span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="font-mono-num tabular-nums">{money(g.subtotal)}</span>
                {clickable && <ChevronRight size={12} className="text-emerald-500" />}
              </span>
            </div>
            <div className="space-y-0.5">
              {g.items.map((it, i) => (
                <div
                  key={`${gi}-${i}`}
                  className="flex items-center justify-between text-[12px] text-slate-700 py-0.5 px-1"
                >
                  <span className="truncate pr-2">{it.description}</span>
                  <span className="font-mono-num tabular-nums text-slate-600 shrink-0">
                    {money(it.amount)}
                  </span>
                </div>
              ))}
            </div>
          </Wrapper>
        );
      })}
      {grandTotal > 0 && (
        <div className="flex items-center justify-between px-1 pt-1 border-t border-slate-200">
          <span className="text-[12px] font-semibold text-slate-800">Receipt total</span>
          <span className="font-mono-num tabular-nums text-[12px] font-semibold text-slate-800">
            {money(grandTotal)}
          </span>
        </div>
      )}
      {!hideActions && (
        <div className="flex items-center gap-1.5 pt-1">
          <button
            type="button"
            onClick={onApply}
            className="flex-1 px-2 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
            data-testid="receipt-cat-apply"
          >
            Use this split
          </button>
          <button
            type="button"
            onClick={onRescan}
            className="px-2 py-1.5 rounded-md border border-slate-300 text-xs text-slate-700"
            data-testid="receipt-cat-rescan"
          >
            Rescan
          </button>
        </div>
      )}
    </div>
  );
}
