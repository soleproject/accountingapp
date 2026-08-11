/**
 * Global audit log — enterprise-grade record of every action taken on
 * the platform. Regular users see only their own actions; CPAs / pros
 * / superadmins see every event within any company they can access.
 *
 * Filters supported (all optional, all URL-persistent via query params):
 *   - date range (since / until)
 *   - event type (login, update, delete, impersonate_start, etc.)
 *   - entity type (transaction, invoice, company, account, ...)
 *   - actor (only-mine toggle)
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";

// Human-readable labels for the raw event_type enum. Add new kinds
// here as the taxonomy grows on the backend.
const EVENT_LABELS = {
  login:                "Signed in",
  login_failed:         "Failed sign-in",
  logout:               "Signed out",
  password_reset:       "Password reset",
  mfa_change:           "MFA changed",
  impersonate_start:    "Started impersonating",
  impersonate_stop:     "Stopped impersonating",
  create:               "Created",
  update:               "Updated",
  delete:               "Deleted",
  qbo_pull:             "QBO pull",
  qbo_push:             "QBO push",
  qbo_connect:          "QBO connected",
  qbo_disconnect:       "QBO disconnected",
  plaid_sync:           "Plaid sync",
  plaid_connect:        "Plaid connected",
  plaid_disconnect:     "Plaid disconnected",
  export:               "Exported",
};

// Colored pill per event type — quick visual scan.
const EVENT_COLORS = {
  login:              "bg-emerald-50 text-emerald-700 border-emerald-200",
  login_failed:       "bg-rose-50 text-rose-700 border-rose-200",
  logout:             "bg-slate-50 text-slate-600 border-slate-200",
  password_reset:     "bg-amber-50 text-amber-700 border-amber-200",
  mfa_change:         "bg-amber-50 text-amber-700 border-amber-200",
  impersonate_start:  "bg-purple-50 text-purple-700 border-purple-200",
  impersonate_stop:   "bg-purple-50 text-purple-700 border-purple-200",
  create:             "bg-blue-50 text-blue-700 border-blue-200",
  update:             "bg-sky-50 text-sky-700 border-sky-200",
  delete:             "bg-rose-50 text-rose-700 border-rose-200",
  qbo_pull:           "bg-indigo-50 text-indigo-700 border-indigo-200",
  qbo_push:           "bg-indigo-50 text-indigo-700 border-indigo-200",
  qbo_connect:        "bg-emerald-50 text-emerald-700 border-emerald-200",
  qbo_disconnect:     "bg-rose-50 text-rose-700 border-rose-200",
  plaid_sync:         "bg-cyan-50 text-cyan-700 border-cyan-200",
  plaid_connect:      "bg-emerald-50 text-emerald-700 border-emerald-200",
  plaid_disconnect:   "bg-rose-50 text-rose-700 border-rose-200",
  export:             "bg-teal-50 text-teal-700 border-teal-200",
};

const PAGE_SIZE = 50;

export default function AuditLog() {
  const { current } = useCompany();
  const [params, setParams] = useSearchParams();
  const cid = current?.id;

  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(null);   // event id whose diff panel is open

  // Filters — pulled from URL so an audit link can be shared with
  // filters preserved (e.g. copy the URL for a specific delete event
  // and paste it in a compliance ticket).
  const evtFilter    = params.get("event_type") || "";
  const entityFilter = params.get("entity_type") || "";
  const since        = params.get("since") || "";
  const until        = params.get("until") || "";
  const onlyMine     = params.get("only_mine") === "1";
  const scope        = params.get("scope") || "company";   // company | mine

  const updateFilter = (key, val) => {
    const next = new URLSearchParams(params);
    if (val) next.set(key, val); else next.delete(key);
    setParams(next);
    setPage(0);
  };

  useEffect(() => {
    if (!cid && scope !== "mine") return;
    setLoading(true);
    const qs = new URLSearchParams();
    if (evtFilter)    qs.set("event_type", evtFilter);
    if (entityFilter) qs.set("entity_type", entityFilter);
    if (since)        qs.set("since", since);
    if (until)        qs.set("until", until);
    if (onlyMine && scope === "company") qs.set("only_mine", "true");
    qs.set("limit", String(PAGE_SIZE));
    qs.set("skip", String(page * PAGE_SIZE));
    const url = scope === "mine"
      ? `/audit/me?${qs}`
      : `/companies/${cid}/audit?${qs}`;
    api.get(url)
      .then((r) => {
        setEvents(r.data.events || []);
        setTotal(r.data.total || 0);
      })
      .catch((e) => toast.error("Couldn't load audit log", { description: e?.message }))
      .finally(() => setLoading(false));
  }, [cid, scope, evtFilter, entityFilter, since, until, onlyMine, page]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-4" data-testid="audit-log-page">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-slate-900">Audit Log</h1>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            Every mutating action, sign-in, impersonation, and sync event
            with the platform. Full before-and-after snapshots for
            deletes and config changes; compact field-level diffs for
            routine edits. Retention: forever.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ScopeTab active={scope === "company"} onClick={() => updateFilter("scope", "")}>
            This company
          </ScopeTab>
          <ScopeTab active={scope === "mine"} onClick={() => updateFilter("scope", "mine")}>
            My actions
          </ScopeTab>
          {/* CSV export — respects every active filter. The download
              itself is meta-audited server-side so the trail records
              who pulled the trail (SOC 2 / SOX / discovery friendly). */}
          <button
            data-testid="audit-export-csv"
            onClick={() => {
              const qs = new URLSearchParams();
              if (evtFilter)    qs.set("event_type", evtFilter);
              if (entityFilter) qs.set("entity_type", entityFilter);
              if (since)        qs.set("since", since);
              if (until)        qs.set("until", until);
              if (onlyMine && scope === "company") qs.set("only_mine", "true");
              qs.set("limit", "50000");
              const path = scope === "mine"
                ? `${process.env.REACT_APP_BACKEND_URL}/api/audit/me.csv?${qs}`
                : `${process.env.REACT_APP_BACKEND_URL}/api/companies/${cid}/audit.csv?${qs}`;
              const token = localStorage.getItem("token");
              // Use fetch → blob so we can attach the Authorization
              // header (a plain <a href> can't). Then trigger a
              // synthetic anchor click to save under the server-set
              // filename.
              fetch(path, { headers: { Authorization: `Bearer ${token}` } })
                .then((r) => {
                  if (!r.ok) throw new Error(`Export failed (${r.status})`);
                  return r.blob().then((b) => ({
                    blob: b,
                    // Pull the filename from Content-Disposition
                    cd: r.headers.get("Content-Disposition") || "",
                  }));
                })
                .then(({ blob, cd }) => {
                  const m = /filename="([^"]+)"/.exec(cd);
                  const name = (m && m[1]) || `audit-${new Date().toISOString().slice(0, 10)}.csv`;
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url; a.download = name;
                  document.body.appendChild(a); a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                  toast.success("Audit log exported");
                })
                .catch((e) => toast.error("Export failed", { description: e?.message }));
            }}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md bg-white text-slate-700 border hover:bg-slate-50"
            title="Download the current filter selection as CSV"
          >
            Download CSV
          </button>
        </div>
      </header>

      {/* Filters */}
      <div className="rounded-lg border bg-white p-3 flex flex-wrap gap-2 items-center" data-testid="audit-filters">
        <FilterSelect
          label="Event"
          value={evtFilter}
          onChange={(v) => updateFilter("event_type", v)}
          testId="audit-filter-event"
          options={[
            ["", "Any event"],
            ...Object.entries(EVENT_LABELS),
          ]}
        />
        <FilterSelect
          label="Entity"
          value={entityFilter}
          onChange={(v) => updateFilter("entity_type", v)}
          testId="audit-filter-entity"
          options={[
            ["", "Any entity"],
            ["transaction", "Transaction"],
            ["invoice", "Invoice"],
            ["bill", "Bill"],
            ["company", "Company"],
            ["account", "Account (CoA)"],
            ["user", "User"],
            ["contact", "Contact"],
            ["item", "Item"],
            ["journal_entry", "Journal Entry"],
          ]}
        />
        <label className="text-xs text-slate-500 flex items-center gap-1">
          Since
          <input
            type="date"
            value={since}
            data-testid="audit-filter-since"
            onChange={(e) => updateFilter("since", e.target.value)}
            className="border rounded px-2 py-1 text-xs"
          />
        </label>
        <label className="text-xs text-slate-500 flex items-center gap-1">
          Until
          <input
            type="date"
            value={until}
            data-testid="audit-filter-until"
            onChange={(e) => updateFilter("until", e.target.value)}
            className="border rounded px-2 py-1 text-xs"
          />
        </label>
        {scope === "company" && (
          <label className="text-xs text-slate-500 flex items-center gap-1 ml-auto">
            <input
              type="checkbox"
              checked={onlyMine}
              data-testid="audit-filter-only-mine"
              onChange={(e) => updateFilter("only_mine", e.target.checked ? "1" : "")}
            />
            Only my actions
          </label>
        )}
      </div>

      {/* Results */}
      <div className="rounded-lg border bg-white overflow-hidden" data-testid="audit-events-table">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-widest">
            <tr>
              <th className="text-left px-3 py-2">Time</th>
              <th className="text-left px-3 py-2">Event</th>
              <th className="text-left px-3 py-2">Actor</th>
              <th className="text-left px-3 py-2">Entity</th>
              <th className="text-left px-3 py-2">Summary</th>
              <th className="text-right px-3 py-2 w-16">Diff</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="p-8 text-center text-slate-400">Loading…</td></tr>
            )}
            {!loading && events.length === 0 && (
              <tr><td colSpan={6} className="p-8 text-center text-slate-400">No events match.</td></tr>
            )}
            {events.map((e) => (
              <AuditRow key={e.id} event={e} expanded={expanded === e.id} onToggle={() => setExpanded(expanded === e.id ? null : e.id)} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <div>Showing {page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} of {total.toLocaleString()} events</div>
          <div className="flex gap-1">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="px-3 py-1 border rounded disabled:opacity-50 hover:bg-slate-50"
              data-testid="audit-page-prev"
            >Previous</button>
            <button
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              className="px-3 py-1 border rounded disabled:opacity-50 hover:bg-slate-50"
              data-testid="audit-page-next"
            >Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ScopeTab({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
        active
          ? "bg-slate-900 text-white"
          : "bg-white text-slate-600 border hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}

function FilterSelect({ label, value, onChange, options, testId }) {
  return (
    <label className="text-xs text-slate-500 flex items-center gap-1">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        className="border rounded px-2 py-1 text-xs min-w-[9rem]"
      >
        {options.map(([v, lbl]) => (
          <option key={v} value={v}>{lbl}</option>
        ))}
      </select>
    </label>
  );
}

function AuditRow({ event, expanded, onToggle }) {
  const label = EVENT_LABELS[event.event_type] || event.event_type;
  const colorCls = EVENT_COLORS[event.event_type] || "bg-slate-50 text-slate-600 border-slate-200";
  const ts = event.timestamp ? new Date(event.timestamp) : null;

  const diff = event.diff || {};
  const diffCount = Object.keys(diff).filter((k) => k !== "_id" && k !== "updated_at").length;

  return (
    <>
      <tr
        onClick={onToggle}
        className={`border-t hover:bg-slate-50/60 cursor-pointer ${expanded ? "bg-slate-50" : ""}`}
        data-testid={`audit-row-${event.id}`}
      >
        <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
          {ts ? ts.toLocaleString() : "—"}
        </td>
        <td className="px-3 py-2">
          <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold border ${colorCls}`}>
            {label}
          </span>
          {event.is_impersonation && (
            <span className="ml-1 inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-purple-50 text-purple-700 border-purple-200" title="Acted while impersonating">
              impersonated
            </span>
          )}
        </td>
        <td className="px-3 py-2 text-xs">
          <div className="font-medium text-slate-800">{event.actor_email || "—"}</div>
          <div className="text-slate-400">{event.actor_role || ""}</div>
        </td>
        <td className="px-3 py-2 text-xs">
          {event.entity_type && (
            <>
              <div className="font-medium text-slate-800">{event.entity_type}</div>
              {event.entity_id && (
                <code className="text-[10px] text-slate-400">{event.entity_id.slice(0, 8)}…</code>
              )}
            </>
          )}
        </td>
        <td className="px-3 py-2 text-xs text-slate-700 max-w-[24rem] truncate">
          {event.summary || <span className="text-slate-400">—</span>}
        </td>
        <td className="px-3 py-2 text-right text-xs">
          {diffCount > 0 && (
            <span className="text-slate-600 font-medium">{diffCount} field{diffCount === 1 ? "" : "s"}</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-50 border-t" data-testid={`audit-row-detail-${event.id}`}>
          <td colSpan={6} className="p-4">
            <AuditDetail event={event} />
          </td>
        </tr>
      )}
    </>
  );
}

function AuditDetail({ event }) {
  const diff = event.diff || {};
  const entries = Object.entries(diff).filter(([k]) => k !== "_id" && k !== "updated_at");

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <MetaCell label="Event ID" value={event.id} mono />
        <MetaCell label="IP" value={event.ip_address || "—"} mono />
        <MetaCell label="User-agent" value={(event.user_agent || "").slice(0, 60) + ((event.user_agent || "").length > 60 ? "…" : "")} />
        {event.is_impersonation && (
          <MetaCell label="Impersonated by" value={event.impersonator_email || event.impersonator_user_id || "—"} />
        )}
      </div>
      {entries.length > 0 && (
        <div className="rounded border bg-white overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-100 text-slate-500 text-[10px] uppercase tracking-widest">
              <tr>
                <th className="text-left px-3 py-2 w-40">Field</th>
                <th className="text-left px-3 py-2">Before</th>
                <th className="text-left px-3 py-2">After</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([field, [oldV, newV]]) => (
                <tr key={field} className="border-t">
                  <td className="px-3 py-2 font-mono text-slate-700">{field}</td>
                  <td className="px-3 py-2 text-rose-700 break-all">{fmtVal(oldV)}</td>
                  <td className="px-3 py-2 text-emerald-700 break-all">{fmtVal(newV)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {entries.length === 0 && (
        <div className="text-xs text-slate-400 italic">
          No field-level changes captured for this event.
        </div>
      )}
      {(event.before || event.after) && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-500 hover:text-slate-700 select-none">
            Full snapshot (JSON)
          </summary>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
            {event.before && (
              <pre className="bg-slate-900 text-slate-100 p-3 rounded text-[10px] overflow-x-auto max-h-96">{JSON.stringify(event.before, null, 2)}</pre>
            )}
            {event.after && (
              <pre className="bg-slate-900 text-slate-100 p-3 rounded text-[10px] overflow-x-auto max-h-96">{JSON.stringify(event.after, null, 2)}</pre>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function MetaCell({ label, value, mono }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-slate-400">{label}</div>
      <div className={`text-slate-700 ${mono ? "font-mono text-[11px]" : ""} truncate`}>{value}</div>
    </div>
  );
}

function fmtVal(v) {
  if (v === null || v === undefined) return <span className="text-slate-400 italic">null</span>;
  if (typeof v === "object") return <code className="text-[10px]">{JSON.stringify(v)}</code>;
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}
