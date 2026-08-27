import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Layers, Plus, Loader2, Pencil, Check, X, Archive, ArchiveRestore, Trash2 } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

/**
 * Classes list page (Phase 2 advanced features, Feb 2026).
 *
 * Renders when the current company has `features.classes_enabled=true`.
 * Anywhere the sidebar link is hidden by the flag, deep-linking here
 * shows an inline "Enable Classes" panel instead of a broken empty
 * state — Pros invited by a partner may not know the toggle exists.
 *
 * Design: single flat list (no tree UI in this phase; parent nesting
 * is stored but rendered as an indented label). Inline rename via
 * the ✎ affordance keeps the list dense.
 */
export default function Classes() {
  const { currentId, current, classesEnabled, refresh } = useCompany();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null); // {id, name}
  const nav = useNavigate();

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(
        `/companies/${currentId}/classes` +
        (includeInactive ? "?include_inactive=1" : ""),
      );
      setRows(r.data?.classes || []);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId, includeInactive]);

  const byId = useMemo(
    () => Object.fromEntries(rows.map(r => [r.id, r])), [rows],
  );

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await api.post(`/companies/${currentId}/classes`, { name });
      setNewName("");
      toast.success(`Class "${name}" created`);
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally {
      setCreating(false);
    }
  };

  const saveRename = async (row) => {
    const name = (editing?.name || "").trim();
    if (!name || name === row.name) { setEditing(null); return; }
    try {
      await api.patch(`/companies/${currentId}/classes/${row.id}`, { name });
      toast.success("Renamed");
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const setActive = async (row, active) => {
    try {
      await api.patch(
        `/companies/${currentId}/classes/${row.id}`, { active },
      );
      toast.success(active ? "Restored" : "Archived");
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const hardDelete = async (row) => {
    if (!confirm(`Permanently delete "${row.name}"? This can't be undone.`)) return;
    try {
      await api.delete(
        `/companies/${currentId}/classes/${row.id}?hard=1`,
      );
      toast.success("Deleted");
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const turnOnClasses = async () => {
    try {
      await api.patch(`/companies/${currentId}/features`, {
        classes_enabled: true,
      });
      await refresh?.();
      toast.success("Classes enabled");
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  if (!classesEnabled) {
    // Deep-link fallback — sidebar hides the entry, but a URL landing
    // here still needs a sensible page. Offer the one-click enable
    // instead of an inscrutable empty list.
    return (
      <div className="max-w-2xl mx-auto py-16 text-center space-y-4" data-testid="classes-disabled-empty">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-cyan-50 text-cyan-600">
          <Layers size={26} />
        </div>
        <h2 className="text-xl font-semibold text-slate-900">Classes aren't enabled yet</h2>
        <p className="text-sm text-slate-600 max-w-md mx-auto">
          Turn on Classes to tag every transaction with a permanent business
          segment (a department, a product line, a location) so you can slice
          your P&amp;L along that axis. Toggle in Settings, or enable now:
        </p>
        <div className="flex justify-center gap-2 pt-2">
          <button
            onClick={turnOnClasses}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-cyan-600 text-white text-sm hover:bg-cyan-700"
            data-testid="classes-enable-btn"
          >
            <Check size={14} /> Enable Classes
          </button>
          <button
            onClick={() => nav("/settings")}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-slate-200 bg-white text-slate-700 text-sm hover:bg-slate-50"
          >
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6" data-testid="classes-page">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
            <Layers size={22} className="text-cyan-600" />
            Classes
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Permanent business segments for <span className="font-medium">{current?.name}</span>.
            Tag transactions with a class to slice reports along that axis.
          </p>
        </div>
        <label className="text-xs text-slate-600 flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            data-testid="classes-show-archived"
          />
          Show archived
        </label>
      </div>

      {/* Quick-add row */}
      <div className="flex gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") create(); }}
          placeholder="New class name…"
          data-testid="classes-new-input"
          className="flex-1 border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500"
        />
        <button
          onClick={create}
          disabled={!newName.trim() || creating}
          data-testid="classes-add-btn"
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-cyan-600 text-white text-sm font-medium hover:bg-cyan-700 disabled:opacity-50"
        >
          {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Add
        </button>
      </div>

      {/* List */}
      <div className="rounded-xl border bg-white overflow-hidden">
        {loading ? (
          <div className="p-6 text-center text-slate-500 text-sm">
            <Loader2 size={16} className="inline animate-spin mr-2" />
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-sm">
            No classes yet — add your first one above.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map(r => (
              <li
                key={r.id}
                className={`px-4 py-2.5 flex items-center gap-2 hover:bg-slate-50 ${r.active === false ? "opacity-60" : ""}`}
                data-testid={`class-row-${r.id}`}
              >
                <div className={`flex-1 min-w-0 ${r.parent_class_id ? "pl-4" : ""}`}>
                  {editing?.id === r.id ? (
                    <div className="flex gap-2 items-center">
                      <input
                        autoFocus
                        value={editing.name}
                        onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveRename(r);
                          if (e.key === "Escape") setEditing(null);
                        }}
                        data-testid={`class-rename-input-${r.id}`}
                        className="flex-1 border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500"
                      />
                      <button
                        onClick={() => saveRename(r)}
                        className="p-1 rounded hover:bg-slate-100 text-emerald-700"
                        data-testid={`class-rename-save-${r.id}`}
                      >
                        <Check size={14} />
                      </button>
                      <button
                        onClick={() => setEditing(null)}
                        className="p-1 rounded hover:bg-slate-100 text-slate-500"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 truncate">
                      <span className="text-sm text-slate-900 truncate" data-testid={`class-name-${r.id}`}>
                        {r.parent_class_id && byId[r.parent_class_id]
                          ? <span className="text-slate-400">{byId[r.parent_class_id].name} · </span>
                          : null}
                        {r.name}
                      </span>
                      {r.active === false && (
                        <span className="text-[10px] uppercase tracking-wider text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">archived</span>
                      )}
                    </div>
                  )}
                </div>
                {editing?.id !== r.id && (
                  <>
                    <button
                      onClick={() => setEditing({ id: r.id, name: r.name })}
                      className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
                      title="Rename"
                      data-testid={`class-edit-btn-${r.id}`}
                    >
                      <Pencil size={13} />
                    </button>
                    {r.active === false ? (
                      <button
                        onClick={() => setActive(r, true)}
                        className="p-1.5 rounded hover:bg-slate-100 text-emerald-700"
                        title="Restore"
                        data-testid={`class-restore-btn-${r.id}`}
                      >
                        <ArchiveRestore size={13} />
                      </button>
                    ) : (
                      <button
                        onClick={() => setActive(r, false)}
                        className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
                        title="Archive"
                        data-testid={`class-archive-btn-${r.id}`}
                      >
                        <Archive size={13} />
                      </button>
                    )}
                    <button
                      onClick={() => hardDelete(r)}
                      className="p-1.5 rounded hover:bg-red-50 text-red-500"
                      title="Delete (only if unused)"
                      data-testid={`class-delete-btn-${r.id}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
