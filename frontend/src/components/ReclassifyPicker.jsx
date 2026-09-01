import { useMemo, useState } from "react";
import { X, User, Check } from "lucide-react";

/**
 * Modal picker for choosing a target CoA account when bulk-reclassifying
 * transactions. Filters to revenue / expense / cogs plus owner-draw-style
 * rows a user might reasonably reclassify TO. Used by both the Contacts
 * report drawer and the main Transactions page.
 *
 * Optional bulk-contact update:
 *   Pass `contacts=[{id,name}]` and the modal exposes a compact contact
 *   picker at the top. Whatever contact is selected when the user clicks
 *   an account row is forwarded to `onApply(accountId, contactId | null)`.
 *   Callers that don't pass `contacts` get the original single-arg behaviour.
 */
export default function ReclassifyPicker({
  accounts,
  count,
  onCancel,
  onApply,
  allowedTypes,   // e.g. null → all types; ["asset","liability"] → restricted
  title,          // override modal heading
  excludeIds,     // hide these account ids (used when moving OUT of an account)
  contacts,       // optional [{id,name}] → enables contact bulk-set
}) {
  const [q, setQ] = useState("");
  const [contactId, setContactId] = useState("");
  const [contactQ, setContactQ] = useState("");
  const [showContactList, setShowContactList] = useState(false);

  const contactEnabled = Array.isArray(contacts) && contacts.length > 0;

  const options = useMemo(() => {
    const s = q.trim().toLowerCase();
    const excludeSet = new Set(excludeIds || []);
    const defaultTypeFilter = (a) =>
      ["revenue", "expense", "cogs"].includes((a.type || "").toLowerCase())
      || /uncategorized|owner|draw|contribution|refund|reimburs/i.test(a.name || "");
    const typeFilter = Array.isArray(allowedTypes)
      ? (a) => allowedTypes.includes((a.type || "").toLowerCase())
      : (allowedTypes === null ? () => true : defaultTypeFilter);
    return (accounts || [])
      .filter(a => !excludeSet.has(a.id))
      .filter(typeFilter)
      .filter(a => !s
        || (a.name || "").toLowerCase().includes(s)
        || (a.code || "").includes(s))
      .sort((a, b) => (a.code || "").localeCompare(b.code || ""));
  }, [accounts, q, allowedTypes, excludeIds]);

  const contactOptions = useMemo(() => {
    if (!contactEnabled) return [];
    const s = contactQ.trim().toLowerCase();
    return (contacts || [])
      .filter(c => !s || (c.name || "").toLowerCase().includes(s))
      .slice(0, 50);
  }, [contacts, contactQ, contactEnabled]);

  const selectedContact = contactEnabled && contactId
    ? (contacts || []).find(c => c.id === contactId) : null;

  const apply = (accountId) => {
    if (contactEnabled) {
      onApply(accountId, contactId || null);
    } else {
      onApply(accountId);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md flex flex-col max-h-[80vh]">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <div>
            <h3 className="font-heading font-semibold">
              {title || `Reclassify ${count} transaction${count !== 1 ? "s" : ""}`}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {contactEnabled
                ? "Optionally set a contact, then pick a target category."
                : "Pick the target category account."}
            </p>
          </div>
          <button onClick={onCancel} data-testid="reclassify-close"><X size={16} /></button>
        </div>

        {contactEnabled && (
          <div className="px-5 py-3 border-b bg-slate-50/60">
            <div className="flex items-center gap-2 mb-2">
              <User size={13} className="text-slate-500" />
              <span className="text-xs font-medium text-slate-700">
                Contact <span className="text-slate-400 font-normal">(optional)</span>
              </span>
              {selectedContact && (
                <button
                  onClick={() => { setContactId(""); setContactQ(""); }}
                  data-testid="reclassify-contact-clear"
                  className="ml-auto text-[11px] text-slate-500 hover:text-slate-800 underline"
                >
                  Clear
                </button>
              )}
            </div>
            {selectedContact ? (
              <div
                data-testid="reclassify-contact-selected"
                className="flex items-center gap-2 border rounded-md bg-white px-2.5 py-1.5 text-sm"
              >
                <Check size={13} className="text-emerald-600" />
                <span className="flex-1 truncate">{selectedContact.name}</span>
              </div>
            ) : (
              <div className="relative">
                <input
                  placeholder="Search contacts…"
                  value={contactQ}
                  onChange={(e) => { setContactQ(e.target.value); setShowContactList(true); }}
                  onFocus={() => setShowContactList(true)}
                  data-testid="reclassify-contact-search"
                  className="w-full border rounded-md px-2.5 py-1.5 text-sm bg-white"
                />
                {showContactList && contactQ.trim() && (
                  <div className="absolute z-10 left-0 right-0 mt-1 max-h-40 overflow-y-auto bg-white border rounded-md shadow-sm divide-y">
                    {contactOptions.length === 0 ? (
                      <div className="py-3 text-center text-xs text-slate-500">No matches.</div>
                    ) : contactOptions.map(c => (
                      <button
                        key={c.id}
                        onClick={() => {
                          setContactId(c.id);
                          setContactQ("");
                          setShowContactList(false);
                        }}
                        data-testid={`reclassify-contact-option-${c.id}`}
                        className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-sm"
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="px-5 py-3 border-b">
          <input
            autoFocus
            placeholder="Search by name or code…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="reclassify-search"
            className="w-full border rounded-md px-2.5 py-1.5 text-sm"
          />
        </div>
        <div className="overflow-y-auto flex-1 divide-y">
          {options.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-500">No matches.</div>
          ) : options.map(a => (
            <button
              key={a.id}
              onClick={() => apply(a.id)}
              data-testid={`reclassify-option-${a.code || a.id}`}
              className="w-full text-left px-5 py-2.5 hover:bg-slate-50 flex items-center gap-3"
            >
              <span className="text-xs text-slate-500 tabular-nums w-12">{a.code || ""}</span>
              <span className="flex-1 text-sm">{a.name}</span>
              <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                {a.type}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
