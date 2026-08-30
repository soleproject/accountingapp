import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  GitBranch, Loader2, Plus, Send, MessageSquare, Phone, Mail,
  CalendarCheck, ArrowRight, Sparkles, ChevronRight, TrendingUp,
  Trophy, XCircle,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import { useCrmSettings } from "@/lib/useCrmSettings";
import DealFormModal from "@/components/DealFormModal";
import DealDrawer from "@/components/DealDrawer";

/**
 * ContactCrmPanel — the CRM face of a Contact record (Phase C polish,
 * Feb 2026). Unifies the accounting Contact and the CRM Deal history:
 *
 *   • Editable Stage + Lead Source pills
 *   • Aggregate deal stats (open · won · lost)
 *   • List of every deal ever linked to this contact
 *   • Unified activity feed (contact-level + all deal-level)
 *   • "Log activity" quick composer
 *   • "New deal" inline (deal pre-linked to this contact)
 */
const STAGES = [
  { key: "lead",             label: "Lead",             color: "bg-slate-100 text-slate-700 border-slate-200" },
  { key: "prospect",         label: "Prospect",         color: "bg-cyan-100 text-cyan-800 border-cyan-200" },
  { key: "active_customer",  label: "Active customer",  color: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  { key: "past_customer",    label: "Past customer",    color: "bg-amber-100 text-amber-800 border-amber-200" },
  { key: "inactive",         label: "Inactive",         color: "bg-slate-100 text-slate-500 border-slate-200" },
];
const DEAL_STAGE_TONE = {
  lead:        "bg-slate-100 text-slate-700",
  qualified:   "bg-cyan-100 text-cyan-800",
  proposal:    "bg-indigo-100 text-indigo-800",
  negotiation: "bg-amber-100 text-amber-800",
  won:         "bg-emerald-100 text-emerald-800",
  lost:        "bg-rose-100 text-rose-800",
};
const ACTIVITY_ICON = {
  note: MessageSquare, call: Phone, email: Mail,
  meeting: CalendarCheck, stage_change: ArrowRight, system: Sparkles,
};

export default function ContactCrmPanel({ contactId, contact: initialContact }) {
  const { currentId } = useCompany();
  const fmt = useMoneyFmt();
  const nav = useNavigate();
  const crm = useCrmSettings();

  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showNewDeal, setShowNewDeal] = useState(false);
  const [selectedDealId, setSelectedDealId] = useState(null);
  const [activityKind, setActivityKind] = useState("note");
  const [activityBody, setActivityBody] = useState("");
  const [savingStage, setSavingStage] = useState(false);
  const [leadSource, setLeadSource] = useState("");

  const load = async () => {
    if (!currentId || !contactId) return;
    setLoading(true);
    try {
      const r = await api.get(
        `/companies/${currentId}/contacts/${contactId}/crm-summary`);
      setSummary(r.data);
      setLeadSource(r.data?.contact?.lead_source || "");
    } catch (e) {
      toast.error(`CRM summary failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [contactId, currentId]);

  const patchContact = async (payload) => {
    setSavingStage(true);
    try {
      await api.patch(
        `/companies/${currentId}/contacts/${contactId}`, payload);
      await load();
    } catch (e) {
      toast.error(`Update failed: ${e.response?.data?.detail || e.message}`);
    } finally { setSavingStage(false); }
  };

  const logActivity = async () => {
    if (!activityBody.trim()) return;
    try {
      await api.post(
        `/companies/${currentId}/contacts/${contactId}/activities`,
        { kind: activityKind, body: activityBody.trim() });
      setActivityBody("");
      await load();
      toast.success("Activity logged");
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500"
            data-testid="contact-crm-panel-loading">
        <Loader2 size={14} className="inline animate-spin mr-2" /> Loading CRM…
      </div>
    );
  }
  if (!summary) return null;

  const { contact, deals, stats, activity_feed } = summary;
  const currentStage = contact.stage || "lead";

  return (
    <div className="space-y-4" data-testid="contact-crm-panel">
      {/* Header row */}
      <div className="rounded-xl border bg-white p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
            <GitBranch size={14} className="text-violet-600" /> CRM
          </div>
          <button onClick={() => setShowNewDeal(true)}
                  data-testid="contact-crm-new-deal"
                  className="text-xs px-3 py-1 rounded-md bg-violet-600 text-white font-medium hover:bg-violet-700 inline-flex items-center gap-1">
            <Plus size={11} /> New deal
          </button>
        </div>
        {/* Stage + Lead Source */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">Lifecycle stage</label>
            <div className="flex flex-wrap gap-1" data-testid="contact-crm-stages">
              {STAGES.map(s => (
                <button key={s.key}
                        onClick={() => currentStage !== s.key && patchContact({ stage: s.key })}
                        disabled={savingStage}
                        data-testid={`contact-crm-stage-${s.key}`}
                        className={`text-[11px] px-2 py-0.5 rounded border transition ${
                          currentStage === s.key
                            ? s.color + " ring-1 ring-offset-1 ring-slate-400"
                            : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
                        }`}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">Lead source</label>
            <input
              value={leadSource}
              onChange={(e) => setLeadSource(e.target.value)}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (contact.lead_source || "")) {
                  patchContact({ lead_source: v });
                }
              }}
              list={`lead-sources-${contactId}`}
              data-testid="contact-crm-lead-source"
              placeholder="Referral · Cold outreach · Web · Trade show…"
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
            <datalist id={`lead-sources-${contactId}`}>
              {(crm.lead_sources || []).map(s => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
        </div>
      </div>

      {/* Deal stats + list */}
      <div className="rounded-xl border bg-white">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-900">Deal history</div>
          <div className="text-[11px] text-slate-500">{deals.length} deals</div>
        </div>
        <div className="grid grid-cols-3 gap-2 p-3 border-b bg-slate-50/40" data-testid="contact-crm-stats">
          <Kpi label="Open" value={fmt(stats.open_value)} sub={`${stats.open_count} deals`}
                icon={<TrendingUp size={11} />} tone="cyan" testId="contact-crm-stat-open" />
          <Kpi label="Won" value={fmt(stats.won_value)} sub={`${stats.won_count} deals`}
                icon={<Trophy size={11} />} tone="emerald" testId="contact-crm-stat-won" />
          <Kpi label="Lost" value={fmt(stats.lost_value)} sub={`${stats.lost_count} deals`}
                icon={<XCircle size={11} />} tone="rose" testId="contact-crm-stat-lost" />
        </div>
        {deals.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500 italic">
            No deals with this contact yet. <button className="text-violet-600 hover:underline"
                  onClick={() => setShowNewDeal(true)}>Create the first one</button>.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="contact-crm-deals">
            {deals.map(d => (
              <li key={d.id}
                  onClick={() => setSelectedDealId(d.id)}
                  data-testid={`contact-crm-deal-${d.id}`}
                  className="px-4 py-2.5 flex items-center gap-3 hover:bg-slate-50 cursor-pointer">
                <span className={`text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 shrink-0 ${
                  DEAL_STAGE_TONE[d.stage] || "bg-slate-100 text-slate-700"}`}>
                  {d.stage}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-800 truncate">{d.title}</div>
                  <div className="text-[10px] text-slate-500 font-mono-num">{d.created_at?.slice(0,10)}</div>
                </div>
                {d.project_id && (
                  <span className="text-[9px] uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5">
                    Project
                  </span>
                )}
                <span className="font-mono-num font-semibold text-slate-900 text-sm">{fmt(d.value || 0)}</span>
                <ChevronRight size={12} className="text-slate-400" />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Unified activity feed */}
      <div className="rounded-xl border bg-white">
        <div className="px-4 py-3 border-b">
          <div className="text-sm font-semibold text-slate-900">Activity feed</div>
          <div className="text-[10px] text-slate-500">Every note, call, email, meeting on this contact — from any deal.</div>
        </div>
        <div className="p-3 border-b flex items-center gap-2">
          <select value={activityKind}
                    onChange={(e) => setActivityKind(e.target.value)}
                    data-testid="contact-crm-activity-kind"
                    className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white">
            {(crm.activity_kinds || ["note","call","email","meeting"]).map(k => (
              <option key={k} value={k}>{k.replace("_"," ").replace(/\b\w/g, c => c.toUpperCase())}</option>
            ))}
          </select>
          <input value={activityBody}
                  onChange={(e) => setActivityBody(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && logActivity()}
                  placeholder="Log a note about this contact…"
                  data-testid="contact-crm-activity-body"
                  className="flex-1 border border-slate-300 rounded px-2 py-1.5 text-sm" />
          <button onClick={logActivity}
                  disabled={!activityBody.trim()}
                  data-testid="contact-crm-activity-submit"
                  className="text-sm px-3 py-1.5 rounded bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1">
            <Send size={11} /> Log
          </button>
        </div>
        {activity_feed.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500 italic">
            No activity yet.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 max-h-[420px] overflow-y-auto"
              data-testid="contact-crm-feed">
            {activity_feed.map(a => {
              const Icon = ACTIVITY_ICON[a.kind] || MessageSquare;
              const src  = a.meta?.source;
              const dir  = a.meta?.direction;
              const badge = src === "gmail"
                ? (dir === "sent" ? { label: "Sent", tone: "bg-cyan-50 text-cyan-700 border-cyan-200" }
                                  : { label: "Received", tone: "bg-slate-50 text-slate-600 border-slate-200" })
                : src === "google_calendar"
                ? { label: "Google Cal", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" }
                : null;
              return (
                <li key={a.id}
                    data-testid={`contact-crm-activity-${a.id}`}
                    className="px-4 py-2.5 flex items-start gap-3">
                  <div className="w-7 h-7 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center shrink-0">
                    <Icon size={12} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-slate-800 flex items-start gap-2 flex-wrap">
                      <span className="flex-1 min-w-0">{a.body}</span>
                      {badge && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badge.tone} shrink-0`}>
                          {badge.label}
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-1 flex-wrap">
                      <span className="uppercase tracking-wider">{a.kind}</span>
                      <span>· {a.by_name}</span>
                      <span>· {formatWhen(a.at)}</span>
                      {a.source === "deal" && a.deal_title && (
                        <span className="text-violet-600 font-medium">· via deal: {a.deal_title}</span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {showNewDeal && (
        <DealFormModal
          onClose={() => setShowNewDeal(false)}
          onSaved={() => { setShowNewDeal(false); load(); }}
          defaultContactId={contactId}
        />
      )}
      {selectedDealId && (
        <DealDrawer
          dealId={selectedDealId}
          onClose={() => setSelectedDealId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, sub, icon, tone = "slate", testId }) {
  const tones = {
    slate:   "text-slate-800 bg-slate-50/70 border-slate-200",
    cyan:    "text-cyan-800 bg-cyan-50/70 border-cyan-200",
    emerald: "text-emerald-800 bg-emerald-50/70 border-emerald-200",
    rose:    "text-rose-800 bg-rose-50/70 border-rose-200",
  };
  return (
    <div data-testid={testId} className={`rounded-lg border p-2 ${tones[tone] || tones.slate}`}>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 flex items-center gap-1">
        {icon} {label}
      </div>
      <div className="text-base font-mono-num">{value}</div>
      <div className="text-[10px] text-slate-500 font-mono-num">{sub}</div>
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
