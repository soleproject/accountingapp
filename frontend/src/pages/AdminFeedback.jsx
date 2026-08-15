import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Inbox, Bug, Lightbulb, Loader2, Search, Filter, ChevronRight,
  Clock, CheckCircle2, XCircle, Send, ArrowLeft, Lock, Mail,
  BellOff, Bell,
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
 * AdminFeedback — superadmin triage inbox.
 *   • Filters: status tabs, type chips, Partner/Enterprise dropdowns, search
 *   • Detail pane: status buttons, per-item "Notify submitter" toggle,
 *     attachments gallery, notes thread (internal vs reporter-visible),
 *     compose box with visibility + email toggle.
 */
export default function AdminFeedback() {
  const [items, setItems] = useState(null);
  const [counts, setCounts] = useState({});
  const [tenants, setTenants] = useState({ partners: [], enterprises: [] });
  const [statusFilter, setStatusFilter] = useState(null);
  const [typeFilter, setTypeFilter] = useState(null);
  const [partnerFilter, setPartnerFilter] = useState(""); // "" = All, "__none__" = orphans, else id
  const [enterpriseFilter, setEnterpriseFilter] = useState("");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState(null);

  const load = async () => {
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (typeFilter) params.type = typeFilter;
      if (partnerFilter) params.partner_id = partnerFilter;
      if (enterpriseFilter) params.enterprise_id = enterpriseFilter;
      if (q.trim()) params.q = q.trim();
      const r = await api.get("/feedback", { params });
      setItems(r.data.items || []);
      setCounts(r.data.counts || {});
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't load feedback");
      setItems([]);
    }
  };
  const loadTenants = async () => {
    try {
      const r = await api.get("/feedback/tenants");
      setTenants(r.data || { partners: [], enterprises: [] });
    } catch { /* non-fatal */ }
  };
  useEffect(() => { loadTenants(); }, []);
  useEffect(() => { load(); /* eslint-disable-next-line */ },
    [statusFilter, typeFilter, partnerFilter, enterpriseFilter]);
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
    if (!selected) return null;
    try {
      const r = await api.patch(`/feedback/${selected.id}`, patch);
      setItems((prev) => (prev || []).map((i) => (i.id === selected.id ? r.data : i)));
      const c = await api.get("/feedback");
      setCounts(c.data.counts || {});
      loadTenants();
      return r.data;
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Update failed");
      return null;
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

      {/* Row 1: status + type + search */}
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
        {[["bug", "Bugs", Bug], ["recommendation", "Ideas", Lightbulb]].map(([k, label, Icon]) => {
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

      {/* Row 2: partner + enterprise dropdowns */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <span className="text-[11px] uppercase tracking-widest text-slate-500 flex items-center gap-1">
          <Filter size={12} /> Tenant
        </span>
        <select
          value={partnerFilter}
          onChange={(e) => setPartnerFilter(e.target.value)}
          data-testid="filter-partner"
          className="text-xs border border-slate-200 rounded-md px-2 py-1.5 bg-white focus:outline-none focus:border-slate-400 min-w-[180px]"
        >
          <option value="">All partners</option>
          {tenants.has_no_partner && <option value="__none__">— No partner —</option>}
          {(tenants.partners || []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select
          value={enterpriseFilter}
          onChange={(e) => setEnterpriseFilter(e.target.value)}
          data-testid="filter-enterprise"
          className="text-xs border border-slate-200 rounded-md px-2 py-1.5 bg-white focus:outline-none focus:border-slate-400 min-w-[200px]"
        >
          <option value="">All enterprises</option>
          {tenants.has_no_enterprise && <option value="__none__">— No enterprise —</option>}
          {(tenants.enterprises || []).map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
        {(partnerFilter || enterpriseFilter) && (
          <button
            onClick={() => { setPartnerFilter(""); setEnterpriseFilter(""); }}
            className="text-xs text-slate-500 hover:text-slate-800 underline"
            data-testid="filter-tenant-clear"
          >
            Clear tenant filters
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4">
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden max-h-[calc(100vh-300px)] overflow-y-auto">
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
                const attCount = (r.attachments || []).length;
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
                            {attCount > 0 && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200" title={`${attCount} attachment(s)`}>
                                📎 {attCount}
                              </span>
                            )}
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

        <div className="bg-white rounded-lg border border-slate-200 max-h-[calc(100vh-300px)] overflow-y-auto">
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
  const [noteVisibility, setNoteVisibility] = useState("internal"); // "internal" | "reporter"
  const [emailReporter, setEmailReporter] = useState(true);         // only relevant if reporter
  const [savingNote, setSavingNote] = useState(false);
  const [savingStatus, setSavingStatus] = useState(null);
  const [lightbox, setLightbox] = useState(null);

  const changeStatus = async (newStatus) => {
    if (newStatus === item.status) return;
    setSavingStatus(newStatus);
    try {
      const before = item.notify_submitter !== false;
      await onPatch({ status: newStatus });
      toast.success(
        `Status set to ${statusMeta(newStatus).label}${before ? " · reporter notified" : ""}`,
      );
    } finally {
      setSavingStatus(null);
    }
  };

  const toggleNotify = async () => {
    const next = item.notify_submitter === false; // flip: was false → true, was true/undef → false
    await onPatch({ notify_submitter: next });
    toast.success(next
      ? "Reporter will be emailed on future status changes"
      : "Reporter will NOT be emailed on status changes");
  };

  const addNote = async () => {
    if (!note.trim()) return;
    setSavingNote(true);
    try {
      await onPatch({
        admin_note: note.trim(),
        note_visibility: noteVisibility,
        email_reporter: noteVisibility === "reporter" && emailReporter,
      });
      setNote("");
      if (noteVisibility === "reporter" && emailReporter) {
        toast.success("Reply sent to reporter (email + in-app)");
      } else if (noteVisibility === "reporter") {
        toast.success("Reply posted (visible to reporter in-app)");
      } else {
        toast.success("Internal note added");
      }
    } finally {
      setSavingNote(false);
    }
  };

  const TypeIcon = item.type === "bug" ? Bug : Lightbulb;
  const notifyOn = item.notify_submitter !== false;

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
        <button
          onClick={toggleNotify}
          data-testid="toggle-notify-submitter"
          title={notifyOn
            ? "Reporter is being emailed on status changes — click to mute"
            : "Reporter notifications are muted — click to re-enable"}
          className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border transition ${
            notifyOn
              ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
              : "bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100"
          }`}
        >
          {notifyOn ? <Bell size={12} /> : <BellOff size={12} />}
          {notifyOn ? "Notify submitter" : "Muted"}
        </button>
      </div>

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

      <div className="mt-5">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-500 mb-1">
          Description
        </div>
        <div className="text-sm text-slate-700 whitespace-pre-wrap bg-slate-50 border border-slate-200 rounded-md p-3 min-h-[60px]">
          {item.description || <span className="text-slate-400">No description provided.</span>}
        </div>
      </div>

      {(item.attachments || []).length > 0 && (
        <div className="mt-4">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-500 mb-2">
            Attachments ({item.attachments.length})
          </div>
          <div className="grid grid-cols-3 gap-2" data-testid="detail-attachments">
            {item.attachments.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setLightbox(a)}
                className="group relative border border-slate-200 rounded overflow-hidden hover:ring-2 hover:ring-cyan-300"
                data-testid={`attachment-${a.id}`}
              >
                <img src={a.data_url} alt={a.filename} className="w-full h-28 object-cover" />
                <div className="absolute inset-x-0 bottom-0 bg-slate-900/60 text-white text-[10px] px-1 py-0.5 truncate">
                  {a.filename}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
        <div>
          <div className="text-slate-500">Reporter</div>
          <div className="text-slate-800 mt-0.5 break-all">
            {item.submitter_name || "—"}<br />
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

      <div className="mt-6">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-500 mb-2">
          Notes ({(item.admin_notes || []).length})
        </div>
        <div className="space-y-2">
          {(item.admin_notes || []).map((n) => {
            const isInternal = (n.visibility || "internal") === "internal";
            return (
              <div
                key={n.id}
                className={`text-sm border rounded p-3 ${isInternal
                  ? "bg-slate-50 border-slate-200"
                  : "bg-cyan-50 border-cyan-200"}`}
                data-testid={`note-${n.id}`}
              >
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest mb-1">
                  {isInternal
                    ? <span className="inline-flex items-center gap-1 text-slate-500"><Lock size={10}/> Internal</span>
                    : <span className="inline-flex items-center gap-1 text-cyan-700"><Mail size={10}/> Reply to reporter{n.email_sent ? " · emailed" : ""}</span>}
                </div>
                <div className="whitespace-pre-wrap text-slate-700">{n.note}</div>
                <div className="text-[10px] text-slate-500 mt-1">
                  {n.author_name} · {fmtWhen(n.at)}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-3 border border-slate-200 rounded-md p-3">
          <div className="flex items-center gap-2 mb-2">
            {[
              { key: "internal", label: "Internal note", Icon: Lock },
              { key: "reporter", label: "Reply to reporter", Icon: Mail },
            ].map(({ key, label, Icon }) => {
              const active = noteVisibility === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setNoteVisibility(key)}
                  data-testid={`note-visibility-${key}`}
                  className={`inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md border transition ${
                    active
                      ? "bg-slate-900 text-white border-slate-900"
                      : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  <Icon size={11} /> {label}
                </button>
              );
            })}
            {noteVisibility === "reporter" && (
              <label className="inline-flex items-center gap-1 text-[11px] text-slate-600 ml-auto cursor-pointer">
                <input
                  type="checkbox"
                  checked={emailReporter}
                  onChange={(e) => setEmailReporter(e.target.checked)}
                  data-testid="note-email-reporter"
                  className="rounded"
                />
                Also email
              </label>
            )}
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={noteVisibility === "internal"
              ? "Internal note — only superadmins see this."
              : "Write a reply to the reporter — they'll see it in their feedback inbox."}
            className="w-full border border-slate-200 rounded-md p-2 text-sm focus:outline-none focus:border-slate-400 resize-none"
            data-testid="admin-note-input"
          />
          <div className="flex items-center justify-end mt-2">
            <button
              onClick={addNote}
              disabled={savingNote || !note.trim()}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-cyan-600 text-white text-sm hover:bg-cyan-700 disabled:opacity-50"
              data-testid="admin-note-submit"
            >
              {savingNote ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
              {noteVisibility === "reporter"
                ? (emailReporter ? "Send + Post" : "Post reply")
                : "Post note"}
            </button>
          </div>
        </div>
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-[1200] bg-slate-900/80 flex items-center justify-center p-6"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox.data_url} alt={lightbox.filename} className="max-h-[90vh] max-w-[90vw] object-contain" />
        </div>
      )}
    </div>
  );
}
