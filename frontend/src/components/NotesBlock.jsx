import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  StickyNote, Loader2, Pin, PinOff, Trash2, Send, Pencil, Check, X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

/**
 * NotesBlock — reusable notes list + composer for any entity.
 * Drop this into any detail page/modal to enable per-entity
 * free-form notes powered by `/api/companies/{cid}/notes`.
 *
 * Props:
 *   entityType (string, required) — e.g. "employee", "project"
 *   entityId   (string, required)
 *   title      (string, optional) — override the card header
 *   compact    (bool)              — hides card chrome, useful in modals
 */
export default function NotesBlock({ entityType, entityId, title = "Notes", compact = false }) {
  const { currentId } = useCompany();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null); // {id, body}

  const load = async () => {
    if (!currentId || !entityType || !entityId) return;
    setLoading(true);
    try {
      const r = await api.get(
        `/companies/${currentId}/notes?entity_type=${entityType}&entity_id=${entityId}`);
      setRows(r.data?.notes || []);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId, entityType, entityId]);

  const add = async () => {
    if (!draft.trim() || creating) return;
    setCreating(true);
    try {
      await api.post(`/companies/${currentId}/notes`, {
        body: draft.trim(), entity_type: entityType, entity_id: entityId,
      });
      setDraft("");
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally { setCreating(false); }
  };
  const togglePin = async (n) => {
    try {
      await api.patch(`/companies/${currentId}/notes/${n.id}`,
        { pinned: !n.pinned });
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };
  const remove = async (n) => {
    if (!confirm("Delete this note?")) return;
    try {
      await api.delete(`/companies/${currentId}/notes/${n.id}`);
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };
  const saveEdit = async () => {
    if (!editing?.body?.trim()) return;
    try {
      await api.patch(`/companies/${currentId}/notes/${editing.id}`,
        { body: editing.body.trim() });
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const inner = (
    <>
      <ul className="space-y-2" data-testid={`notes-list-${entityType}-${entityId}`}>
        {loading && (
          <li className="text-center py-4 text-slate-500 text-xs">
            <Loader2 size={12} className="inline animate-spin mr-1" /> Loading…
          </li>
        )}
        {!loading && rows.length === 0 && (
          <li className="text-center py-3 text-slate-400 text-xs italic">
            No notes yet. Add one below.
          </li>
        )}
        {rows.map(n => (
          <li key={n.id}
              className={`group rounded-lg border p-2.5 ${n.pinned ? "border-amber-200 bg-amber-50/40" : "border-slate-200 bg-white"}`}
              data-testid={`notes-item-${n.id}`}>
            {editing?.id === n.id ? (
              <div className="space-y-1.5">
                <textarea value={editing.body}
                            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                            rows={3}
                            data-testid={`notes-edit-${n.id}`}
                            className="w-full text-sm border border-slate-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-slate-500 resize-y" />
                <div className="flex justify-end gap-1">
                  <button onClick={() => setEditing(null)}
                            className="text-xs px-2 py-1 rounded text-slate-500 hover:bg-slate-100">
                    <X size={11} className="inline" /> Cancel
                  </button>
                  <button onClick={saveEdit}
                            data-testid={`notes-edit-save-${n.id}`}
                            className="text-xs px-2 py-1 rounded bg-slate-900 text-white hover:bg-slate-800 inline-flex items-center gap-1">
                    <Check size={11} /> Save
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="text-sm text-slate-800 whitespace-pre-wrap break-words">{n.body}</div>
                <div className="flex items-center justify-between mt-1.5 text-[10px] text-slate-500">
                  <span>
                    <span className="font-medium text-slate-700">{n.author_name}</span>
                    <span className="text-slate-400"> · {formatRelative(n.created_at)}</span>
                    {n.updated_at !== n.created_at && <span className="italic text-slate-400"> · edited</span>}
                  </span>
                  <div className="flex opacity-0 group-hover:opacity-100 transition gap-0.5">
                    <button onClick={() => togglePin(n)}
                              title={n.pinned ? "Unpin" : "Pin to top"}
                              data-testid={`notes-pin-${n.id}`}
                              className={`p-1 rounded hover:bg-slate-100 ${n.pinned ? "text-amber-600" : "text-slate-400 hover:text-slate-700"}`}>
                      {n.pinned ? <PinOff size={11} /> : <Pin size={11} />}
                    </button>
                    <button onClick={() => setEditing({ id: n.id, body: n.body })}
                              title="Edit"
                              data-testid={`notes-edit-btn-${n.id}`}
                              className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700">
                      <Pencil size={11} />
                    </button>
                    <button onClick={() => remove(n)}
                              title="Delete"
                              data-testid={`notes-delete-${n.id}`}
                              className="p-1 rounded hover:bg-rose-50 text-slate-400 hover:text-rose-500">
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2 items-start">
        <textarea value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add();
                    }}
                    rows={2}
                    placeholder="Add a note… (⌘/Ctrl+Enter to save)"
                    data-testid={`notes-draft-${entityType}-${entityId}`}
                    className="flex-1 text-sm border border-slate-300 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-slate-500 resize-y" />
        <button onClick={add}
                  disabled={!draft.trim() || creating}
                  data-testid={`notes-add-${entityType}-${entityId}`}
                  className="shrink-0 inline-flex items-center gap-1 px-3 py-2 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50">
          {creating ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
          Post
        </button>
      </div>
    </>
  );

  if (compact) return <div className="space-y-2">{inner}</div>;

  return (
    <div className="rounded-xl border bg-white p-4 space-y-2">
      <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
        <StickyNote size={14} className="text-slate-500" /> {title}
        <span className="text-xs text-slate-400 font-normal">({rows.length})</span>
      </div>
      {inner}
    </div>
  );
}

function formatRelative(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000; // seconds
  if (diff < 60)   return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return d.toISOString().slice(0, 10);
}
