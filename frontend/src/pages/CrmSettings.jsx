import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Sparkles, Loader2, Save, Truck, Palette, Calculator, Check,
  Tag, MessageSquare, Zap,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { invalidateCrmSettings } from "@/lib/useCrmSettings";

/**
 * CrmSettings — /crm/settings (Phase C polish, Feb 2026).
 * Pick an industry preset (Field Service · Agency · CPA Firm) or
 * hand-edit the stage labels, activity kinds, and lead sources.
 */
const PRESET_ICONS = {
  field_service: Truck,
  agency: Palette,
  cpa_firm: Calculator,
};
const STAGE_KEYS = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];

export default function CrmSettings() {
  const { currentId } = useCompany();
  const [presets, setPresets] = useState([]);
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(null);
  const [editLabels, setEditLabels] = useState({});
  const [editActivityKinds, setEditActivityKinds] = useState("");
  const [editLeadSources, setEditLeadSources] = useState("");
  const [editFollowUpDefault, setEditFollowUpDefault] = useState(7);
  const [editFollowUpPer, setEditFollowUpPer] = useState({}); // { call: 3, ... }

  useEffect(() => {
    if (!currentId) return;
    (async () => {
      try {
        const [p, s] = await Promise.all([
          api.get(`/crm/presets`),
          api.get(`/companies/${currentId}/crm-settings`),
        ]);
        setPresets(p.data?.presets || []);
        setSettings(s.data);
        setEditLabels(s.data?.stage_labels || {});
        setEditActivityKinds((s.data?.activity_kinds || []).join(", "));
        setEditLeadSources((s.data?.lead_sources || []).join(", "));
        setEditFollowUpDefault(s.data?.follow_up?.default_days ?? 7);
        setEditFollowUpPer(s.data?.follow_up?.per_activity || {});
      } catch (e) {
        toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
      }
    })();
  }, [currentId]);

  const applyPreset = async (presetId) => {
    if (!confirm(`Apply the "${presetId.replace("_"," ")}" preset? This overwrites your current stage labels, activity kinds, and lead sources.`)) return;
    setApplying(presetId);
    try {
      const r = await api.post(
        `/companies/${currentId}/crm-settings/apply-preset`,
        { preset: presetId });
      const s = r.data?.settings;
      setSettings(s);
      setEditLabels(s?.stage_labels || {});
      setEditActivityKinds((s?.activity_kinds || []).join(", "));
      setEditLeadSources((s?.lead_sources || []).join(", "));
      setEditFollowUpDefault(s?.follow_up?.default_days ?? 7);
      setEditFollowUpPer(s?.follow_up?.per_activity || {});
      invalidateCrmSettings(currentId);
      toast.success(`Applied "${presetId.replace("_"," ")}" preset`);
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally { setApplying(null); }
  };

  const saveCustom = async () => {
    setSaving(true);
    try {
      const activity_kinds = editActivityKinds.split(",").map(x => x.trim()).filter(Boolean);
      const lead_sources   = editLeadSources.split(",").map(x => x.trim()).filter(Boolean);
      const r = await api.patch(
        `/companies/${currentId}/crm-settings`,
        { stage_labels: editLabels, activity_kinds, lead_sources,
          follow_up: {
            default_days: Number(editFollowUpDefault) || 7,
            per_activity: editFollowUpPer,
          },
          preset: "custom" });
      setSettings(r.data);
      invalidateCrmSettings(currentId);
      toast.success("CRM settings saved");
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally { setSaving(false); }
  };

  if (!settings) {
    return (
      <div className="max-w-4xl py-10 text-center text-sm text-slate-500">
        <Loader2 size={14} className="inline animate-spin mr-2" /> Loading CRM settings…
      </div>
    );
  }

  const activePreset = settings.preset;

  return (
    <div className="max-w-4xl space-y-6" data-testid="crm-settings-page">
      <div>
        <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
          <Sparkles size={22} className="text-violet-600" />
          CRM Settings
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Pick an industry preset to match your business, or hand-edit the labels below. The pipeline still uses six stages under the hood — presets just rename them and seed relevant activity kinds & lead sources.
        </p>
      </div>

      {/* Preset cards */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">Industry presets</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="crm-preset-cards">
          {presets.map(p => {
            const Icon = PRESET_ICONS[p.id] || Sparkles;
            const isActive = activePreset === p.id;
            return (
              <div key={p.id}
                    data-testid={`crm-preset-card-${p.id}`}
                    className={`rounded-xl border p-4 space-y-3 bg-white flex flex-col ${
                      isActive
                        ? "border-violet-400 shadow-md ring-1 ring-violet-200"
                        : "border-slate-200"
                    }`}>
                <div className="flex items-center justify-between">
                  <div className="w-10 h-10 rounded-lg bg-violet-50 text-violet-600 flex items-center justify-center">
                    <Icon size={16} />
                  </div>
                  {isActive && (
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5"
                          data-testid={`crm-preset-active-${p.id}`}>
                      <Check size={10} /> Active
                    </span>
                  )}
                </div>
                <div>
                  <div className="font-heading font-bold text-slate-900">{p.name}</div>
                  <div className="text-xs text-slate-500 leading-snug">{p.tagline}</div>
                </div>
                <ul className="text-[11px] text-slate-600 space-y-0.5">
                  {STAGE_KEYS.slice(0, 4).map(k => (
                    <li key={k} className="truncate">
                      <span className="text-slate-400">{k}:</span> <b>{p.stage_labels[k]}</b>
                    </li>
                  ))}
                </ul>
                <button onClick={() => applyPreset(p.id)}
                        disabled={applying === p.id}
                        data-testid={`crm-preset-apply-${p.id}`}
                        className={`mt-auto text-sm px-3 py-1.5 rounded-md font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-50 ${
                          isActive
                            ? "bg-slate-100 text-slate-500 border border-slate-200"
                            : "bg-violet-600 text-white hover:bg-violet-700"
                        }`}>
                  {applying === p.id
                    ? <Loader2 size={12} className="animate-spin" />
                    : isActive
                      ? <>Re-apply</>
                      : <>Apply preset</>}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Custom editor */}
      <div className="rounded-xl border bg-white p-5 space-y-4"
            data-testid="crm-settings-custom">
        <div>
          <div className="text-sm font-semibold text-slate-900">Custom labels</div>
          <div className="text-xs text-slate-500">Rename any stage. The pipeline order stays the same.</div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {STAGE_KEYS.map(k => (
            <div key={k}>
              <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-0.5">
                {k}
              </label>
              <input value={editLabels[k] || ""}
                      onChange={(e) => setEditLabels(l => ({...l, [k]: e.target.value}))}
                      data-testid={`crm-label-${k}`}
                      className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-0.5 flex items-center gap-1">
              <Zap size={10} /> Activity kinds (comma-separated)
            </label>
            <input value={editActivityKinds}
                    onChange={(e) => setEditActivityKinds(e.target.value)}
                    data-testid="crm-activity-kinds"
                    placeholder="note, call, email, meeting"
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-0.5 flex items-center gap-1">
              <Tag size={10} /> Lead sources (comma-separated)
            </label>
            <input value={editLeadSources}
                    onChange={(e) => setEditLeadSources(e.target.value)}
                    data-testid="crm-lead-sources"
                    placeholder="Referral, Web, Cold outreach"
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
          </div>
        </div>

        {/* Follow-up thresholds */}
        <div className="border-t pt-4 mt-4">
          <div className="text-xs uppercase tracking-widest text-violet-600 font-semibold mb-2 flex items-center gap-1.5">
            <Tag size={11}/> Deal follow-up thresholds
          </div>
          <p className="text-xs text-slate-500 mb-3">
            A deal shows on <b>My Day → Deals needing follow-up</b> when its most recent
            activity is older than this many days. Set a global default and, if you want,
            different thresholds per activity kind (e.g. flag calls faster than notes).
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-0.5">
                Default (days)
              </label>
              <input type="number" min="1" max="90"
                     value={editFollowUpDefault}
                     onChange={(e) => setEditFollowUpDefault(e.target.value)}
                     data-testid="crm-follow-up-default"
                     className="w-32 border border-slate-300 rounded px-2 py-1.5 text-sm"/>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-0.5">
                Per-activity overrides
              </label>
              <div className="space-y-1.5">
                {(editActivityKinds.split(",").map(x => x.trim()).filter(Boolean)).map(k => (
                  <div key={k} className="flex items-center gap-2">
                    <div className="w-28 text-xs text-slate-700 truncate">{k}</div>
                    <input type="number" min="1" max="90"
                           value={editFollowUpPer[k] ?? ""}
                           onChange={(e) => {
                             const v = e.target.value;
                             setEditFollowUpPer(p => {
                               const n = { ...p };
                               if (v === "" || v == null) delete n[k];
                               else n[k] = Number(v);
                               return n;
                             });
                           }}
                           data-testid={`crm-follow-up-per-${k}`}
                           placeholder={String(editFollowUpDefault)}
                           className="w-24 border border-slate-300 rounded px-2 py-1 text-sm"/>
                    <span className="text-[10px] text-slate-400">
                      {editFollowUpPer[k] ? "days" : `default (${editFollowUpDefault})`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <button onClick={saveCustom}
                  disabled={saving}
                  data-testid="crm-settings-save"
                  className="text-sm px-4 py-1.5 rounded-md bg-slate-900 text-white font-medium hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save custom
          </button>
        </div>
      </div>
    </div>
  );
}
