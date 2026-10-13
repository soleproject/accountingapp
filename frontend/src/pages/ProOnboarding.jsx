import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Loader2, Check, CalendarCheck, Building2, BookOpen, Paintbrush, ArrowLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useBranding } from "@/lib/branding";
import { useCompany } from "@/lib/company";
import { useColumnBox } from "@/hooks/useColumnBox";
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
  const [busy, setBusy] = useState(false);
  const [firmChoice, setFirmChoice] = useState(null);
  const nextRef = useRef(null);
  const { columnRef, colBox } = useColumnBox([!!status && !!branding]);

  const load = useCallback(async () => {
    const [s, b, c] = await Promise.all([
      api.get("/pro/onboarding/status"), api.get("/pro/branding"), api.get("/branding/config").catch(() => ({ data: {} })),
    ]);
    setStatus(s.data); setBranding(b.data || {});
    if (c.data?.private_label_root) setLabelRoot(c.data.private_label_root);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = (patch) => api.post("/pro/onboarding", patch).then(() => api.get("/auth/me").then(r => setUser(r.data.user)).catch(() => {}));
  const finish = async () => {
    if (!firmChoice) { toast.error("Choose yes or no to continue"); return; }
    setBusy(true);
    try {
      await save({ firm_books: firmChoice, done: true });
      if (firmChoice === "yes" && status?.firm_books?.id) {
        await switchCompany?.(status.firm_books.id);
        nav("/onboarding");
      } else nav("/cockpit");
    } finally { setBusy(false); }
  };
  const next = async () => {
    setBusy(true);
    try { if (await nextRef.current?.() !== false) setStep(s => s + 1); }
    finally { setBusy(false); }
  };
  const back = () => setStep(s => Math.max(0, s - 1));

  if (!status || !branding) return <div className="py-24 text-center text-slate-400"><Loader2 className="animate-spin inline" /></div>;
  const Icon = STEPS[step].icon;
  const last = step === STEPS.length - 1;
  return (
    <>
      <div ref={columnRef} className="max-w-2xl mx-auto px-4 py-10 pb-24" data-testid="pro-onboarding">
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
          {step === 0 && <LabelStep branding={branding} labelRoot={labelRoot} nextRef={nextRef} reload={async () => { await load(); await refreshBrand?.(); }} onNext={(pl) => save({ private_label: pl })} />}
          {step === 1 && <CalendarStep connected={status.calendar_connected} nextRef={nextRef} onNext={() => save({ calendar_linked: status.calendar_connected })} />}
          {step === 2 && <FirmStep firm={status.firm_books} choice={firmChoice} setChoice={setFirmChoice} />}
        </div>
      </div>

      <div
        style={{ position: "fixed", bottom: 16, left: colBox.left, width: colBox.width, visibility: colBox.ready ? "visible" : "hidden" }}
        className="z-30 flex items-center justify-center gap-3 pointer-events-none"
        data-testid="pro-onboarding-sticky-footer"
      >
        <div className="flex items-center justify-center gap-3 pointer-events-auto">
          <button
            data-testid="pro-onboarding-back"
            disabled={step === 0 || busy}
            onClick={back}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-white border border-slate-200 shadow-sm text-sm text-slate-600 hover:text-slate-900 hover:border-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ArrowLeft size={14} /> Back
          </button>
          {!last ? (
            <button
              data-testid="pro-onboarding-next"
              onClick={next}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-full bg-slate-900 text-white text-sm shadow-md hover:bg-slate-800 disabled:opacity-60"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : null} Next <ChevronRight size={14} />
            </button>
          ) : (
            <button
              data-testid="pro-onboarding-complete"
              onClick={finish}
              disabled={busy || !firmChoice}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-emerald-600 text-white text-sm shadow-md hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {busy ? <>Finishing… <Loader2 size={14} className="animate-spin" /></> : <>Next step <ChevronRight size={14} /></>}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function LabelStep({ branding, labelRoot, reload, onNext, nextRef }) {
  const [pl, setPl] = useState(branding.signin_subdomain || branding.firm_name_raw ? true : null);
  const [name, setName] = useState(branding.firm_name_raw || branding.firm_name || "");
  const [sub, setSub] = useState(branding.signin_subdomain || "");
  const [subStatus, setSubStatus] = useState(null);
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

  nextRef.current = async () => {
    if (pl === null) { toast.error("Choose yes or no to continue"); return false; }
    if (pl) {
      if (!name.trim()) { toast.error("Enter your enterprise name"); return false; }
      if (sub && subStatus && subStatus !== "ok") { toast.error("Pick an available sign-in address"); return false; }
      try { await api.patch("/pro/branding", { firm_name: name.trim(), ...(sub ? { signin_subdomain: sub.trim().toLowerCase() } : {}) }); await reload(); }
      catch (e) { toast.error(e?.response?.data?.detail || "Couldn't save branding"); return false; }
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
            <LogoSlot variant="icon_light" label="Icon" bg="bg-slate-50" url={logos.icon_light} refresh={reload} square compact />
          </div>
        </div>
      )}
    </div>
  );
}

function CalendarStep({ connected, onNext, nextRef }) {
  nextRef.current = onNext;
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
        <>
          <button onClick={connect} className="inline-flex items-center gap-2 h-10 px-4 rounded-full border border-slate-300 bg-white text-sm font-semibold hover:border-slate-500" data-testid="pro-onboarding-gcal-connect"><CalendarCheck size={15} /> Connect Google Calendar</button>
          <p className="text-[11px] text-slate-400">Not ready? Hit Next to skip for now — you can connect later from Settings.</p>
        </>
      )}
    </div>
  );
}

function FirmStep({ firm, choice, setChoice }) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-600">Do you want to complete the onboarding for your firm's own books{firm?.name ? ` (${firm.name})` : ""} now? You can always do it later from Clients.</p>
      <div className="flex gap-2">
        <button onClick={() => setChoice("yes")} disabled={!firm?.id} className={`inline-flex items-center gap-1.5 h-10 px-4 rounded-full border text-sm font-semibold disabled:opacity-50 ${choice === "yes" ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-300 text-slate-700 hover:border-slate-500"}`} data-testid="pro-onboarding-firm-yes"><Building2 size={14} /> Yes, set up firm books</button>
        <button onClick={() => setChoice("no")} className={`h-10 px-4 rounded-full border text-sm font-semibold ${choice === "no" ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-300 text-slate-700 hover:border-slate-500"}`} data-testid="pro-onboarding-firm-no">No, take me to the Dashboard</button>
      </div>
      {!firm?.id && <p className="text-[11px] text-slate-400">No firm-books company found yet — it's created automatically on your first sign-in.</p>}
    </div>
  );
}
