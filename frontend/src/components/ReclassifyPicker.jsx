import { useMemo, useState } from "react";
import { X } from "lucide-react";

/**
 * Modal picker for choosing a target CoA account when bulk-reclassifying
 * transactions. Filters to revenue / expense / cogs plus owner-draw-style
 * rows a user might reasonably reclassify TO. Used by both the Contacts
 * report drawer and the main Transactions page.
 */
export default function ReclassifyPicker({
  accounts,
  count,
  onCancel,
  onApply,
  allowedTypes,   // e.g. null → all types; ["asset","liability"] → restricted
  title,          // override modal heading
  excludeIds,     // hide these account ids (used when moving OUT of an account)
}) {
  const [q, setQ] = useState("");

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

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md flex flex-col max-h-[80vh]">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <div>
            <h3 className="font-heading font-semibold">
              {title || `Reclassify ${count} transaction${count !== 1 ? "s" : ""}`}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">Pick the target category account.</p>
          </div>
          <button onClick={onCancel} data-testid="reclassify-close"><X size={16} /></button>
        </div>
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
              onClick={() => onApply(a.id)}
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
