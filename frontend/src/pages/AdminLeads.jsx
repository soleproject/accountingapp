/**
 * Superadmin > Leads page.
 *
 * Table of every submission from the public /refer/:slug landing page.
 * Filter by status + role + free-text; inline update status and notes;
 * copy email; delete stale leads.
 *
 * Route: /admin/leads (fenced to superadmin role).
 */
import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Inbox, Search, Loader2, ChevronLeft, Copy, Check, Trash2,
  Briefcase, User, Building2, HelpCircle, Filter, Mail, Phone,
  ExternalLink,
} from "lucide-react";

const ROLE_LABELS = {
  accounting_pro: { label: "Accounting Pro", icon: Briefcase, color: "text-cyan-700 bg-cyan-50 border-cyan-200" },
  business_owner: { label: "Business Owner", icon: User,      color: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  enterprise:     { label: "Enterprise",     icon: Building2, color: "text-violet-700 bg-violet-50 border-violet-200" },
  other:          { label: "Other",          icon: HelpCircle, color: "text-slate-700 bg-slate-50 border-slate-200" },
};

const STATUS_LABELS = {
  new:       { label: "New",       color: "bg-amber-100 text-amber-900 border-amber-200" },
  contacted: { label: "Contacted", color: "bg-blue-100 text-blue-900 border-blue-200" },
  qualified: { label: "Qualified", color: "bg-cyan-100 text-cyan-900 border-cyan-200" },
  converted: { label: "Converted", color: "bg-emerald-100 text-emerald-900 border-emerald-200" },
  dead:      { label: "Dead",      color: "bg-slate-100 text-slate-600 border-slate-200" },
};

const STATUS_ORDER = ["new", "contacted", "qualified", "converted", "dead"];

export default function AdminLeads() {
  const [data, setData] = useState(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState(null); // lead id

  const load = () => {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (roleFilter) params.set("role", roleFilter);
    if (q.trim()) params.set("q", q.trim());
    api.get(`/admin/leads?${params.toString()}`)
      .then(r => setData(r.data))
      .catch(() => setData({ items: [], total: 0, new_count: 0 }));
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [statusFilter, roleFilter]);

  const setStatus = async (id, status) => {
    await api.patch(`/admin/leads/${id}`, { status });
    toast.success(`Marked ${STATUS_LABELS[status].label}`);
    load();
  };

  const saveNotes = async (id, notes) => {
    await api.patch(`/admin/leads/${id}`, { notes });
    toast.success("Notes saved");
    load();
  };

  const remove = async (id) => {
    if (!window.confirm("Delete this lead? This cannot be undone.")) return;
    await api.delete(`/admin/leads/${id}`);
    toast.success("Lead deleted");
    load();
  };

  if (!data) return (
    <div className="p-10 text-center text-slate-400 text-sm">
      <Loader2 size={16} className="inline animate-spin mr-2" /> Loading leads…
    </div>
  );

  return (
    <div className="space-y-6" data-testid="admin-leads-page">
      <div className="flex items-center gap-3">
        <Link
          to="/admin"
          data-testid="leads-back-btn"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          <ChevronLeft size={14} /> Superadmin
        </Link>
        <Inbox className="text-cyan-600" size={22} />
        <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900">Leads</h1>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <StatTile label="Total" value={data.total} />
          <StatTile label="New" value={data.new_count} accent />
        </div>
      </div>

      {/* Filter bar */}
      <div className="rounded-lg border border-slate-200 bg-white p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search name, email, company…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
            data-testid="leads-search-input"
            className="w-full pl-8 pr-3 py-2 rounded-md border border-slate-300 text-sm focus:border-cyan-500 focus:ring-2 focus:ring-cyan-200 outline-none"
          />
        </div>
        <FilterSelect
          label="Status"
          value={statusFilter}
          onChange={setStatusFilter}
          options={[{ value: "", label: "All" }, ...STATUS_ORDER.map(s => ({ value: s, label: STATUS_LABELS[s].label }))]}
          testid="leads-status-filter"
        />
        <FilterSelect
          label="Role"
          value={roleFilter}
          onChange={setRoleFilter}
          options={[{ value: "", label: "All" }, ...Object.entries(ROLE_LABELS).map(([v, o]) => ({ value: v, label: o.label }))]}
          testid="leads-role-filter"
        />
        <button
          onClick={load}
          data-testid="leads-refresh-btn"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          <Filter size={14} /> Apply
        </button>
      </div>

      {/* Table */}
      {data.items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-12 text-center">
          <Inbox size={36} className="mx-auto text-slate-300 mb-3" />
          <div className="text-sm text-slate-500">
            No leads match your filters yet. When a visitor submits the
            referral form at <code className="px-1 rounded bg-slate-100 text-slate-700">/refer/:slug</code>,
            they'll appear here.
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Referred by</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Received</th>
                <th className="px-4 py-3 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((lead) => (
                <LeadRow
                  key={lead.id}
                  lead={lead}
                  expanded={expanded === lead.id}
                  onToggle={() => setExpanded(expanded === lead.id ? null : lead.id)}
                  onSetStatus={(s) => setStatus(lead.id, s)}
                  onSaveNotes={(n) => saveNotes(lead.id, n)}
                  onDelete={() => remove(lead.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, accent }) {
  return (
    <div
      data-testid={`leads-stat-${label.toLowerCase()}`}
      className={
        "rounded-md border px-3 py-1.5 " +
        (accent ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white")
      }
    >
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-lg font-bold text-slate-900 leading-tight">{value}</div>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options, testid }) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-600">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testid}
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 bg-white"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function LeadRow({ lead, expanded, onToggle, onSetStatus, onSaveNotes, onDelete }) {
  const [copied, setCopied] = useState(false);
  const [notes, setNotes] = useState(lead.notes || "");
  const roleInfo = ROLE_LABELS[lead.role] || ROLE_LABELS.other;
  const RoleIcon = roleInfo.icon;
  const statusInfo = STATUS_LABELS[lead.status] || STATUS_LABELS.new;

  const copyEmail = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(lead.email);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const received = useMemo(() => {
    try {
      return new Date(lead.created_at).toLocaleString();
    } catch { return lead.created_at; }
  }, [lead.created_at]);

  return (
    <>
      <tr
        className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition"
        onClick={onToggle}
        data-testid={`lead-row-${lead.id}`}
      >
        <td className="px-4 py-3">
          <div className="font-medium text-slate-900">{lead.name}</div>
          <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
            <Mail size={12} /> {lead.email}
            <button
              onClick={copyEmail}
              data-testid={`copy-email-${lead.id}`}
              className="text-slate-400 hover:text-cyan-600 transition"
              title="Copy email"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>
          {lead.company_name && (
            <div className="text-xs text-slate-500 mt-0.5">{lead.company_name}</div>
          )}
        </td>
        <td className="px-4 py-3">
          <span className={"inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium " + roleInfo.color}>
            <RoleIcon size={11} /> {roleInfo.label}
          </span>
        </td>
        <td className="px-4 py-3 text-xs text-slate-600">
          {lead.referrer_name ? (
            <span title={lead.referrer_slug ? `slug: ${lead.referrer_slug}` : ""}>
              {lead.referrer_name}
            </span>
          ) : (
            <span className="text-slate-400">
              {lead.ref_slug ? `?ref=${lead.ref_slug}` : "Direct"}
            </span>
          )}
        </td>
        <td className="px-4 py-3">
          <span className={"inline-flex rounded-full border px-2 py-0.5 text-xs font-medium " + statusInfo.color}>
            {statusInfo.label}
          </span>
        </td>
        <td className="px-4 py-3 text-xs text-slate-500">{received}</td>
        <td className="px-4 py-3 text-right">
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            data-testid={`delete-lead-${lead.id}`}
            className="text-slate-400 hover:text-rose-600 transition"
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-50 border-b border-slate-200" data-testid={`lead-expanded-${lead.id}`}>
          <td colSpan={6} className="px-4 py-4">
            <div className="grid md:grid-cols-2 gap-6">
              <div>
                <div className="text-xs font-semibold text-slate-700 mb-2">Update status</div>
                <div className="flex flex-wrap gap-2">
                  {STATUS_ORDER.map((s) => (
                    <button
                      key={s}
                      onClick={() => onSetStatus(s)}
                      data-testid={`set-status-${lead.id}-${s}`}
                      disabled={lead.status === s}
                      className={
                        "px-3 py-1 rounded-md text-xs font-medium border transition " +
                        (lead.status === s
                          ? STATUS_LABELS[s].color + " cursor-default"
                          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100")
                      }
                    >
                      {STATUS_LABELS[s].label}
                    </button>
                  ))}
                </div>

                <div className="text-xs font-semibold text-slate-700 mt-4 mb-2">Contact info</div>
                <div className="text-xs text-slate-600 space-y-1">
                  <div className="flex items-center gap-2">
                    <Mail size={12} className="text-slate-400" />
                    <a href={`mailto:${lead.email}`} className="text-cyan-700 hover:underline">
                      {lead.email}
                    </a>
                  </div>
                  {lead.phone && (
                    <div className="flex items-center gap-2">
                      <Phone size={12} className="text-slate-400" />
                      <a href={`tel:${lead.phone}`} className="text-cyan-700 hover:underline">
                        {lead.phone}
                      </a>
                    </div>
                  )}
                  {lead.source && (
                    <div className="text-slate-500">Source: <b>{lead.source}</b></div>
                  )}
                  {lead.ip && (
                    <div className="text-slate-400 font-mono text-[10px]">IP {lead.ip}</div>
                  )}
                </div>
              </div>

              <div>
                <div className="text-xs font-semibold text-slate-700 mb-2">Notes</div>
                <textarea
                  rows={5}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  data-testid={`notes-input-${lead.id}`}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm resize-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-200 outline-none"
                  placeholder="Follow-up context, call summaries, next actions…"
                />
                <div className="mt-2 flex justify-end">
                  <button
                    onClick={() => onSaveNotes(notes)}
                    data-testid={`save-notes-${lead.id}`}
                    className="inline-flex items-center gap-1.5 rounded-md bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-700"
                  >
                    Save notes
                  </button>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
