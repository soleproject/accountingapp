import { useMemo, useState } from "react";
import { X, User, Tag, Check, Loader2, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";

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
 * Layout notes:
 *   • The dropdown lists are `absolute`-positioned so opening one
 *     never resizes the modal itself. Otherwise the modal would grow
 *     downward every time the CPA focused a search box.
 *   • When the search text doesn't match any existing row, an inline
 *     "+ Add new" flow opens a mini-modal that hits the same endpoints
 *     the standalone Contacts / Chart of Accounts pages use.
 */
export default function BulkUpdateModal({
  currentId, count, contacts = [], accounts = [], onCancel, onApply,
  onContactCreated,   // (contact) => void — parent syncs its contact list
  onAccountCreated,   // (account) => void — parent syncs its accounts list
}) {
  const [contactId, setContactId]         = useState("");
  const [contactQ, setContactQ]           = useState("");
  const [showContacts, setShowContacts]   = useState(false);
  const [categoryId, setCategoryId]       = useState("");
  const [categoryQ, setCategoryQ]         = useState("");
  const [showCategories, setShowCategories] = useState(false);
  const [approve, setApprove]             = useState(false);
  const [busy, setBusy]                   = useState(false);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [addAccountOpen, setAddAccountOpen] = useState(false);

  const filteredContacts = useMemo(() => {
    const s = contactQ.trim().toLowerCase();
    return (contacts || [])
      .filter(c => !s || (c.name || "").toLowerCase().includes(s))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      .slice(0, 200);
  }, [contacts, contactQ]);

  const categoryPool = useMemo(() => {
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
        className="bg-white rounded-xl shadow-2xl w-full max-w-md flex flex-col"
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

        <div className="px-5 py-4 space-y-4">
          {/* ------- Contact ------- */}
          <div className="relative">
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
                onBlur={() => setTimeout(() => setShowContacts(false), 150)}
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
              <div className="absolute left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto rounded border border-slate-200 bg-white shadow-lg z-10">
                {filteredContacts.length === 0 && !contactQ.trim() ? (
                  <div className="px-3 py-2 text-xs text-slate-400">Start typing to search…</div>
                ) : filteredContacts.map(c => (
                  <button
                    key={c.id}
                    data-testid={`bulk-update-contact-opt-${c.id}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setContactId(c.id); setShowContacts(false); }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 border-b border-slate-100 last:border-b-0"
                  >
                    {c.name}
                  </button>
                ))}
                <button
                  data-testid="bulk-update-contact-add-new"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setAddContactOpen(true); setShowContacts(false); }}
                  className="w-full text-left px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-50 border-t border-slate-200 flex items-center gap-1.5 font-medium"
                >
                  <Plus size={13} /> Add new contact{contactQ.trim() ? ` "${contactQ.trim()}"` : ""}
                </button>
              </div>
            )}
          </div>

          {/* ------- Category ------- */}
          <div className="relative">
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
                onBlur={() => setTimeout(() => setShowCategories(false), 150)}
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
              <div className="absolute left-0 right-0 top-full mt-1 max-h-56 overflow-y-auto rounded border border-slate-200 bg-white shadow-lg z-10">
                {filteredCategories.length === 0 && !categoryQ.trim() ? (
                  <div className="px-3 py-2 text-xs text-slate-400">Start typing to search…</div>
                ) : filteredCategories.map(a => (
                  <button
                    key={a.id}
                    data-testid={`bulk-update-category-opt-${a.id}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setCategoryId(a.id); setShowCategories(false); }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 border-b border-slate-100 last:border-b-0 flex items-center gap-2"
                  >
                    <span className="font-mono-num text-[11px] text-slate-500 shrink-0">{a.code || "—"}</span>
                    <span className="truncate">{a.name}</span>
                  </button>
                ))}
                <button
                  data-testid="bulk-update-category-add-new"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setAddAccountOpen(true); setShowCategories(false); }}
                  className="w-full text-left px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-50 border-t border-slate-200 flex items-center gap-1.5 font-medium"
                >
                  <Plus size={13} /> Add new account{categoryQ.trim() ? ` "${categoryQ.trim()}"` : ""}
                </button>
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

      {addContactOpen && (
        <NewContactMiniModal
          currentId={currentId}
          initialName={contactQ.trim()}
          onCancel={() => setAddContactOpen(false)}
          onCreated={(c) => {
            onContactCreated?.(c);
            setContactId(c.id);
            setContactQ("");
            setAddContactOpen(false);
          }}
        />
      )}
      {addAccountOpen && (
        <NewAccountMiniModal
          currentId={currentId}
          initialName={categoryQ.trim()}
          onCancel={() => setAddAccountOpen(false)}
          onCreated={(a) => {
            onAccountCreated?.(a);
            setCategoryId(a.id);
            setCategoryQ("");
            setAddAccountOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mini "New Contact" modal — mirrors the standalone Contacts page's create
// form but scoped to the fields the CPA needs at bulk-update time.
// ---------------------------------------------------------------------------
function NewContactMiniModal({ currentId, initialName = "", onCancel, onCreated }) {
  const [name, setName]       = useState(initialName);
  const [type, setType]       = useState("customer");
  const [email, setEmail]     = useState("");
  const [phone, setPhone]     = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy]       = useState(false);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/contacts`, {
        name: name.trim(),
        type,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        address: address.trim() || undefined,
      });
      const created = r?.data;
      if (created?.id) {
        toast.success(`Contact "${created.name || name}" created`);
        onCreated({ id: created.id, name: created.name || name.trim(), type });
      } else {
        toast.error("Failed to create contact");
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to create contact");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[85] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm" data-testid="new-contact-mini-modal">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <h3 className="font-heading font-semibold">New Contact</h3>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-700"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <input data-testid="new-contact-name" type="text" placeholder="Name" value={name}
                 onChange={(e) => setName(e.target.value)}
                 className="w-full px-3 py-2 rounded border border-slate-300 text-sm" autoFocus />
          <select data-testid="new-contact-type" value={type} onChange={(e) => setType(e.target.value)}
                  className="w-full px-3 py-2 rounded border border-slate-300 text-sm bg-white">
            <option value="customer">Customer</option>
            <option value="vendor">Vendor</option>
            <option value="employee">Employee</option>
          </select>
          <input data-testid="new-contact-email" type="email" placeholder="Email" value={email}
                 onChange={(e) => setEmail(e.target.value)}
                 className="w-full px-3 py-2 rounded border border-slate-300 text-sm" />
          <input data-testid="new-contact-phone" type="tel" placeholder="Phone" value={phone}
                 onChange={(e) => setPhone(e.target.value)}
                 className="w-full px-3 py-2 rounded border border-slate-300 text-sm" />
          <input data-testid="new-contact-address" type="text" placeholder="Address" value={address}
                 onChange={(e) => setAddress(e.target.value)}
                 className="w-full px-3 py-2 rounded border border-slate-300 text-sm" />
          <button data-testid="new-contact-create" disabled={!name.trim() || busy} onClick={create}
                  className="w-full mt-1 py-2 rounded-md bg-slate-500 hover:bg-slate-700 text-white text-sm flex items-center justify-center gap-1.5 disabled:opacity-60">
            {busy ? <Loader2 size={13} className="animate-spin" /> : null}
            Create contact
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mini "New Account" modal — hits the idempotent `/accounts/ensure` endpoint
// so we don't fight with account-code uniqueness.
// ---------------------------------------------------------------------------
function NewAccountMiniModal({ currentId, initialName = "", onCancel, onCreated }) {
  const [name, setName]       = useState(initialName);
  const [type, setType]       = useState("expense");
  const [subtype, setSubtype] = useState("");
  const [parentId, setParentId] = useState("");
  const [busy, setBusy]       = useState(false);
  const [parents, setParents] = useState([]);

  // Load same-type parent options so users can nest the new account.
  useMemo(() => {
    (async () => {
      try {
        const r = await api.get(`/companies/${currentId}/accounts`);
        const list = r?.data?.accounts || r?.data || [];
        setParents(list.filter(a => (a.type || "").toLowerCase() === type && !a.parent_id));
      } catch { /* noop */ }
    })();
    return null;
  }, [currentId, type]);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/accounts/ensure`, {
        name: name.trim(),
        type,
        detail_type: subtype || undefined,
        parent_id: parentId || undefined,
      });
      const created = r?.data?.account || r?.data;
      if (created?.id) {
        toast.success(`Account "${created.name || name}" ready`);
        onCreated(created);
      } else {
        toast.error("Failed to create account");
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to create account");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[85] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm" data-testid="new-account-mini-modal">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <h3 className="font-heading font-semibold">New Account</h3>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-700"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <input data-testid="new-account-name" type="text" placeholder="Account name" value={name}
                 onChange={(e) => setName(e.target.value)}
                 className="w-full px-3 py-2 rounded border border-slate-300 text-sm" autoFocus />
          <select data-testid="new-account-type" value={type}
                  onChange={(e) => { setType(e.target.value); setParentId(""); }}
                  className="w-full px-3 py-2 rounded border border-slate-300 text-sm bg-white">
            <option value="expense">Expense</option>
            <option value="revenue">Revenue</option>
            <option value="cogs">Cost of Goods Sold</option>
            <option value="asset">Asset</option>
            <option value="liability">Liability</option>
            <option value="equity">Equity</option>
          </select>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
              Sub-type <span className="text-rose-500">*</span>
            </label>
            <input data-testid="new-account-subtype" type="text" placeholder="e.g. Office Expenses" value={subtype}
                   onChange={(e) => setSubtype(e.target.value)}
                   className="w-full px-3 py-2 rounded border border-slate-300 text-sm" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
              Sub-account of (optional)
            </label>
            <select data-testid="new-account-parent" value={parentId} onChange={(e) => setParentId(e.target.value)}
                    className="w-full px-3 py-2 rounded border border-slate-300 text-sm bg-white">
              <option value="">— None (top-level account) —</option>
              {parents.map(p => (
                <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 pt-1">
            <button data-testid="new-account-save" disabled={!name.trim() || !subtype.trim() || busy} onClick={create}
                    className="flex-1 py-2 rounded-md bg-slate-500 hover:bg-slate-700 text-white text-sm flex items-center justify-center gap-1.5 disabled:opacity-60">
              {busy ? <Loader2 size={13} className="animate-spin" /> : null}
              Save
            </button>
            <button onClick={onCancel} className="flex-1 py-2 rounded-md bg-white border border-slate-200 hover:bg-slate-50 text-sm">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
