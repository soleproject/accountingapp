import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Sparkles, Undo2, Check, ExternalLink, Loader2, PencilLine } from "lucide-react";
import { api } from "@/lib/api";
import ContactPickerModal from "@/components/ContactPickerModal";

/**
 * AI Auto-Cleanup tile — one card, dropdown of per-pattern rows.
 *
 * Each row surfaces:
 *   • before → after labels
 *   • row count + sample descriptor
 *   • Save-as-rule toggle (marks the pattern as trusted going forward)
 *   • "See rows" link into /transactions?ids=…
 *   • Acknowledge (mark reviewed) and Undo (per-pattern revert) buttons
 *
 * The patterns come pre-hydrated from the responsibilities endpoint —
 * we only issue write calls (undo/acknowledge) here.
 */
export default function AiAutoCleanupTile({ companyId, patterns = [], onChanged }) {
  const [busy, setBusy] = useState({});
  const [ruleFlags, setRuleFlags] = useState(
    Object.fromEntries(patterns.map(p => [p.applied_id, !!p.save_as_rule]))
  );
  // Contact picker state — non-null when the CPA hit "Edit" on a row.
  const [editing, setEditing] = useState(null);   // pattern being reassigned
  const [contacts, setContacts] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);

  // Lazy-load the contacts list ONCE when the first Edit fires, so
  // the tile is cheap on render but ready when the CPA needs it.
  useEffect(() => {
    if (!editing || contacts.length || contactsLoading) return;
    setContactsLoading(true);
    api.get(`/companies/${companyId}/contacts?limit=1000`)
      .then(r => setContacts(r.data?.contacts || r.data || []))
      .catch(() => toast.error("Couldn't load contacts"))
      .finally(() => setContactsLoading(false));
  }, [editing, contacts.length, contactsLoading, companyId]);

  const setBusyFor = (id, v) => setBusy(b => ({ ...b, [id]: v }));

  const undo = async (p) => {
    setBusyFor(p.applied_id, "undo");
    try {
      const r = await api.post(
        `/companies/${companyId}/reviewv2/cleanup-applied/${p.applied_id}/undo`);
      toast.success(
        `Undone · ${r.data?.affected ?? p.count} row${(r.data?.affected ?? p.count) === 1 ? "" : "s"} restored`
      );
      onChanged && onChanged();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Undo failed");
    } finally {
      setBusyFor(p.applied_id, false);
    }
  };

  const acknowledge = async (p) => {
    setBusyFor(p.applied_id, "ack");
    try {
      await api.post(
        `/companies/${companyId}/reviewv2/cleanup-applied/${p.applied_id}/acknowledge`,
        { save_as_rule: !!ruleFlags[p.applied_id] });
      toast.success(
        ruleFlags[p.applied_id]
          ? `Saved '${p.contact_name}' rule · pattern acknowledged`
          : `Pattern acknowledged`
      );
      onChanged && onChanged();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't acknowledge");
    } finally {
      setBusyFor(p.applied_id, false);
    }
  };

  const reassign = async (contactId, newName) => {
    if (!editing) return;
    setBusyFor(editing.applied_id, "reassign");
    try {
      const body = contactId
        ? { contact_id: contactId }
        : { contact_name: (newName || "").trim() };
      const r = await api.post(
        `/companies/${companyId}/reviewv2/cleanup-applied/${editing.applied_id}/reassign`,
        body);
      toast.success(
        `Reassigned ${r.data?.affected ?? editing.count} row${(r.data?.affected ?? editing.count) === 1 ? "" : "s"} to '${r.data?.contact_name}'`
      );
      setEditing(null);
      onChanged && onChanged();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Reassign failed");
    } finally {
      setBusyFor(editing.applied_id, false);
    }
  };

  const createContactInline = async (name) => {
    const r = await api.post(`/companies/${companyId}/contacts`,
      { name: name.trim(), type: "vendor" });
    // Refresh local list so the just-created contact appears in it.
    const updated = [...contacts, r.data];
    setContacts(updated);
    return r.data;
  };

  if (!patterns.length) {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-4 text-xs text-slate-500"
           data-testid="ai-auto-cleanup-empty">
        No pending AI cleanup patterns.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white overflow-hidden"
         data-testid="ai-auto-cleanup-tile">
      <div className="px-3 py-2 border-b border-slate-100 bg-slate-50 flex items-center gap-2 text-[11px] uppercase tracking-wider text-slate-600">
        <Sparkles size={12} className="text-indigo-600" />
        Auto-applied by AI — review, undo, or acknowledge
      </div>
      <ul className="divide-y divide-slate-100">
        {patterns.map(p => {
          const b = busy[p.applied_id];
          const beforeStr = (p.before_labels || []).slice(0, 3).join(", ") || "—";
          const seeRowsHref = `/transactions?ids=${(p.txn_ids || []).slice(0, 50).join(",")}`;
          return (
            <li key={p.applied_id}
                className="p-3 flex flex-col gap-2"
                data-testid={`ai-auto-cleanup-row-${p.applied_id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-slate-900">
                    <b>{p.count}</b> row{p.count === 1 ? "" : "s"}{" "}
                    <span className="text-slate-500">from</span>{" "}
                    <span className="text-slate-700">{beforeStr}</span>{" "}
                    <span className="text-slate-500">→</span>{" "}
                    <b className="text-emerald-800">{p.contact_name || "AI-picked"}</b>
                  </div>
                  {p.sample_description && (
                    <div className="mt-0.5 text-[11px] text-slate-500 truncate font-mono">
                      {p.sample_description}
                    </div>
                  )}
                </div>
                <Link
                  to={seeRowsHref}
                  className="shrink-0 text-[11px] text-indigo-700 hover:text-indigo-900 hover:underline inline-flex items-center gap-0.5"
                  data-testid={`ai-auto-cleanup-see-rows-${p.applied_id}`}
                >
                  See rows <ExternalLink size={10} />
                </Link>
              </div>
              <div className="flex items-center flex-wrap gap-3">
                <label className="text-[11px] text-slate-600 inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    className="rounded border-slate-300"
                    checked={!!ruleFlags[p.applied_id]}
                    onChange={e => setRuleFlags(r => ({ ...r, [p.applied_id]: e.target.checked }))}
                    disabled={!!b}
                    data-testid={`ai-auto-cleanup-rule-${p.applied_id}`}
                  />
                  Save as rule
                </label>
                <div className="grow" />
                <button
                  type="button"
                  onClick={() => setEditing(p)}
                  disabled={!!b}
                  className="text-[11px] text-slate-700 hover:text-slate-900 inline-flex items-center gap-1 disabled:opacity-40"
                  data-testid={`ai-auto-cleanup-edit-${p.applied_id}`}
                >
                  {b === "reassign" ? <Loader2 size={11} className="animate-spin" /> : <PencilLine size={11} />}
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => undo(p)}
                  disabled={!!b}
                  className="text-[11px] text-slate-700 hover:text-slate-900 inline-flex items-center gap-1 disabled:opacity-40"
                  data-testid={`ai-auto-cleanup-undo-${p.applied_id}`}
                >
                  {b === "undo" ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />}
                  Undo
                </button>
                <button
                  type="button"
                  onClick={() => acknowledge(p)}
                  disabled={!!b}
                  className="text-[11px] rounded-full bg-indigo-600 hover:bg-indigo-700 text-white px-2.5 py-1 inline-flex items-center gap-1 disabled:opacity-40"
                  data-testid={`ai-auto-cleanup-ack-${p.applied_id}`}
                >
                  {b === "ack" ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                  Looks right
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {editing && (
        <ContactPickerModal
          contacts={contacts}
          count={editing.count}
          onCancel={() => setEditing(null)}
          onApply={(id) => reassign(id, null)}
          onCreateContact={async (name) => {
            const c = await createContactInline(name);
            return c;
          }}
        />
      )}
    </div>
  );
}
