import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Loader2, Check, CalendarCheck, Building2, BookOpen, Paintbrush, ArrowRight } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useBranding } from "@/lib/branding";
import { useCompany } from "@/lib/company";
import { LogoSlot } from "@/pages/ProSettings";

/**
 * One-time enterprise / accounting-pro onboarding (mirrors the client
 * onboarding wizard). Steps: Private label → Google Calendar → Firm Books.
 * State lives on users.pro_onboarding; branding reuses /pro/branding.
 */
const STEPS = [
  { key: "label", title: "Private label", icon: Paintbrush },
  { key: "calendar", title: "Google Calendar", icon: CalendarCheck },
  { key: "firm", title: "Firm books", icon: BookOpen },
];

export default function ProOnboarding() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { setUser } = useAuth();
  const { refresh: refreshBrand } = useBranding();
  const { switchCompany } = useCompany();
  const [step, setStep] = useState(Number(params.get("step") || 0));
  const [status, setStatus] = useState(null);
  const [branding, setBranding] = useState(null);
  const [labelRoot, setLabelRoot] = useState("accountingapp.ai");

  const load = useCallback(async () => {
    const [s, b, c] = await Promise.all([
      api.get("/pro/onboarding/status"), api.get("/pro/branding"), api.get("/branding/config").catch(() => ({ data: {} })),
    ]);
    setStatus(s.data); setBranding(b.data || {});
    if (c.data?.private_label_root) setLabelRoot(c.data.private_label_root);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = (patch) => api.post("/pro/onboarding", patch).then(() => api.get("/auth/me").then(r => setUser(r.data.user)).catch(() => {}));
  const finish = async (firmBooks) => {
    await save({ firm_books: firmBooks, done: true });
    if (firmBooks === "yes" && status?.firm_books?.id) {
      await switchCompany?.(status.firm_books.id);
      nav("/onboarding");
    } else nav("/cockpit");
  };

  if (!status || !branding) return <div className="py-24 text-center text-slate-400"><Loader2 className="animate-spin inline" /></div>;
  const Icon = STEPS[step].icon;
  return (
    <div className="max-w-2xl mx-auto px-4 py-10" data-testid="pro-onboarding">
      <ol className="flex items-center gap-2 mb-8" data-testid="pro-onboarding-steps">
        {STEPS.map((s, i) => (
          <li key={s.key} className={`flex items-center gap-2 text-xs font-semibold ${i === step ? "text-slate-900" : i < step ? "text-emerald-700" : "text-slate-400"}`}>
            <span className={`h-6 w-6 rounded-full flex items-center justify-center text-[11px] ${i < step ? "bg-emerald-600 text-white" : i === step ? "bg-slate-900 text-white" : "bg-slate-200"}`}>{i < step ? <Check size={12} /> : i + 1}</span>
            {s.title}{i < STEPS.length - 1 && <span className="w-8 h-px bg-slate-200 ml-2" />}
          </li>
        ))}
      </ol>
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-1"><Icon size={18} className="text-slate-700" /><h1 className="font-heading text-xl font-bold text-slate-900">{STEPS[step].title}</h1></div>
        {step === 0 && <LabelStep branding={branding} labelRoot={labelRoot} reload={async () => { await load(); await refreshBrand?.(); }} onNext={async (pl) => { await save({ private_label: pl }); setStep(1); }} />}
        {step === 1 && <CalendarStep connected={status.calendar_connected} onNext={async () => { await save({ calendar_linked: status.calendar_connected }); setStep(2); }} />}
        {step === 2 && <FirmStep firm={status.firm_books} onFinish={finish} />}
      </div>
    </div>
  );
}

function LabelStep({ branding, labelRoot, reload, onNext }) {
  const [pl, setPl] = useState(branding.signin_subdomain || branding.firm_name_raw ? true : null);
  const [name, setName] = useState(branding.firm_name_raw || branding.firm_name || "");
  const [sub, setSub] = useState(branding.signin_subdomain || "");
  const [subStatus, setSubStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const logos = branding.logos || {};

  useEffect(() => {
    if (!sub || sub === (branding.signin_subdomain || "")) { setSubStatus(null); return; }
    setSubStatus("checking");
    const t = setTimeout(async () => {
      try { const r = await api.get(`/branding/subdomain-available?sub=${encodeURIComponent(sub)}`); setSubStatus(r.data?.available ? "ok" : (r.data?.reason || "Unavailable")); }
      catch { setSubStatus("Check failed"); }
    }, 350);
    return () => clearTimeout(t);
  }, [sub, branding.signin_subdomain]);

  const next = async () => {
    if (pl) {
      if (!name.trim()) { toast.error("Enter your enterprise name"); return; }
      if (sub && subStatus && subStatus !== "ok") { toast.error("Pick an available sign-in address"); return; }
      setBusy(true);
      try { await api.patch("/pro/branding", { firm_name: name.trim(), ...(sub ? { signin_subdomain: sub.trim().toLowerCase() } : {}) }); await reload(); }
      catch (e) { toast.error(e?.response?.data?.detail || "Couldn't save branding"); setBusy(false); return; }
      setBusy(false);
    }
    await onNext(!!pl);
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-600">Are you private-labeling this for your firm?</p>
      <div className="flex gap-2">
        {[["Yes", true], ["No", false]].map(([l, v]) => (
          <button key={l} onClick={() => setPl(v)} className={`px-4 py-2 rounded-full border text-sm font-semibold ${pl === v ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-300 text-slate-700 hover:border-slate-500"}`} data-testid={`pro-onboarding-pl-${l.toLowerCase()}`}>{l}</button>
        ))}
      </div>
      {pl && (
        <div className="space-y-4" data-testid="pro-onboarding-label-form">
          <label className="block"><span className="text-xs font-semibold text-slate-600">Enterprise name</span>
            <input value={name} onChange={e => setName(e.target.value)} className="mt-1 w-full h-10 rounded-lg border border-slate-300 px-3 text-sm" placeholder="Synergy AI CPAs" data-testid="pro-onboarding-name" /></label>
          <label className="block"><span className="text-xs font-semibold text-slate-600">Sign-in address</span>
            <div className="mt-1 flex items-center gap-1">
              <input value={sub} onChange={e => setSub(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} className="h-10 flex-1 rounded-lg border border-slate-300 px-3 text-sm font-mono-num" placeholder="synergy" data-testid="pro-onboarding-subdomain" />
              <span className="text-sm text-slate-500">.{labelRoot}</span>
            </div>
            <div className="text-[11px] mt-1 h-4" data-testid="pro-onboarding-subdomain-status">
              {subStatus === "checking" && <span className="text-slate-400">Checking…</span>}
              {subStatus === "ok" && <span className="text-emerald-700">Available</span>}
              {subStatus && !["checking", "ok"].includes(subStatus) && <span className="text-rose-600">{subStatus}</span>}
            </div></label>
          <div className="grid grid-cols-2 gap-4">
            <LogoSlot variant="logo_light" label="Main logo" bg="bg-slate-50" url={logos.logo_light} refresh={reload} />
            <LogoSlot variant="icon_light" label="Icon" bg="bg-slate-50" url={logos.icon_light} refresh={reload} square />
          </div>
        </div>
      )}
      <div className="flex justify-end pt-2">
        <button onClick={next} disabled={pl === null || busy} className="inline-flex items-center gap-1.5 h-10 px-4 rounded-full bg-slate-900 text-white text-sm font-semibold disabled:opacity-50" data-testid="pro-onboarding-next-0">{busy ? <Loader2 size={14} className="animate-spin" /> : null} Continue <ArrowRight size={14} /></button>
      </div>
    </div>
  );
}

function CalendarStep({ connected, onNext }) {
  const connect = async () => {
    try { const r = await api.get("/oauth/gmail/start?return_to=/pro/onboarding?step=1"); window.location.href = r.data.auth_url; }
    catch (e) { toast.error(e?.response?.data?.detail || "Couldn't start Google connect"); }
  };
  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-600">Link your Google Calendar to see appointments on your Today page and get a Calendar link in the sidebar.</p>
      {connected ? (
        <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2" data-testid="pro-onboarding-gcal-connected"><Check size={14} /> Google Calendar connected</div>
      ) : (
        <button onClick={connect} className="inline-flex items-center gap-2 h-10 px-4 rounded-full border border-slate-300 bg-white text-sm font-semibold hover:border-slate-500" data-testid="pro-onboarding-gcal-connect"><CalendarCheck size={15} /> Connect Google Calendar</button>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onNext} className="h-10 px-4 rounded-full bg-slate-900 text-white text-sm font-semibold inline-flex items-center gap-1.5" data-testid="pro-onboarding-next-1">{connected ? "Continue" : "Skip for now"} <ArrowRight size={14} /></button>
      </div>
    </div>
  );
}

function FirmStep({ firm, onFinish }) {
  const [busy, setBusy] = useState(null);
  const go = async (v) => { setBusy(v); try { await onFinish(v); } finally { setBusy(null); } };
  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-600">Do you want to complete the onboarding for your firm's own books{firm?.name ? ` (${firm.name})` : ""} now? You can always do it later from Clients.</p>
      <div className="flex gap-2">
        <button onClick={() => go("yes")} disabled={!!busy || !firm?.id} className="inline-flex items-center gap-1.5 h-10 px-4 rounded-full bg-slate-900 text-white text-sm font-semibold disabled:opacity-50" data-testid="pro-onboarding-firm-yes">{busy === "yes" ? <Loader2 size={14} className="animate-spin" /> : <Building2 size={14} />} Yes, set up firm books</button>
        <button onClick={() => go("no")} disabled={!!busy} className="h-10 px-4 rounded-full border border-slate-300 bg-white text-sm font-semibold hover:border-slate-500 disabled:opacity-50" data-testid="pro-onboarding-firm-no">No, take me to Today</button>
      </div>
      {!firm?.id && <p className="text-[11px] text-slate-400">No firm-books company found yet — it's created automatically on your first sign-in.</p>}
    </div>
  );
}
