/** Superadmin editor for the Affiliate Sales Center: toolkit content, settings, drips. */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, Wrench, Plus, Trash2, RotateCcw, Save, Play, Mail } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";

const SECTION_META = {
  pitches: { label: "Pitches", fields: ["title", "audience", "body"] },
  who_first: { label: "Who to talk to first", fields: ["title", "body"] },
  templates: { label: "Text & email templates", fields: ["id", "title", "channel", "stage", "audience", "subject", "body"] },
  objections: { label: "Objections", fields: ["q", "a"] },
  social: { label: "Social posts", fields: ["title", "body"] },
  faq: { label: "Public FAQ (/affiliates)", fields: ["q", "a"] },
};
const LONG = new Set(["body", "a"]);
const DRIP_STEPS = { A: ["a2_signup", "a2_bank", "a5_case", "a9_checkin", "a_trial3", "a_trial1", "a_lapsed7", "a2_pro", "a5_pro", "a3_ent"], B: ["b0_welcome", "b1_whofirst", "b3_accountant", "b7_noclicks", "b14_noleads"] };

function SectionEditor({ name, items, overridden, onSave, onReset }) {
  const [draft, setDraft] = useState(items);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(items), [items]);
  const meta = SECTION_META[name];
  const upd = (i, k, v) => setDraft(d => d.map((it, j) => j === i ? { ...it, [k]: v } : it));
  const save = async () => { setBusy(true); try { await onSave(name, draft); } finally { setBusy(false); } };
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5" data-testid={`toolkit-editor-${name}`}>
      <div className="flex items-center gap-3 mb-3">
        <h3 className="font-heading font-bold text-lg">{meta.label}</h3>
        {overridden && <span className="text-[10px] font-bold uppercase tracking-[.1em] text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">Customized</span>}
        <span className="flex-1" />
        {overridden && <button onClick={() => onReset(name)} className="h-8 px-3 rounded-full border border-slate-300 text-xs font-semibold flex items-center gap-1" data-testid={`toolkit-reset-${name}`}><RotateCcw size={12} /> Reset to defaults</button>}
        <button onClick={() => setDraft(d => [...d, Object.fromEntries(meta.fields.map(f => [f, ""]))])} className="h-8 px-3 rounded-full border border-slate-300 text-xs font-semibold flex items-center gap-1" data-testid={`toolkit-add-${name}`}><Plus size={12} /> Add</button>
        <button onClick={save} disabled={busy} className="h-8 px-3 rounded-full bg-slate-900 text-white text-xs font-semibold flex items-center gap-1 disabled:opacity-60" data-testid={`toolkit-save-${name}`}><Save size={12} /> Save</button>
      </div>
      <div className="space-y-3">
        {draft.map((it, i) => (
          <div key={i} className="rounded-xl border border-slate-200 p-3 grid gap-2 relative" data-testid={`toolkit-item-${name}-${i}`}>
            <button onClick={() => setDraft(d => d.filter((_, j) => j !== i))} className="absolute top-2 right-2 p-1 text-slate-400 hover:text-red-600" data-testid={`toolkit-remove-${name}-${i}`}><Trash2 size={14} /></button>
            <div className="grid sm:grid-cols-4 gap-2 pr-8">
              {meta.fields.filter(f => !LONG.has(f)).map(f => (
                <label key={f} className="text-[11px] font-semibold text-slate-500">{f}
                  <input value={it[f] || ""} onChange={e => upd(i, f, e.target.value)} className="mt-0.5 w-full h-8 rounded-md border border-slate-300 px-2 text-xs font-normal text-slate-900" data-testid={`toolkit-field-${name}-${i}-${f}`} />
                </label>
              ))}
            </div>
            {meta.fields.filter(f => LONG.has(f)).map(f => (
              <label key={f} className="text-[11px] font-semibold text-slate-500">{f}
                <textarea value={it[f] || ""} onChange={e => upd(i, f, e.target.value)} rows={3} className="mt-0.5 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm font-normal text-slate-900 leading-relaxed" data-testid={`toolkit-field-${name}-${i}-${f}`} />
              </label>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsPanel() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get("/admin/affiliate/settings").then(r => setData(r.data));
  useEffect(() => { load(); }, []);
  if (!data) return null;
  const s = data.settings;
  const set = (k, v) => setData({ ...data, settings: { ...s, [k]: v } });
  const save = async () => { setBusy(true); try { await api.put("/admin/affiliate/settings", { settings: s }); toast.success("Settings saved"); } catch (e) { toast.error(e?.response?.data?.detail || "Failed"); } finally { setBusy(false); } };
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5" data-testid="affiliate-settings">
      <h3 className="font-heading font-bold text-lg">Routing settings</h3>
      <div className="grid sm:grid-cols-2 gap-4 mt-3">
        <label className="text-xs font-semibold text-slate-600">Walkthrough calendar (accounting-pro leads)
          <select value={s.walkthrough_booking_slug || ""} onChange={e => set("walkthrough_booking_slug", e.target.value)} className="mt-1 w-full h-10 rounded-lg border border-slate-300 px-2 text-sm font-normal" data-testid="settings-booking-slug">
            <option value="">No live booking — notify admins to reach out</option>
            {data.booking_slugs.map(b => <option key={b.slug} value={b.slug}>/book/{b.slug} · {b.owner}</option>)}
          </select>
          <span className="block text-[11px] text-slate-500 font-normal mt-1">Create one via your profile → Booking page, then pick it here.</span>
        </label>
        <label className="text-xs font-semibold text-slate-600">Admin notification emails (pro / enterprise leads)
          <input value={s.admin_notify_emails || ""} onChange={e => set("admin_notify_emails", e.target.value)} placeholder="empty = all superadmins" className="mt-1 w-full h-10 rounded-lg border border-slate-300 px-3 text-sm font-normal" data-testid="settings-admin-emails" />
        </label>
      </div>
      <button onClick={save} disabled={busy} className="mt-4 h-9 px-4 rounded-full bg-slate-900 text-white text-xs font-semibold flex items-center gap-1 disabled:opacity-60" data-testid="settings-save"><Save size={12} /> Save settings</button>
    </div>
  );
}

function DripsPanel() {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  useEffect(() => { api.get("/cron/affiliate-drips/steps").then(r => setLast(r.data.last_run)).catch(() => {}); }, []);
  const run = async (dry) => {
    setBusy(true);
    try { const r = await api.post(`/cron/affiliate-drips/trigger?dry=${dry}`); setResult(r.data); toast.success(dry ? "Dry run complete" : "Drips sent"); }
    catch { toast.error("Run failed"); } finally { setBusy(false); }
  };
  const base = process.env.REACT_APP_BACKEND_URL;
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5" data-testid="drips-panel">
      <div className="flex items-center gap-3 flex-wrap">
        <h3 className="font-heading font-bold text-lg">Email drips</h3>
        <span className="text-xs text-slate-500">{last?.last_run_at ? `Last run ${last.last_run_at.slice(0, 16).replace("T", " ")} UTC · A ${last.last_stats?.a_sent}/${last.last_stats?.a_considered} · B ${last.last_stats?.b_sent}/${last.last_stats?.b_considered}` : "Never run"}</span>
        <span className="flex-1" />
        <button onClick={() => run(true)} disabled={busy} className="h-8 px-3 rounded-full border border-slate-300 text-xs font-semibold flex items-center gap-1" data-testid="drips-dry-run"><Play size={12} /> Dry run</button>
        <button onClick={() => run(false)} disabled={busy} className="h-8 px-3 rounded-full bg-slate-900 text-white text-xs font-semibold flex items-center gap-1" data-testid="drips-run-now"><Mail size={12} /> Send due emails now</button>
      </div>
      <p className="text-xs text-slate-500 mt-2">Daily cron <span className="font-mono">POST /api/cron/affiliate-drips</span> (Bearer WEBHOOK_CRON_SECRET). Loop A nurtures prospects (day 2 / 5 / 9, trial −3 / −1, lapsed +7); Loop B activates affiliates (day 1 / 3, day 7 if no clicks, day 14 if no leads). One email per person per run; each step sent once.</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {Object.entries(DRIP_STEPS).map(([loop, steps]) => steps.map(st => (
          <a key={st} href={`${base}/api/cron/affiliate-drips/preview?loop=${loop}&step=${st}`} target="_blank" rel="noreferrer" className="text-[11px] font-mono px-2 py-1 rounded-full border border-slate-200 bg-slate-50 hover:bg-white" data-testid={`drip-preview-${st}`}>{loop} · {st}</a>
        )))}
      </div>
      <p className="text-[11px] text-slate-400 mt-1">Previews open with sample data and require your admin session cookie/token — if blocked, use the Dry run plan below.</p>
      {result && (
        <div className="mt-3 rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs" data-testid="drips-result">
          <div className="font-semibold">A: {result.a_sent}/{result.a_considered} · B: {result.b_sent}/{result.b_considered}</div>
          {(result.plan || []).slice(0, 50).map((p, i) => <div key={i} className="font-mono text-slate-600">{p.loop} · {p.email} · {p.step} · {p.status}</div>)}
          {(result.plan || []).length === 0 && <div className="text-slate-500">Nothing due.</div>}
        </div>
      )}
    </div>
  );
}

export default function AdminAffiliateToolkit() {
  const [data, setData] = useState(null);
  const load = () => api.get("/admin/affiliate/toolkit").then(r => setData(r.data)).catch(() => toast.error("Failed to load"));
  useEffect(() => { load(); }, []);
  const save = async (name, items) => {
    try { await api.put("/admin/affiliate/toolkit", { toolkit: { ...(data.overrides || {}), [name]: items } }); toast.success("Saved"); load(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Save failed"); }
  };
  const reset = async (name) => { await api.delete(`/admin/affiliate/toolkit/${name}`); toast.success("Reset"); load(); };
  return (
    <div className="space-y-5" data-testid="admin-affiliate-toolkit-page">
      <Link to="/admin/affiliates" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800" data-testid="admin-toolkit-back"><ChevronLeft size={16} /> Affiliates</Link>
      <div className="flex items-center gap-3">
        <Wrench className="text-indigo-600" size={22} />
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Affiliate Sales Center — content &amp; settings</h1>
          <p className="text-sm text-slate-500">Edit the scripts, templates and objection answers affiliates see, choose the walkthrough calendar, and run the drips. Merge fields: {(data?.merge_fields || []).map(f => `{${f}}`).join(" ")}</p>
        </div>
      </div>
      <SettingsPanel />
      <DripsPanel />
      {data && Object.keys(SECTION_META).map(name => (
        <SectionEditor key={name} name={name} items={data.toolkit[name] || []} overridden={!!data.overrides?.[name]} onSave={save} onReset={reset} />
      ))}
    </div>
  );
}
