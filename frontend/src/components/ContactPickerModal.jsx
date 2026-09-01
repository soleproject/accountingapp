import { useMemo, useState } from "react";
import { X, User, Trash2 } from "lucide-react";

/**
 * Compact modal used by bulk actions on the Transactions grid to
 * re-tag or clear the contact on a set of transactions in one call.
 * Category is intentionally NOT touched — for that flow, use
 * `ReclassifyPicker` which now also supports optional contact.
 *
 * Props
 * -----
 * contacts   [{id,name}]      — list to search
 * count      number           — selected row count (title copy)
 * onCancel   () => void
 * onApply    (id | null) => void  — null means "clear contact"
 */
export default function ContactPickerModal({ contacts, count, onCancel, onApply }) {
  const [q, setQ] = useState("");

  const options = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (contacts || [])
      .filter(c => !s || (c.name || "").toLowerCase().includes(s))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      .slice(0, 200);
  }, [contacts, q]);

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md flex flex-col max-h-[80vh]">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <div>
            <h3 className="font-heading font-semibold flex items-center gap-2">
              <User size={14} className="text-slate-500" />
              Set contact on {count} transaction{count !== 1 ? "s" : ""}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Pick a contact to apply, or clear the contact on all selected rows.
            </p>
          </div>
          <button onClick={onCancel} data-testid="contact-picker-close">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-3 border-b">
          <input
            autoFocus
            placeholder="Search contacts…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="contact-picker-search"
            className="w-full border rounded-md px-2.5 py-1.5 text-sm"
          />
        </div>

        <div className="overflow-y-auto flex-1 divide-y">
          <button
            onClick={() => onApply(null)}
            data-testid="contact-picker-clear"
            className="w-full text-left px-5 py-2.5 hover:bg-rose-50 flex items-center gap-3 text-rose-600"
          >
            <Trash2 size={13} />
            <span className="flex-1 text-sm">Clear contact (set to none)</span>
          </button>
          {options.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-500">
              {q ? "No matches." : "No contacts yet."}
            </div>
          ) : options.map(c => (
            <button
              key={c.id}
              onClick={() => onApply(c.id)}
              data-testid={`contact-picker-option-${c.id}`}
              className="w-full text-left px-5 py-2.5 hover:bg-slate-50 flex items-center gap-3"
            >
              <span className="flex-1 text-sm">{c.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
