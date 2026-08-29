import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Sparkles, Loader2, Save, Truck, Palette, Calculator, Check,
  Tag, MessageSquare, Zap, Bot, Trash2, ExternalLink, Copy,
  Video, CalendarClock,
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
  const [editShowBrief, setEditShowBrief] = useState(false);

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
        setEditShowBrief(!!s.data?.show_morning_brief);
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
      setEditShowBrief(!!s?.show_morning_brief);
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
          show_morning_brief: editShowBrief,
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

        {/* My Day options */}
        <div className="border-t pt-4 mt-4">
          <div className="text-xs uppercase tracking-widest text-violet-600 font-semibold mb-2 flex items-center gap-1.5">
            <Tag size={11}/> My Day options
          </div>
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox"
                   checked={editShowBrief}
                   onChange={(e) => setEditShowBrief(e.target.checked)}
                   data-testid="crm-toggle-morning-brief"
                   className="mt-0.5 h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500"/>
            <div>
              <div className="text-sm font-medium text-slate-800">Show Morning Brief</div>
              <div className="text-xs text-slate-500">
                Renders an AI-generated 2–3 sentence summary at the top of the My Day
                dashboard. Off by default — turn on if you want a daily plain-English
                priority read.
              </div>
            </div>
          </label>
        </div>

        {/* Note-taker integrations */}
        <NoteTakersPanel />
        <BookingPanel />

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



/* ------------------------------------------------------------------ */
/*  Note-taker integrations                                            */
/* ------------------------------------------------------------------ */
function NoteTakersPanel() {
  const { currentId } = useCompany();
  const [data, setData]         = useState({ connections: [], providers: [] });
  const [busy, setBusy]         = useState(false);
  const [openProvider, setOpen] = useState(null);   // api_key providers
  const [apiKey, setApiKey]     = useState("");
  const [showWizard, setWizard] = useState(false);  // Read.ai post-OAuth
  const [wizardError, setWizErr] = useState(null);

  const load = async () => {
    if (!currentId) return;
    try {
      const r = await api.get(`/companies/${currentId}/note-takers`);
      setData(r.data || { connections: [], providers: [] });
    } catch { /* silent */ }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId]);

  // Detect post-OAuth landing (?readai=connected|readai_error=... / ?grain=connected)
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("readai") === "connected") {
      setWizard(true);
      url.searchParams.delete("readai");
      window.history.replaceState({}, "", url.toString());
      load();
    }
    if (url.searchParams.get("grain") === "connected") {
      toast.success("Grain connected — meeting sync is live");
      url.searchParams.delete("grain");
      window.history.replaceState({}, "", url.toString());
      load();
    }
    const readaiErr = url.searchParams.get("readai_error");
    if (readaiErr) {
      setWizErr(readaiErr);
      toast.error(`Read.ai connect failed: ${readaiErr}`);
      url.searchParams.delete("readai_error");
      window.history.replaceState({}, "", url.toString());
    }
    const grainErr = url.searchParams.get("grain_error");
    if (grainErr) {
      toast.error(`Grain connect failed: ${grainErr}`);
      url.searchParams.delete("grain_error");
      window.history.replaceState({}, "", url.toString());
    }
    // eslint-disable-next-line
  }, [currentId]);

  // While the wizard is open and readai is pending_webhook, poll every 5s.
  useEffect(() => {
    if (!showWizard) return;
    const readai = (data.connections || []).find(c => c.provider === "readai");
    if (readai && !readai.pending_webhook) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [showWizard, data.connections]);

  const connectClick = async (providerKey) => {
    const prov = (data.providers || []).find(p => p.key === providerKey);
    if (!prov) return;
    if (prov.auth_type === "oauth") {
      // Kick off OAuth for any OAuth provider (readai / grain / …).
      try {
        const r = await api.get(`/oauth/${providerKey}/start`,
                                  { params: { company_id: currentId } });
        window.location.href = r.data.auth_url;
      } catch (e) {
        toast.error(e?.response?.data?.detail || "Failed to start OAuth");
      }
      return;
    }
    setOpen(providerKey); setApiKey("");
  };

  const connect = async () => {
    if (!apiKey.trim()) { toast.error("API key required"); return; }
    setBusy(true);
    try {
      await api.post(`/companies/${currentId}/note-takers`,
                      { provider: openProvider, api_key: apiKey.trim() });
      toast.success("Connected — copy your webhook URL next");
      setApiKey(""); setOpen(null); load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to connect");
    } finally { setBusy(false); }
  };

  const disconnect = async (providerKey) => {
    if (!window.confirm("Disconnect this note-taker?")) return;
    try {
      await api.delete(`/companies/${currentId}/note-takers/${providerKey}`);
      toast.success("Disconnected"); load();
    } catch { toast.error("Disconnect failed"); }
  };

  const copy = (text) => {
    navigator.clipboard.writeText(text); toast.success("Copied");
  };

  const readaiConn = (data.connections || []).find(c => c.provider === "readai");

  return (
    <div className="border-t pt-4 mt-4" data-testid="crm-note-takers">
      <div className="text-xs uppercase tracking-widest text-violet-600 font-semibold mb-2 flex items-center gap-1.5">
        <Bot size={11}/> AI note-takers
      </div>
      <p className="text-xs text-slate-500 mb-3">
        Connect your meeting note-taker. When it finishes a call, the summary
        auto-logs on the matching contact's timeline, and action items become
        tasks — no manual data entry.
      </p>
      {data.connections?.length > 0 && (
        <div className="space-y-2 mb-3">
          {data.connections.map(c => (
            <div key={c.id}
                 data-testid={`crm-note-taker-${c.provider}`}
                 className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center gap-2">
                <Bot size={13} className={c.pending_webhook ? "text-amber-500" : "text-emerald-600"}/>
                <div className="flex-1">
                  <div className="text-sm font-medium text-slate-800 capitalize">
                    {c.provider}
                    {c.user_email && (
                      <span className="text-slate-400 font-normal text-xs ml-1">
                        · connected as {c.user_email}
                      </span>
                    )}
                    {c.auth_type === "oauth" && (
                      <span className="ml-1.5 inline-flex items-center rounded-full bg-violet-100 text-violet-700 text-[10px] px-1.5 py-0.5">OAuth</span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {c.pending_webhook
                      ? <span className="text-amber-600">⏳ Waiting for first meeting…</span>
                      : <>{c.meetings_ingested || 0} meetings ingested
                          {c.last_meeting_at ? ` · last ${c.last_meeting_at.slice(0, 10)}` : ""}</>}
                  </div>
                </div>
                {c.provider === "readai" && c.pending_webhook && (
                  <button onClick={() => setWizard(true)}
                          className="text-xs text-violet-600 hover:text-violet-700 inline-flex items-center gap-1">
                    Finish setup →
                  </button>
                )}
                <button onClick={() => disconnect(c.provider)}
                        data-testid={`crm-note-taker-disconnect-${c.provider}`}
                        className="text-xs text-rose-600 hover:text-rose-700 inline-flex items-center gap-1">
                  <Trash2 size={11}/> Disconnect
                </button>
              </div>
              <div className="mt-2 flex items-center gap-2 text-[11px]">
                <span className="text-slate-500">Webhook URL:</span>
                <code className="flex-1 truncate bg-white border border-slate-200 rounded px-2 py-1 text-slate-700">
                  {c.webhook_url}
                </code>
                <button onClick={() => copy(c.webhook_url)}
                        className="p-1 rounded hover:bg-white text-slate-500">
                  <Copy size={11}/>
                </button>
              </div>
              {c.instructions && (
                <details className="mt-2 text-[11px] text-slate-600">
                  <summary className="cursor-pointer hover:text-slate-800">Setup steps</summary>
                  <pre className="whitespace-pre-wrap mt-1 pl-4 border-l-2 border-slate-200">{c.instructions}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {data.providers?.filter(p => !data.connections?.some(c => c.provider === p.key))
          .map(p => (
          <button key={p.key}
                  onClick={() => connectClick(p.key)}
                  data-testid={`crm-note-taker-connect-${p.key}`}
                  className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 hover:border-violet-300 hover:bg-violet-50/40 text-left">
            <div className="w-8 h-8 rounded-md bg-violet-100 text-violet-600 flex items-center justify-center shrink-0">
              <Bot size={14}/>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-slate-800">
                {p.display_name}
                {p.auth_type === "oauth" && (
                  <span className="ml-1.5 inline-flex items-center rounded-full bg-violet-100 text-violet-700 text-[10px] px-1.5 py-0.5">OAuth</span>
                )}
              </div>
              <div className="text-[11px] text-slate-500">
                {p.auth_type === "oauth"
                  ? "Sign in with your account"
                  : "Free tier includes API"}
              </div>
            </div>
            <span className="text-xs text-violet-600">Connect →</span>
          </button>
        ))}
      </div>
      {openProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
             onClick={() => setOpen(null)}>
          <div onClick={e => e.stopPropagation()}
               data-testid="crm-note-taker-modal"
               className="bg-white rounded-xl w-full max-w-md mx-3 shadow-2xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <Bot size={16} className="text-violet-600"/>
              <div className="text-sm font-semibold capitalize">Connect {openProvider}</div>
            </div>
            <p className="text-xs text-slate-500 mb-3">
              Paste your <b className="capitalize">{openProvider}</b> API key.
              You can find it in the <em>{openProvider}</em> dashboard under{" "}
              <em>Settings → API</em> or <em>Developer Settings</em>.
            </p>
            <input type="password"
                   value={apiKey}
                   onChange={(e) => setApiKey(e.target.value)}
                   placeholder="Paste your API key…"
                   data-testid="crm-note-taker-api-key"
                   className="w-full px-3 py-2 border border-slate-300 rounded text-sm mb-3"/>
            <div className="flex items-center gap-2 justify-end">
              <button onClick={() => setOpen(null)}
                      className="text-sm text-slate-600 hover:text-slate-800">Cancel</button>
              <button onClick={connect}
                      disabled={busy}
                      data-testid="crm-note-taker-save"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-700 text-white text-sm disabled:opacity-50">
                {busy ? <Loader2 size={13} className="animate-spin"/> : <Bot size={13}/>}
                Connect
              </button>
            </div>
          </div>
        </div>
      )}
      {showWizard && readaiConn && (
        <ReadAiWebhookWizard
          conn={readaiConn}
          currentId={currentId}
          onClose={() => setWizard(false)}
          onCopy={copy}
          onSigningKeySaved={load}
        />
      )}
    </div>
  );
}


function ReadAiWebhookWizard({ conn, currentId, onClose, onCopy, onSigningKeySaved }) {
  const [showKey, setShowKey] = useState(false);
  const [signingKey, setSigningKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);

  const saveKey = async () => {
    if (!signingKey.trim()) return;
    setSavingKey(true);
    try {
      await api.post(`/companies/${currentId}/note-takers/readai/signing-key`,
                      { signing_key: signingKey.trim() });
      toast.success("Signing key saved — webhooks will be verified");
      setSigningKey(""); setShowKey(false);
      onSigningKeySaved && onSigningKeySaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to save signing key");
    } finally { setSavingKey(false); }
  };

  const live = !conn.pending_webhook;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
         onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           data-testid="crm-readai-wizard"
           className="bg-white rounded-xl w-full max-w-lg mx-3 shadow-2xl p-6">
        <div className="flex items-center gap-2 mb-3">
          <Bot size={18} className="text-violet-600"/>
          <div className="text-base font-semibold">Finish your Read.ai setup</div>
        </div>

        {/* Step 1 — done */}
        <div className="flex items-start gap-3 mb-4 pb-4 border-b border-slate-100">
          <div className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
            <Check size={13}/>
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium text-slate-800">Connected</div>
            <div className="text-xs text-slate-500">
              Signed in as <b>{conn.user_email || "your Read.ai account"}</b>
            </div>
          </div>
        </div>

        {/* Step 2 — webhook */}
        <div className="flex items-start gap-3 mb-3">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${live ? "bg-emerald-100 text-emerald-700" : "bg-violet-100 text-violet-700"}`}>
            {live ? <Check size={13}/> : "2"}
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium text-slate-800">
              {live ? "Meeting sync is live" : "Turn on meeting sync"}
            </div>
            {!live && (
              <div className="text-xs text-slate-500 mt-0.5">
                We can't add webhooks for you (Read.ai's platform doesn't allow it).
                Open Read.ai and paste this URL — takes 30 seconds.
              </div>
            )}
          </div>
        </div>

        {!live && (
          <>
            <div className="pl-9 mb-3">
              <a href={conn.webhook_deep_link || "https://app.read.ai/settings/integrations"}
                 target="_blank" rel="noopener noreferrer"
                 data-testid="crm-readai-open-integrations"
                 className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-700 text-white text-sm">
                <ExternalLink size={13}/> Open Read.ai Webhooks
              </a>
            </div>
            <div className="pl-9 mb-4">
              <div className="text-[11px] text-slate-500 mb-1">Webhook URL to paste:</div>
              <div className="flex items-center gap-2">
                <code data-testid="crm-readai-webhook-url"
                      className="flex-1 truncate bg-slate-50 border border-slate-200 rounded px-2 py-1.5 text-xs text-slate-700">
                  {conn.webhook_url}
                </code>
                <button onClick={() => onCopy(conn.webhook_url)}
                        data-testid="crm-readai-copy-webhook"
                        className="p-1.5 rounded hover:bg-slate-100 text-slate-500">
                  <Copy size={13}/>
                </button>
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                Trigger: <b>meeting_end</b> · Type: <b>User</b> or <b>Workspace</b>
              </div>
            </div>
            <div className="pl-9 mb-4">
              <div className="text-[11px] text-slate-500 inline-flex items-center gap-1">
                <Loader2 size={11} className="animate-spin"/>
                Waiting for your first meeting…
              </div>
            </div>
          </>
        )}

        {live && (
          <div className="pl-9 mb-4 text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded px-3 py-2">
            ✅ Your last meeting synced successfully — {conn.meetings_ingested} synced so far.
          </div>
        )}

        {/* Optional signing key */}
        <div className="border-t border-slate-100 pt-3">
          <button onClick={() => setShowKey(!showKey)}
                  data-testid="crm-readai-toggle-signing"
                  className="text-xs text-slate-500 hover:text-slate-700">
            {showKey ? "Hide" : "Paste signing key for extra security"} (optional)
          </button>
          {showKey && (
            <div className="mt-2">
              <p className="text-[11px] text-slate-500 mb-2">
                In Read.ai's webhook page, copy the <b>signing key</b> shown after you save. Paste it here so we can HMAC-verify every payload.
              </p>
              <div className="flex items-center gap-2">
                <input type="password"
                       value={signingKey}
                       onChange={(e) => setSigningKey(e.target.value)}
                       placeholder="Read.ai signing key"
                       data-testid="crm-readai-signing-key"
                       className="flex-1 px-2.5 py-1.5 border border-slate-300 rounded text-xs"/>
                <button onClick={saveKey}
                        disabled={savingKey || !signingKey.trim()}
                        data-testid="crm-readai-save-signing"
                        className="text-xs px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-slate-900 text-white disabled:opacity-50">
                  {savingKey ? <Loader2 size={11} className="animate-spin"/> : "Save"}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end mt-4">
          <button onClick={onClose}
                  data-testid="crm-readai-wizard-close"
                  className="text-sm px-3 py-1.5 text-slate-600 hover:text-slate-800">
            {live ? "Done" : "I'll finish this later"}
          </button>
        </div>
      </div>
    </div>
  );
}


// ==================================================================
// BookingPanel — meeting-link defaults + /book/{slug} public URL
// ==================================================================
const LINK_TYPES = [
  { key: "google_meet", label: "Google Meet",  hint: "Auto-generated per meeting" },
  { key: "zoom",        label: "Zoom",          hint: "Personal room URL" },
  { key: "teams",       label: "Microsoft Teams", hint: "Personal room URL" },
  { key: "whereby",     label: "Whereby",       hint: "Personal room URL" },
  { key: "custom",      label: "Custom URL",    hint: "Any static link" },
  { key: "none",        label: "None (no link)", hint: "In-person or phone" },
];

function BookingPanel() {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api.get("/users/me/booking-settings");
      setS(r.data);
    } catch { /* silent */ }
  };
  useEffect(() => { load(); }, []);

  const save = async (patch) => {
    setBusy(true);
    try {
      const r = await api.post("/users/me/booking-settings", patch);
      setS(r.data);
      toast.success("Saved");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally { setBusy(false); }
  };

  const bookingUrl = s?.slug
    ? `${window.location.origin}/book/${s.slug}`
    : "";
  const staticLinkNeeded = ["zoom", "teams", "whereby", "custom"].includes(s?.default_meeting_link_type);

  return (
    <div className="border-t pt-4 mt-4" data-testid="crm-booking-panel">
      <div className="text-xs uppercase tracking-widest text-violet-600 font-semibold mb-2 flex items-center gap-1.5">
        <CalendarClock size={11}/> Meeting links & booking page
      </div>
      <p className="text-xs text-slate-500 mb-3">
        Set your default meeting link type — the voice assistant picks it up when you say
        "send my meeting link." Your public booking URL lets clients pick a time from your
        calendar without emailing back and forth.
      </p>

      {!s ? (
        <div className="text-xs text-slate-400"><Loader2 size={11} className="inline animate-spin"/> Loading…</div>
      ) : (
        <>
          {/* public booking URL */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 mb-3">
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
              Your booking page
            </div>
            <div className="flex items-center gap-2">
              <code data-testid="crm-booking-url"
                    className="flex-1 truncate bg-white border border-slate-200 rounded px-2 py-1.5 text-xs text-slate-700">
                {bookingUrl}
              </code>
              <button onClick={() => { navigator.clipboard.writeText(bookingUrl); toast.success("Copied"); }}
                      data-testid="crm-booking-copy-url"
                      className="p-1.5 rounded hover:bg-white text-slate-500">
                <Copy size={12}/>
              </button>
              <a href={bookingUrl} target="_blank" rel="noreferrer"
                  className="p-1.5 rounded hover:bg-white text-slate-500">
                <ExternalLink size={12}/>
              </a>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold">Slug</label>
              <input defaultValue={s.slug}
                      onBlur={e => e.target.value !== s.slug && save({ slug: e.target.value })}
                      data-testid="crm-booking-slug"
                      className="flex-1 text-xs px-2 py-1 border border-slate-300 rounded"/>
            </div>
          </div>

          {/* meeting link type */}
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1.5">
            Default meeting link
          </div>
          <div className="grid grid-cols-2 gap-2 mb-3">
            {LINK_TYPES.map(t => (
              <button key={t.key}
                      onClick={() => save({ default_meeting_link_type: t.key })}
                      data-testid={`crm-booking-link-${t.key}`}
                      className={`flex items-start gap-2 rounded-lg border p-2.5 text-left transition ${
                        s.default_meeting_link_type === t.key
                          ? "border-violet-500 bg-violet-50/60"
                          : "border-slate-200 bg-white hover:border-slate-300"
                      }`}>
                <div className={`w-6 h-6 rounded flex items-center justify-center shrink-0 ${
                  s.default_meeting_link_type === t.key ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-500"
                }`}>
                  <Video size={12}/>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-slate-800">{t.label}</div>
                  <div className="text-[10px] text-slate-500 leading-tight">{t.hint}</div>
                </div>
                {s.default_meeting_link_type === t.key && (
                  <Check size={11} className="text-violet-600 shrink-0"/>
                )}
              </button>
            ))}
          </div>

          {staticLinkNeeded && (
            <div className="mb-3">
              <label className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
                Your {LINK_TYPES.find(t => t.key === s.default_meeting_link_type)?.label} URL
              </label>
              <input defaultValue={s.static_link_url || ""}
                      onBlur={e => e.target.value !== s.static_link_url && save({ static_link_url: e.target.value })}
                      placeholder="https://…"
                      data-testid="crm-booking-static-url"
                      className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded mt-1"/>
            </div>
          )}

          {/* availability */}
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div>
              <label className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Start hour</label>
              <input type="number" min="0" max="23"
                      defaultValue={s.working_hours_start}
                      onBlur={e => save({ working_hours_start: parseInt(e.target.value, 10) })}
                      data-testid="crm-booking-hours-start"
                      className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded"/>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">End hour</label>
              <input type="number" min="1" max="24"
                      defaultValue={s.working_hours_end}
                      onBlur={e => save({ working_hours_end: parseInt(e.target.value, 10) })}
                      data-testid="crm-booking-hours-end"
                      className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded"/>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Duration (min)</label>
              <select defaultValue={s.duration_min}
                      onChange={e => save({ duration_min: parseInt(e.target.value, 10) })}
                      data-testid="crm-booking-duration"
                      className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded">
                <option>15</option><option>30</option><option>45</option><option>60</option>
              </select>
            </div>
          </div>
          {busy && <div className="text-[10px] text-slate-400"><Loader2 size={9} className="inline animate-spin"/> saving…</div>}
        </>
      )}
    </div>
  );
}

