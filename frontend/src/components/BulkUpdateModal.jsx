import { useMemo, useState } from "react";
import { X, User, Tag, Check, Loader2 } from "lucide-react";

/**
 * Consolidated bulk-update popup — replaces having Approve all /
 * Reclassify / Change contact as three separate flows so users can
 * change Contact + Category in the same round-trip without either
 * dropdown disappearing after the first save.
 *
 * The order matches how CPAs think about a row: who was it? (Contact)
 * → what account does it hit? (Category) → is it good to post?
 * (Approve). Each field is optional — empty fields are treated as
 * "don't touch this on the selected rows" (safest default, matches
 * QBO's own batch UX).
 *
 * Props
 * -----
 * count           number                    — selected row count (title copy)
 * contacts        [{id,name}]               — searchable list
 * accounts        [{id,code,name,type,...}] — searchable list
 * onCancel        () => void
 * onApply         ({ contact_id, category_account_id, approve }) => void
 *                                            — only keys the user set are
 *                                              included; caller routes
 *                                              through its own confirm gate.
 */
export default function BulkUpdateModal({
  count, contacts = [], accounts = [], onCancel, onApply,
}) {
  const [contactId, setContactId]         = useState("");
  const [contactQ, setContactQ]           = useState("");
  const [showContacts, setShowContacts]   = useState(false);
  const [categoryId, setCategoryId]       = useState("");
  const [categoryQ, setCategoryQ]         = useState("");
  const [showCategories, setShowCategories] = useState(false);
  const [approve, setApprove]             = useState(false);
  const [busy, setBusy]                   = useState(false);

  const filteredContacts = useMemo(() => {
    const s = contactQ.trim().toLowerCase();
    return (contacts || [])
      .filter(c => !s || (c.name || "").toLowerCase().includes(s))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      .slice(0, 200);
  }, [contacts, contactQ]);

  const categoryPool = useMemo(() => {
    // Same defaultTypeFilter behaviour as ReclassifyPicker: reclassify
    // targets are revenue / expense / cogs by default, plus owner-draw
    // and refund-shaped rows so users can move rebates or reimbursements
    // without hunting through advanced.
    const defaultTypeFilter = (a) =>
      ["revenue", "expense", "cogs"].includes((a.type || "").toLowerCase())
      || /uncategorized|owner|draw|contribution|refund|reimburs/i.test(a.name || "");
    return (accounts || []).filter(defaultTypeFilter);
  }, [accounts]);

  const filteredCategories = useMemo(() => {
    const s = categoryQ.trim().toLowerCase();
    return categoryPool
      .filter(a => !s
        || (a.name || "").toLowerCase().includes(s)
        || String(a.code || "").includes(s))
      .sort((a, b) => String(a.code || "").localeCompare(String(b.code || "")))
      .slice(0, 200);
  }, [categoryPool, categoryQ]);

  const contactLabel  = contacts.find(c => c.id === contactId)?.name;
  const categoryLabel = accounts.find(a => a.id === categoryId);

  const nothingSet = !contactId && !categoryId && !approve;

  const handleApply = async () => {
    if (nothingSet || busy) return;
    setBusy(true);
    const patch = {};
    if (contactId)  patch.contact_id          = contactId;
    if (categoryId) patch.category_account_id = categoryId;
    if (approve)    patch.approve             = true;
    try { await onApply(patch); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4">
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md flex flex-col max-h-[86vh]"
        data-testid="bulk-update-modal"
      >
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <div>
            <h3 className="font-heading font-semibold">Bulk update</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {count} transaction{count === 1 ? "" : "s"} · fields left blank stay unchanged
            </p>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-700" data-testid="bulk-update-close">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          {/* ------- Contact ------- */}
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
              Contact
            </label>
            <div className="relative">
              <User size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                data-testid="bulk-update-contact-input"
                type="text"
                value={contactId ? (contactLabel || "") : contactQ}
                onFocus={() => { setShowContacts(true); if (contactId) setContactQ(""); }}
                onChange={(e) => {
                  setContactQ(e.target.value);
                  setContactId("");
                  setShowContacts(true);
                }}
                placeholder="Search or leave blank to skip…"
                className="w-full pl-7 pr-8 py-1.5 rounded border border-slate-300 text-sm"
              />
              {contactId && (
                <button
                  onClick={() => { setContactId(""); setContactQ(""); }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                  title="Clear contact"
                  data-testid="bulk-update-contact-clear"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            {showContacts && !contactId && (
              <div className="mt-1 max-h-48 overflow-y-auto rounded border border-slate-200 bg-white shadow-sm">
                {filteredContacts.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-slate-400">No matches</div>
                ) : filteredContacts.map(c => (
                  <button
                    key={c.id}
                    data-testid={`bulk-update-contact-opt-${c.id}`}
                    onClick={() => { setContactId(c.id); setShowContacts(false); }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 border-b border-slate-100 last:border-b-0"
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ------- Category ------- */}
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
              Category
            </label>
            <div className="relative">
              <Tag size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                data-testid="bulk-update-category-input"
                type="text"
                value={categoryId
                  ? `${categoryLabel?.code ?? ""} · ${categoryLabel?.name ?? ""}`
                  : categoryQ}
                onFocus={() => { setShowCategories(true); if (categoryId) setCategoryQ(""); }}
                onChange={(e) => {
                  setCategoryQ(e.target.value);
                  setCategoryId("");
                  setShowCategories(true);
                }}
                placeholder="Search or leave blank to skip…"
                className="w-full pl-7 pr-8 py-1.5 rounded border border-slate-300 text-sm"
              />
              {categoryId && (
                <button
                  onClick={() => { setCategoryId(""); setCategoryQ(""); }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                  title="Clear category"
                  data-testid="bulk-update-category-clear"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            {showCategories && !categoryId && (
              <div className="mt-1 max-h-56 overflow-y-auto rounded border border-slate-200 bg-white shadow-sm">
                {filteredCategories.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-slate-400">No matches</div>
                ) : filteredCategories.map(a => (
                  <button
                    key={a.id}
                    data-testid={`bulk-update-category-opt-${a.id}`}
                    onClick={() => { setCategoryId(a.id); setShowCategories(false); }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 border-b border-slate-100 last:border-b-0 flex items-center gap-2"
                  >
                    <span className="font-mono-num text-[11px] text-slate-500 shrink-0">{a.code || "—"}</span>
                    <span className="truncate">{a.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ------- Approve all ------- */}
          <label className="flex items-center gap-2 pt-1 cursor-pointer">
            <input
              type="checkbox"
              checked={approve}
              onChange={(e) => setApprove(e.target.checked)}
              data-testid="bulk-update-approve"
              className="rounded"
            />
            <span className="text-sm text-slate-800">
              Approve all — marks the selected rows as human-reviewed
            </span>
          </label>
        </div>

        <div className="px-5 py-3 border-t bg-slate-50 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-sm text-slate-700 hover:bg-slate-100"
            data-testid="bulk-update-cancel"
          >
            Cancel
          </button>
          <button
            disabled={nothingSet || busy}
            onClick={handleApply}
            data-testid="bulk-update-apply"
            className="px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm flex items-center gap-1.5 disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
