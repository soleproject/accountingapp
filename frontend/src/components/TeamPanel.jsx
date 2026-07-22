/**
 * TeamPanel — one reusable UI for managing team invites across three
 * contexts:
 *   • mode="company"  — invite editors/reviewers/viewers to ONE company
 *   • mode="pro"      — Pro invites firm staff, picks which clients they'll get
 *   • mode="admin"    — superadmin invites pros/superadmins
 *
 * Kept intentionally in a single component so all three surfaces share the
 * same invite/revoke/list ergonomics — differences are only in what fields
 * the invite form exposes and which endpoint is hit.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { UserPlus, Loader2, X, Trash2, Users, MailCheck, ShieldCheck, ChevronDown, ChevronRight, Save } from "lucide-react";

const COMPANY_ROLE_OPTIONS = [
  { value: "editor",   label: "Editor",   hint: "Post JEs, categorize, reconcile" },
  { value: "reviewer", label: "Reviewer", hint: "Approve/reject entries only" },
  { value: "viewer",   label: "Viewer",   hint: "Read-only access" },
];

const ADMIN_ROLE_OPTIONS = [
  { value: "pro",        label: "Pro (accounting firm)", hint: "New firm with no clients yet" },
  { value: "superadmin", label: "Superadmin",            hint: "Platform-level admin" },
];

export default function TeamPanel({ mode, companyId, availableCompanies = [] }) {
  const [team, setTeam] = useState({ members: [], pending_invites: [] });
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const listUrl = useMemo(() => {
    if (mode === "company") return `/companies/${companyId}/team`;
    if (mode === "pro")     return `/pro/team`;
    return null;   // admin has no dedicated list — pending invites only
  }, [mode, companyId]);

  const load = async () => {
    if (!listUrl) return;
    setLoading(true);
    try {
      const r = await api.get(listUrl);
      setTeam(r.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't load team");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [listUrl]);

  const revoke = async (id) => {
    try {
      await api.delete(`/invites/${id}`);
      toast.success("Invitation revoked.");
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't revoke");
    }
  };

  return (
    <div className="space-y-4" data-testid={`team-panel-${mode}`}>
      <div className="flex items-center justify-between">
        <h2 className="font-heading font-semibold text-lg flex items-center gap-2">
          <Users size={16} className="text-slate-500" />
          {mode === "company" && "Team & permissions"}
          {mode === "pro" && "Firm staff"}
          {mode === "admin" && "Send an invitation"}
        </h2>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            data-testid={`team-invite-btn-${mode}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-slate-900 text-white hover:bg-slate-800"
          >
            <UserPlus size={13} /> Invite someone
          </button>
        )}
      </div>

      {showForm && (
        <InviteForm
          mode={mode}
          companyId={companyId}
          availableCompanies={availableCompanies}
          onClose={() => setShowForm(false)}
          onCreated={() => { setShowForm(false); load(); }}
        />
      )}

      {mode !== "admin" && (
        <>
          <SectionHeading label="Active members" count={team.members?.length || 0} />
          <div className="rounded-xl border bg-white divide-y" data-testid={`team-members-${mode}`}>
            {(team.members || []).map((m) => (
              <MemberRow
                key={`${m.user_id}-${(m.role || "").toString()}`}
                member={m}
                mode={mode}
                companyId={companyId}
                availableCompanies={availableCompanies}
                onChanged={load}
              />
            ))}
            {!team.members?.length && !loading && (
              <div className="p-6 text-center text-sm text-slate-500">
                {mode === "company" ? "No other members yet." : "No firm staff yet."}
              </div>
            )}
          </div>

          {(team.pending_invites || []).length > 0 && (
            <>
              <SectionHeading label="Pending invitations" count={team.pending_invites.length} />
              <div className="rounded-xl border bg-amber-50/40 border-amber-200 divide-y divide-amber-100" data-testid={`team-pending-${mode}`}>
                {team.pending_invites.map((i) => (
                  <div key={i.id} className="flex items-center justify-between p-3 text-sm">
                    <div>
                      <div className="font-medium text-slate-900 flex items-center gap-2">
                        <MailCheck size={12} className="text-amber-600" />
                        {i.email}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Invited {timeAgo(i.created_at)} · expires {timeAgo(i.expires_at, { future: true })}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <RoleBadge role={i.role} />
                      <button
                        onClick={() => revoke(i.id)}
                        data-testid={`team-revoke-${i.id}`}
                        title="Revoke invitation"
                        className="p-1.5 rounded-md text-slate-400 hover:text-rose-700 hover:bg-rose-50"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function MemberRow({ member, mode, companyId, availableCompanies, onChanged }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickedCids, setPickedCids] = useState(member.company_ids || []);
  const [role, setRole] = useState(member.role || "editor");

  const dirty =
    mode === "pro"
      ? JSON.stringify([...pickedCids].sort()) !== JSON.stringify([...(member.company_ids || [])].sort())
      : role !== member.role;

  const saveAccess = async () => {
    setBusy(true);
    try {
      await api.put(`/pro/staff/${member.user_id}/access`, { company_ids: pickedCids });
      toast.success(`${member.name || member.email}'s access updated.`);
      onChanged();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't save");
    } finally { setBusy(false); }
  };

  const saveRole = async () => {
    setBusy(true);
    try {
      await api.patch(`/companies/${companyId}/team/${member.user_id}`, { role });
      toast.success(`Role updated to ${role}.`);
      onChanged();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't save");
    } finally { setBusy(false); }
  };

  const remove = async () => {
    const who = member.name || member.email;
    const msg = mode === "pro"
      ? `Remove ${who} from your firm? They'll lose access to every client. This does not delete their account.`
      : `Remove ${who} from this company?`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      if (mode === "pro") {
        await api.delete(`/pro/staff/${member.user_id}`);
      } else {
        await api.delete(`/companies/${companyId}/team/${member.user_id}`);
      }
      toast.success(`${who} removed.`);
      onChanged();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't remove");
    } finally { setBusy(false); }
  };

  // Owner/Pro roles on a company are structural — no re-role, no removal.
  const structural = ["owner", "pro"].includes(member.role);

  return (
    <div data-testid={`team-member-${member.user_id}`}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between p-3 text-sm text-left hover:bg-slate-50"
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
          <div className="min-w-0">
            <div className="font-medium text-slate-900 truncate">{member.name || member.email}</div>
            <div className="text-xs text-slate-500 truncate">{member.email}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {mode === "pro" && member.company_ids?.length > 0 && (
            <span className="text-xs text-slate-500">{member.company_ids.length} clients</span>
          )}
          <RoleBadge role={member.role || "pro"} />
        </div>
      </button>

      {open && (
        <div className="p-4 pt-2 border-t bg-slate-50/50 space-y-3" data-testid={`team-member-expand-${member.user_id}`}>
          {mode === "pro" && (
            <div>
              <div className="text-xs font-semibold text-slate-700 mb-1">
                Client access <span className="font-normal text-slate-500">({pickedCids.length} of {availableCompanies.length})</span>
              </div>
              <div className="rounded-md border bg-white max-h-52 overflow-y-auto">
                {availableCompanies.length === 0 && (
                  <div className="p-3 text-xs text-slate-500 text-center">No clients on file.</div>
                )}
                {availableCompanies.map(c => (
                  <label key={c.id} className="flex items-center gap-2 p-2 text-sm hover:bg-slate-50 cursor-pointer border-b last:border-b-0">
                    <input
                      type="checkbox"
                      checked={pickedCids.includes(c.id)}
                      onChange={(e) => setPickedCids(prev => e.target.checked ? [...prev, c.id] : prev.filter(x => x !== c.id))}
                      data-testid={`team-member-client-${member.user_id}-${c.id}`}
                    />
                    <span className="flex-1">{c.name}</span>
                    <span className="text-xs text-slate-400">{c.business_type || ""}</span>
                  </label>
                ))}
              </div>
              <div className="text-[11px] text-slate-500 mt-1 flex items-center gap-2">
                <button
                  onClick={() => setPickedCids(availableCompanies.map(c => c.id))}
                  className="text-cyan-700 hover:underline"
                >Select all</button>
                <button
                  onClick={() => setPickedCids([])}
                  className="text-slate-500 hover:underline"
                >Clear</button>
              </div>
            </div>
          )}

          {mode === "company" && !structural && (
            <div>
              <div className="text-xs font-semibold text-slate-700 mb-1">Role</div>
              <div className="flex items-center gap-1 rounded-md border bg-white p-0.5 w-fit">
                {["editor", "reviewer", "viewer"].map(r => (
                  <button
                    key={r}
                    onClick={() => setRole(r)}
                    data-testid={`team-member-role-${member.user_id}-${r}`}
                    className={`px-2.5 py-1 text-xs rounded capitalize transition
                      ${role === r ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
                  >{r}</button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            {!structural && (
              <button
                onClick={remove}
                disabled={busy}
                data-testid={`team-member-remove-${member.user_id}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50"
              >
                <Trash2 size={12} /> {mode === "pro" ? "Remove from firm" : "Remove from company"}
              </button>
            )}
            {structural && <div />}
            <button
              onClick={mode === "pro" ? saveAccess : saveRole}
              disabled={busy || !dirty || structural}
              data-testid={`team-member-save-${member.user_id}`}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs rounded-md bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-40"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              Save changes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


function SectionHeading({ label, count }) {
  return (
    <div className="text-xs uppercase tracking-widest text-slate-500 font-semibold pt-1">
      {label} <span className="text-slate-400">({count})</span>
    </div>
  );
}

function RoleBadge({ role }) {
  const map = {
    owner:      { cls: "bg-emerald-50 text-emerald-800 border-emerald-200", label: "Owner" },
    pro:        { cls: "bg-cyan-50 text-cyan-800 border-cyan-200",         label: "Pro" },
    superadmin: { cls: "bg-slate-900 text-white border-slate-900",         label: "Superadmin" },
    editor:     { cls: "bg-violet-50 text-violet-800 border-violet-200",   label: "Editor" },
    reviewer:   { cls: "bg-amber-50 text-amber-800 border-amber-200",      label: "Reviewer" },
    viewer:     { cls: "bg-slate-50 text-slate-700 border-slate-200",      label: "Viewer" },
  };
  const c = map[role] || { cls: "bg-slate-50 text-slate-700 border-slate-200", label: role };
  return <span className={`text-[10px] px-2 py-0.5 rounded-full border ${c.cls}`}>{c.label}</span>;
}

function InviteForm({ mode, companyId, availableCompanies, onClose, onCreated }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState(mode === "admin" ? "pro" : "editor");
  const [pickedCids, setPickedCids] = useState([]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email.trim()) return toast.error("Enter an email.");
    setBusy(true);
    try {
      let url = "", body = { email, name };
      if (mode === "company") {
        url = `/companies/${companyId}/invites`;
        body.role = role;
      } else if (mode === "pro") {
        url = `/pro/invites`;
        body.company_ids = pickedCids;
      } else {
        url = `/admin/invites`;
        body.role = role;
      }
      await api.post(url, body);
      toast.success(`Invite sent to ${email}.`);
      onCreated();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't send invite");
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border bg-white p-4 space-y-3" data-testid={`team-invite-form-${mode}`}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-900">Send invitation</div>
        <button onClick={onClose} className="p-1 rounded hover:bg-slate-100"><X size={14} /></button>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <label className="text-xs text-slate-600">Email</label>
          <input
            type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            data-testid="team-invite-email" autoFocus
            className="w-full mt-1 border rounded px-2 py-1.5"
          />
        </div>
        <div>
          <label className="text-xs text-slate-600">Name (optional)</label>
          <input
            value={name} onChange={(e) => setName(e.target.value)}
            data-testid="team-invite-name"
            className="w-full mt-1 border rounded px-2 py-1.5"
          />
        </div>
      </div>

      {mode === "company" && (
        <RolePicker
          options={COMPANY_ROLE_OPTIONS}
          value={role}
          onChange={setRole}
        />
      )}
      {mode === "admin" && (
        <RolePicker
          options={ADMIN_ROLE_OPTIONS}
          value={role}
          onChange={setRole}
        />
      )}
      {mode === "pro" && (
        <div>
          <div className="text-xs text-slate-600 mb-1">Client access</div>
          <div className="rounded-md border max-h-40 overflow-y-auto" data-testid="team-invite-clients">
            {availableCompanies.length === 0 && (
              <div className="p-3 text-xs text-slate-500 text-center">
                You have no client companies yet. This invitee will start with no client access — you can add them later.
              </div>
            )}
            {availableCompanies.map((c) => (
              <label key={c.id} className="flex items-center gap-2 p-2 text-sm hover:bg-slate-50 cursor-pointer border-b last:border-b-0">
                <input
                  type="checkbox"
                  checked={pickedCids.includes(c.id)}
                  onChange={(e) => {
                    setPickedCids(prev => e.target.checked ? [...prev, c.id] : prev.filter(x => x !== c.id));
                  }}
                  data-testid={`team-invite-client-${c.id}`}
                />
                <span className="flex-1">{c.name}</span>
                <span className="text-xs text-slate-400">{c.business_type || ""}</span>
              </label>
            ))}
          </div>
          {availableCompanies.length > 0 && (
            <div className="text-[11px] text-slate-500 mt-1">
              Selected {pickedCids.length} of {availableCompanies.length} clients.
              <button
                onClick={() => setPickedCids(availableCompanies.map(c => c.id))}
                className="ml-2 text-cyan-700 hover:underline"
                data-testid="team-invite-select-all"
              >Select all</button>
              {pickedCids.length > 0 && (
                <button
                  onClick={() => setPickedCids([])}
                  className="ml-2 text-slate-500 hover:underline"
                >Clear</button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onClose} className="px-3 py-1.5 rounded-md border text-sm">Cancel</button>
        <button
          onClick={submit} disabled={busy || !email.trim()}
          data-testid={`team-invite-submit-${mode}`}
          className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-cyan-600 text-white text-sm disabled:opacity-50 hover:bg-cyan-700"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />}
          Send invite
        </button>
      </div>
    </div>
  );
}

function RolePicker({ options, value, onChange }) {
  return (
    <div>
      <div className="text-xs text-slate-600 mb-1">Role</div>
      <div className="grid grid-cols-3 gap-2" data-testid="team-invite-role">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            data-testid={`team-invite-role-${o.value}`}
            className={`text-left p-2 rounded-md border text-xs transition ${
              value === o.value ? "border-cyan-500 bg-cyan-50" : "border-slate-200 hover:bg-slate-50"
            }`}
          >
            <div className="font-semibold text-slate-900">{o.label}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">{o.hint}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function timeAgo(iso, { future = false } = {}) {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86400000);
  const hrs = Math.floor(abs / 3600000);
  const mins = Math.floor(abs / 60000);
  const sign = future ? (diff > 0 ? "in " : "") : "";
  const suffix = future ? (diff > 0 ? "" : " ago") : " ago";
  if (days >= 2) return `${sign}${days}d${suffix}`;
  if (hrs >= 2)  return `${sign}${hrs}h${suffix}`;
  if (mins >= 2) return `${sign}${mins}m${suffix}`;
  return "just now";
}
