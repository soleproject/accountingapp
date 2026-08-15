import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Inbox, Bug, Lightbulb, Loader2, Search, Filter, ChevronRight,
  Clock, CheckCircle2, XCircle, Send, ArrowLeft,
} from "lucide-react";

const STATUSES = [
  { key: "new",         label: "New",         color: "bg-slate-100 text-slate-700",   Icon: Clock },
  { key: "in_progress", label: "In progress", color: "bg-amber-100 text-amber-800",   Icon: Clock },
  { key: "completed",   label: "Completed",   color: "bg-emerald-100 text-emerald-800", Icon: CheckCircle2 },
  { key: "wont_do",     label: "Won't do",    color: "bg-slate-100 text-slate-500",   Icon: XCircle },
];

function statusMeta(key) {
  return STATUSES.find((s) => s.key === key) || STATUSES[0];
}

function fmtWhen(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

/**
 * AdminFeedback — superadmin triage inbox. Left column is a filterable
 * list of feedback tickets; right column is the currently-selected
 * ticket's detail with an inline status changer and an admin-notes
 * thread (append-only).
 *
 * Product decision (choice 3b): status changes are in-app only — no
 * emails go back to the submitter. Submitters see updates on their
 * `/feedback/mine` page.
 */
export default function AdminFeedback() {
  const [items, setItems] = useState(null);
  const [counts, setCounts] = useState({});
  const [statusFilter, setStatusFilter] = useState(null); // null = All
  const [typeFilter, setTypeFilter] = useState(null);     // null = All
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState(null);

  const load = async () => {
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (typeFilter) params.type = typeFilter;
      if (q.trim()) params.q = q.trim();
      const r = await api.get("/feedback", { params });
      setItems(r.data.items || []);
      setCounts(r.data.counts || {});
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't load feedback");
      setItems([]);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [statusFilter, typeFilter]);
  // Debounce search — reload when q settles
  useEffect(() => {
    const h = setTimeout(load, 300);
    return () => clearTimeout(h);
    // eslint-disable-next-line
  }, [q]);

  const selected = useMemo(
    () => (items || []).find((i) => i.id === selectedId) || null,
    [items, selectedId],
  );

  const patchSelected = async (patch) => {
    if (!selected) return;
    try {
      const r = await api.patch(`/feedback/${selected.id}`, patch);
      setItems((prev) => (prev || []).map((i) => (i.id === selected.id ? r.data : i)));
      // Refresh counts too
      const c = await api.get("/feedback");
      setCounts(c.data.counts || {});
      return r.data;
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Update failed");
    }
  };

  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="max-w-7xl mx-auto p-6" data-testid="admin-feedback-page">
      <div className="flex items-start gap-3 mb-6">
        <Inbox className="text-cyan-600 mt-0.5" size={22} />
        <div>
          <h1 className="text-2xl font-heading font-bold text-slate-900">Feedback inbox</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Bugs and product recommendations submitted by users across every role.
          </p>
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <button
          onClick={() => setStatusFilter(null)}
          data-testid="filter-status-all"
          className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
            statusFilter === null
              ? "bg-slate-900 text-white border-slate-900"
              : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
          }`}
        >
          All <span className="opacity-70 ml-1">{totalAll}</span>
        </button>
        {STATUSES.map((s) => {
          const active = statusFilter === s.key;
          return (
            <button
              key={s.key}
              onClick={() => setStatusFilter(active ? null : s.key)}
              data-testid={`filter-status-${s.key}`}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                active
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
            >
              {s.label} <span className="opacity-70 ml-1">{counts[s.key] || 0}</span>
            </button>
          );
        })}
        <div className="mx-1 h-5 w-px bg-slate-200" />
        {[
          ["bug", "Bugs", Bug],
          ["recommendation", "Ideas", Lightbulb],
        ].map(([k, label, Icon]) => {
          const active = typeFilter === k;
          return (
            <button
              key={k}
              onClick={() => setTypeFilter(active ? null : k)}
              data-testid={`filter-type-${k}`}
              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium border ${
                active
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
            >
              <Icon size={12} /> {label}
            </button>
          );
        })}
        <div className="ml-auto relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title, description, email…"
            className="pl-9 pr-3 py-1.5 rounded-md border border-slate-200 text-sm w-72 focus:outline-none focus:border-slate-400"
            data-testid="feedback-search"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4">
        {/* LIST */}
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden max-h-[calc(100vh-260px)] overflow-y-auto">
          {items === null ? (
            <div className="p-10 text-center text-slate-400 text-sm">
              <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="p-10 text-center text-slate-500">
              <Filter size={20} className="mx-auto text-slate-300 mb-2" />
              <div className="text-sm">No feedback matches your filters.</div>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100" data-testid="feedback-list">
              {items.map((r) => {
                const meta = statusMeta(r.status);
                const TypeIcon = r.type === "bug" ? Bug : Lightbulb;
                const active = r.id === selectedId;
                return (
                  <li key={r.id}>
                    <button
                      onClick={() => setSelectedId(r.id)}
                      data-testid={`feedback-row-${r.id}`}
                      className={`w-full text-left p-4 hover:bg-slate-50 transition ${active ? "bg-cyan-50/60" : ""}`}
                    >
                      <div className="flex items-start gap-3">
                        <div className={`mt-0.5 shrink-0 p-1.5 rounded-md ${r.type === "bug" ? "bg-rose-50 text-rose-600" : "bg-cyan-50 text-cyan-600"}`}>
                          <TypeIcon size={14} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="font-medium text-slate-900 truncate">{r.title}</div>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full ${meta.color}`}>{meta.label}</span>
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                            {r.submitter_email || "—"} · {fmtWhen(r.created_at)}
                          </div>
                          {(r.partner_name || r.enterprise_name) && (
                            <div className="mt-1 flex items-center gap-1 flex-wrap">
                              {r.partner_name && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-50 text-fuchsia-700 border border-fuchsia-100 truncate max-w-[140px]">
                                  {r.partner_name}
                                </span>
                              )}
                              {r.enterprise_name && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-100 truncate max-w-[140px]">
                                  {r.enterprise_name}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <ChevronRight size={14} className="text-slate-300 shrink-0" />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* DETAIL */}
        <div className="bg-white rounded-lg border border-slate-200 max-h-[calc(100vh-260px)] overflow-y-auto">
          {!selected ? (
            <div className="p-10 text-center text-slate-400 text-sm">
              <Inbox size={20} className="mx-auto text-slate-300 mb-2" />
              Select a ticket to view details.
            </div>
          ) : (
            <FeedbackDetail
              item={selected}
              onPatch={patchSelected}
              onBack={() => setSelectedId(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function FeedbackDetail({ item, onPatch, onBack }) {
  const [note, setNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [savingStatus, setSavingStatus] = useState(null);

  const changeStatus = async (newStatus) => {
    if (newStatus === item.status) return;
    setSavingStatus(newStatus);
    try {
      await onPatch({ status: newStatus });
      toast.success(`Status set to ${statusMeta(newStatus).label}`);
    } finally {
      setSavingStatus(null);
    }
  };

  const addNote = async () => {
    if (!note.trim()) return;
    setSavingNote(true);
    try {
      await onPatch({ admin_note: note.trim() });
      setNote("");
    } finally {
      setSavingNote(false);
    }
  };

  const TypeIcon = item.type === "bug" ? Bug : Lightbulb;

  return (
    <div className="p-5" data-testid="feedback-detail">
      <button
        onClick={onBack}
        className="lg:hidden text-xs text-slate-500 hover:text-slate-800 mb-3 inline-flex items-center gap-1"
      >
        <ArrowLeft size={12} /> Back to list
      </button>

      <div className="flex items-start gap-3">
        <div className={`shrink-0 p-2 rounded-md ${item.type === "bug" ? "bg-rose-50 text-rose-600" : "bg-cyan-50 text-cyan-600"}`}>
          <TypeIcon size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-slate-500 uppercase tracking-widest">
            {item.type === "bug" ? "Bug report" : "Recommendation"}
          </div>
          <h2 className="text-lg font-semibold text-slate-900 mt-0.5">{item.title}</h2>
        </div>
      </div>

      {/* Status buttons */}
      <div className="flex items-center gap-2 flex-wrap mt-4">
        {STATUSES.map((s) => {
          const active = item.status === s.key;
          const busy = savingStatus === s.key;
          return (
            <button
              key={s.key}
              onClick={() => changeStatus(s.key)}
              disabled={busy}
              data-testid={`set-status-${s.key}`}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border transition ${
                active
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              } disabled:opacity-50`}
            >
              {busy ? <Loader2 size={12} className="inline animate-spin mr-1" /> : null}
              {s.label}
            </button>
          );
        })}
      </div>

      {/* Description */}
      <div className="mt-5">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-500 mb-1">
          Description
        </div>
        <div className="text-sm text-slate-700 whitespace-pre-wrap bg-slate-50 border border-slate-200 rounded-md p-3 min-h-[80px]">
          {item.description || <span className="text-slate-400">No description provided.</span>}
        </div>
      </div>

      {/* Context */}
      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
        <div>
          <div className="text-slate-500">Reporter</div>
          <div className="text-slate-800 mt-0.5 break-all">
            {item.submitter_name || "—"}
            <br />
            <span className="text-slate-500">{item.submitter_email}</span>
            <span className="text-[10px] uppercase tracking-widest text-slate-400 ml-1">
              · {item.submitter_role || "user"}
            </span>
          </div>
        </div>
        <div>
          <div className="text-slate-500">Filed</div>
          <div className="text-slate-800 mt-0.5">{fmtWhen(item.created_at)}</div>
        </div>
        <div>
          <div className="text-slate-500">Partner</div>
          <div className="text-slate-800 mt-0.5 break-all">
            {item.partner_name
              ? <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-fuchsia-50 text-fuchsia-700 border border-fuchsia-200">{item.partner_name}</span>
              : <span className="text-slate-400">—</span>}
          </div>
        </div>
        <div>
          <div className="text-slate-500">Enterprise</div>
          <div className="text-slate-800 mt-0.5 break-all">
            {item.enterprise_name
              ? <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">{item.enterprise_name}</span>
              : <span className="text-slate-400">—</span>}
          </div>
        </div>
        <div>
          <div className="text-slate-500">Company</div>
          <div className="text-slate-800 mt-0.5 break-all">{item.company_name || "—"}</div>
        </div>
        <div>
          <div className="text-slate-500">Page</div>
          <div className="text-slate-800 mt-0.5 break-all font-mono text-[11px]">{item.route || "—"}</div>
        </div>
        {item.user_agent && (
          <div className="col-span-2">
            <div className="text-slate-500">User agent</div>
            <div className="text-slate-600 mt-0.5 break-all text-[11px] font-mono">{item.user_agent}</div>
          </div>
        )}
      </div>

      {/* Notes thread */}
      <div className="mt-6">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-500 mb-2">
          Admin notes ({(item.admin_notes || []).length})
        </div>
        <div className="space-y-2">
          {(item.admin_notes || []).map((n) => (
            <div key={n.id} className="text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded p-3">
              <div className="whitespace-pre-wrap">{n.note}</div>
              <div className="text-[10px] text-slate-500 mt-1">
                {n.author_name} · {fmtWhen(n.at)}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-start gap-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Add an internal note (visible to submitter in their inbox)"
            className="flex-1 border border-slate-200 rounded-md p-2 text-sm focus:outline-none focus:border-slate-400 resize-none"
            data-testid="admin-note-input"
          />
          <button
            onClick={addNote}
            disabled={savingNote || !note.trim()}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-md bg-cyan-600 text-white text-sm hover:bg-cyan-700 disabled:opacity-50"
            data-testid="admin-note-submit"
          >
            {savingNote ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            Post
          </button>
        </div>
      </div>
    </div>
  );
}
