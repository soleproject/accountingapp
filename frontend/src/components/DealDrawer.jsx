import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { X, Loader2, Trash2, Sparkles, CheckCircle2, Send,
  MessageSquare, Phone, Mail, CalendarCheck, ArrowRight, ExternalLink,
  CalendarPlus,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import { useCrmSettings } from "@/lib/useCrmSettings";
import { EventComposeModal } from "@/pages/CrmCalendar";

/**
 * DealDrawer — slide-over deal detail with editable fields, activity
 * feed, and Convert-to-Project handoff (Phase C, Feb 2026).
 */
const ACTIVITY_ICON = {
  note: MessageSquare, call: Phone, email: Mail,
  meeting: CalendarCheck, stage_change: ArrowRight, system: Sparkles,
};

export default function DealDrawer({ dealId, onClose, onChanged }) {
  const { currentId } = useCompany();
  const fmt = useMoneyFmt();
  const crm = useCrmSettings();
  const nav = useNavigate();
  const [deal, setDeal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState({});
  const [activityKind, setActivityKind] = useState("note");
  const [activityBody, setActivityBody] = useState("");
  const [schedulerOpen, setSchedulerOpen] = useState(false);
  const [contact, setContact] = useState(null);

  // Load the deal's contact so we can auto-invite them on meeting create
  useEffect(() => {
    if (!currentId || !deal?.contact_id) { setContact(null); return; }
    api.get(`/companies/${currentId}/contacts/${deal.contact_id}/crm-summary`)
       .then(r => setContact(r.data?.contact || null))
       .catch(() => setContact(null));
  }, [currentId, deal?.contact_id]);

  const load = async () => {
    if (!currentId || !dealId) return;
    setLoading(true);
    try {
      // No single-deal GET — fetch board and pick out this deal
      // (cheap, avoids adding a new endpoint just for the drawer).
      const r = await api.get(`/companies/${currentId}/deals`);
      const d = (r.data?.deals || []).find(x => x.id === dealId);
      setDeal(d || null);
      setEdit(d ? {
        title: d.title || "", value: d.value ?? 0,
        probability: d.probability ?? 0,
        expected_close_date: d.expected_close_date || "",
        notes: d.notes || "", source: d.source || "",
      } : {});
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dealId, currentId]);

  const save = async () => {
    if (!deal) return;
    setSaving(true);
    try {
      await api.patch(`/companies/${currentId}/deals/${deal.id}`, {
        title: edit.title,
        value: Number(edit.value || 0),
        probability: Number(edit.probability || 0),
        expected_close_date: edit.expected_close_date || null,
        notes: edit.notes || "",
        source: edit.source || null,
      });
      toast.success("Saved");
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally { setSaving(false); }
  };

  const addActivity = async () => {
    if (!activityBody.trim()) return;
    try {
      await api.post(
        `/companies/${currentId}/deals/${deal.id}/activities`,
        { kind: activityKind, body: activityBody.trim() });
      setActivityBody("");
      await load();
      toast.success("Activity added");
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const convertToProject = async () => {
    if (!deal) return;
    if (!deal.contact_id) {
      toast.error("Add a contact to this deal before converting.");
      return;
    }
    if (deal.project_id) {
      // Already converted — jump straight to the project.
      onClose();
      nav(`/accounting/projects/${deal.project_id}`);
      return;
    }
    if (!confirm(`Convert "${deal.title}" to a Project? The deal will move to Won.`)) return;
    setBusy(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/deals/${deal.id}/convert-to-project`);
      toast.success("Converted to project");
      const projId = r.data?.project?.id;
      onChanged?.();
      onClose();
      if (projId) nav(`/accounting/projects/${projId}`);
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally { setBusy(false); }
  };

  const del = async () => {
    if (!deal) return;
    if (!confirm(`Delete deal "${deal.title}"? This can't be undone.`)) return;
    try {
      await api.delete(`/companies/${currentId}/deals/${deal.id}`);
      toast.success("Deleted");
      onChanged?.();
      onClose();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  return (
    <div className="fixed inset-0 z-[95] flex justify-end"
          role="dialog" aria-modal="true"
          data-testid="deal-drawer">
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[1px]"
            onClick={onClose} />
      <div className="relative bg-white shadow-2xl h-full w-full max-w-lg flex flex-col animate-in slide-in-from-right duration-200">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-slate-500">
            Deal
            {deal?.project_id && (
              <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5 normal-case">
                <Sparkles size={9} /> Converted
              </span>
            )}
          </div>
          <button onClick={onClose}
                  data-testid="deal-drawer-close"
                  className="p-1 rounded hover:bg-slate-100 text-slate-400">
            <X size={16} />
          </button>
        </div>

        {loading || !deal ? (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-500">
            {loading ? <><Loader2 size={14} className="animate-spin mr-2" /> Loading…</> : "Deal not found."}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {/* Title + stage pill */}
            <div>
              <input value={edit.title}
                      onChange={(e) => setEdit(e2 => ({...e2, title: e.target.value}))}
                      data-testid="deal-drawer-title"
                      className="w-full font-heading text-xl font-bold text-slate-900 border-0 focus:ring-0 focus:outline-none px-0" />
              <div className="text-xs text-slate-500 flex items-center gap-2 mt-1">
                <span className="capitalize">{deal.stage}</span>
                {deal.contact_name && <span>· {deal.contact_name}</span>}
                {deal.owner_name && <span>· {deal.owner_name}</span>}
              </div>
            </div>

            {/* Editable fields */}
            <div className="grid grid-cols-2 gap-2">
              <Field label="Value ($)">
                <input type="number" step="0.01" min="0"
                        value={edit.value}
                        onChange={(e) => setEdit(e2 => ({...e2, value: e.target.value}))}
                        data-testid="deal-drawer-value"
                        className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
              </Field>
              <Field label="Probability (%)">
                <input type="number" step="1" min="0" max="100"
                        value={edit.probability}
                        onChange={(e) => setEdit(e2 => ({...e2, probability: e.target.value}))}
                        data-testid="deal-drawer-probability"
                        className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
              </Field>
              <Field label="Expected close">
                <input type="date" value={edit.expected_close_date}
                        onChange={(e) => setEdit(e2 => ({...e2, expected_close_date: e.target.value}))}
                        className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
              </Field>
              <Field label="Source">
                <input value={edit.source}
                        onChange={(e) => setEdit(e2 => ({...e2, source: e.target.value}))}
                        className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
              </Field>
            </div>
            <Field label="Notes">
              <textarea value={edit.notes}
                          onChange={(e) => setEdit(e2 => ({...e2, notes: e.target.value}))}
                          rows={3}
                          className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
            </Field>

            <div className="flex gap-2">
              <button onClick={save}
                      disabled={saving}
                      data-testid="deal-drawer-save"
                      className="text-sm px-3 py-1.5 rounded-md bg-violet-600 text-white font-medium hover:bg-violet-700 disabled:opacity-50 inline-flex items-center gap-1.5">
                {saving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                Save changes
              </button>
              <button onClick={convertToProject}
                      disabled={busy}
                      data-testid="deal-drawer-convert"
                      className={`text-sm px-3 py-1.5 rounded-md font-medium inline-flex items-center gap-1.5 disabled:opacity-50 ${
                        deal.project_id
                          ? "bg-emerald-100 text-emerald-800 border border-emerald-200 hover:bg-emerald-200"
                          : "bg-emerald-600 text-white hover:bg-emerald-700"
                      }`}>
                {deal.project_id
                  ? <><ExternalLink size={13} /> View project</>
                  : <><Sparkles size={13} /> Convert to project</>}
              </button>
              <button onClick={() => setSchedulerOpen(true)}
                      data-testid="deal-drawer-schedule-meeting"
                      className="text-sm px-3 py-1.5 rounded-md font-medium inline-flex items-center gap-1.5 border border-slate-200 bg-white text-slate-700 hover:bg-slate-50">
                <CalendarPlus size={13} /> Schedule meeting
              </button>
              <button onClick={del}
                      data-testid="deal-drawer-delete"
                      className="ml-auto p-1.5 rounded border border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100"
                      title="Delete">
                <Trash2 size={13} />
              </button>
            </div>

            {/* Activities feed */}
            <div className="space-y-2 pt-4 border-t">
              <div className="text-sm font-semibold text-slate-900">Activity</div>
              <div className="flex items-center gap-2">
                <select value={activityKind}
                          onChange={(e) => setActivityKind(e.target.value)}
                          data-testid="deal-drawer-activity-kind"
                          className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white">
                  {(crm.activity_kinds || ["note","call","email","meeting"]).map(k => (
                    <option key={k} value={k}>{k.replace("_"," ").replace(/\b\w/g, c => c.toUpperCase())}</option>
                  ))}
                </select>
                <input value={activityBody}
                        onChange={(e) => setActivityBody(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && addActivity()}
                        placeholder="Log a note, call, email, or meeting…"
                        data-testid="deal-drawer-activity-body"
                        className="flex-1 border border-slate-300 rounded px-2 py-1.5 text-sm" />
                <button onClick={addActivity}
                        disabled={!activityBody.trim()}
                        data-testid="deal-drawer-activity-submit"
                        className="text-sm px-3 py-1.5 rounded bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1">
                  <Send size={11} /> Log
                </button>
              </div>
              <ul className="divide-y divide-slate-100"
                  data-testid="deal-drawer-activity-list">
                {[...(deal.activities || [])].reverse().map(a => {
                  const Icon = ACTIVITY_ICON[a.kind] || MessageSquare;
                  return (
                    <li key={a.id}
                        data-testid={`deal-activity-${a.id}`}
                        className="py-2 flex items-start gap-2">
                      <div className="w-6 h-6 rounded bg-slate-100 text-slate-600 flex items-center justify-center shrink-0">
                        <Icon size={11} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-slate-800">{a.body}</div>
                        <div className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-1">
                          <span className="uppercase tracking-wider">{a.kind}</span>
                          <span>· {a.by_name}</span>
                          <span>· {formatWhen(a.at)}</span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
      </div>
      {schedulerOpen && deal && (
        <EventComposeModal
          onClose={() => setSchedulerOpen(false)}
          onSaved={async () => {
            setSchedulerOpen(false);
            // Cross-post meeting activity to the deal so it appears in the feed
            try {
              await api.post(
                `/companies/${currentId}/deals/${deal.id}/activities`,
                { kind: "meeting", body: `Scheduled meeting${contact?.email ? " with " + contact.email : ""} via Google Calendar` }
              );
              onChanged?.();
            } catch (e) { /* non-fatal */ }
            toast.success("Meeting scheduled");
          }}
          defaultSummary={deal.title ? `Meeting: ${deal.title}` : "Meeting"}
          defaultDescription={deal.notes || ""}
          defaultAttendees={contact?.email ? [{ email: contact.email, display_name: contact.name }] : []}
        />
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-0.5">{label}</label>
      {children}
    </div>
  );
}

function formatWhen(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  } catch { return iso; }
}
