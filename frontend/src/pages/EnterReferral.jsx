/**
 * Public referral landing page — `/refer/:slug?for=owner|pro|enterprise&src=tag`.
 * Role-specific copy + lead form; on submit routes the prospect (signup / book / call)
 * and shows a "what happens next" state instead of dead-ending.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import axios from "axios";
import { Check, Sparkles } from "lucide-react";
import { VARIANTS, FIRM_OWNER, fill } from "@/components/affiliate/landingCopy";
import { LeadForm } from "@/components/affiliate/LeadForm";
import { LeadDone } from "@/components/affiliate/LeadDone";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const FOR_MAP = { owner: "owner", business_owner: "owner", pro: "pro", accounting_pro: "pro", accountant: "pro", enterprise: "enterprise" };

export default function EnterReferral() {
  const { slug: urlSlug } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const slug = urlSlug || params.get("ref") || "";
  const sourceTag = params.get("src") || "";
  const [vkey, setVkey] = useState(FOR_MAP[(params.get("for") || "").toLowerCase()] || "owner");
  const [referrer, setReferrer] = useState(null);
  const [firm, setFirm] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!slug) return;
    axios.get(`${API}/public/refer/${encodeURIComponent(slug)}`).then(r => {
      setReferrer(r.data?.referrer || null);
      setFirm(r.data?.firm_slug ? { slug: r.data.firm_slug, name: r.data.firm_name, logo_url: r.data.firm_logo_url } : null);
    }).catch(() => setReferrer(null));
  }, [slug]);

  const variant = VARIANTS[vkey];
  const brand = firm?.name || "SmartBooks";
  const copy = useMemo(() => {
    const ctx = { brand, firm: firm?.name || "", refName: referrer || "They", refApplied: referrer ? ` ${referrer}'s referral is already applied.` : "" };
    const base = { ...variant };
    if (firm && vkey === "owner") Object.assign(base, FIRM_OWNER);
    const out = {};
    for (const k of Object.keys(base)) out[k] = Array.isArray(base[k]) ? base[k].map(x => typeof x === "string" ? fill(x, ctx) : x) : (typeof base[k] === "string" ? fill(base[k], ctx) : base[k]);
    return out;
  }, [variant, firm, referrer, brand, vkey]);

  const goSignup = () => {
    const qs = new URLSearchParams();
    if (slug) qs.set("ref", slug);
    if (firm?.slug) qs.set("firm", firm.slug);
    if (result?.form?.email) qs.set("email", result.form.email);
    if (result?.form?.name) qs.set("name", result.form.name);
    if (result?.form?.company) qs.set("business", result.form.company);
    nav(`/signup?${qs.toString()}`);
  };

  const initials = (referrer || "").split(" ").map(s => s[0]).join("").slice(0, 2).toUpperCase();

  return (
    <div className="min-h-screen bg-[#F5F6F8] text-slate-900" data-testid="enter-referral-page">
      <header className="h-14 bg-white/85 backdrop-blur border-b border-slate-200 flex items-center px-4 sm:px-8 gap-3">
        {firm?.logo_url ? <img src={firm.logo_url} alt={brand} className="h-8 w-auto max-w-[160px] object-contain" />
          : <div className="h-7 w-7 rounded-lg bg-slate-900 grid place-items-center text-white"><Sparkles size={14} /></div>}
        <span className="font-heading font-extrabold tracking-tight text-lg" data-testid="landing-brand">{brand}</span>
        <span className="flex-1" />
        {firm && <span className="hidden sm:inline-flex items-center h-6 px-2.5 rounded-full bg-indigo-50 text-indigo-700 text-[11px] font-semibold border border-indigo-100">Private label · {firm.name}</span>}
        <Link to="/login" className="text-sm text-slate-500 hover:text-slate-900" data-testid="landing-signin-link">Already a customer? Sign in</Link>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-8 pt-8 pb-16">
        {!firm && (
          <div className="flex gap-2 mb-6 overflow-x-auto" data-testid="landing-variant-tabs">
            {Object.values(VARIANTS).map(v => (
              <button key={v.key} onClick={() => setVkey(v.key)} data-testid={`landing-variant-${v.key}`}
                className={"h-8 px-4 rounded-full text-xs font-semibold whitespace-nowrap border transition-colors " + (vkey === v.key ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200 hover:border-slate-400")}>
                {v.tab}
              </button>
            ))}
          </div>
        )}

        <div className="grid lg:grid-cols-[1.1fr_.9fr] gap-10 items-start">
          <div>
            {referrer && (
              <div className="inline-flex items-center gap-2.5 bg-white border border-slate-200 rounded-full pl-1.5 pr-4 py-1.5 text-sm" data-testid="referrer-badge">
                <span className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-800 text-[11px] font-bold grid place-items-center">{initials}</span>
                <span><b>{referrer}</b> invited you</span>
              </div>
            )}
            <div className="text-[11px] font-bold tracking-[.14em] uppercase mt-6" style={{ color: firm ? "#0e7490" : "#4f46e5" }} data-testid="landing-eyebrow">{copy.eyebrow}</div>
            <h1 className="font-heading font-extrabold tracking-tight text-3xl sm:text-4xl lg:text-5xl leading-[1.08] mt-3" data-testid="landing-h1">{copy.h1}</h1>
            <p className="text-base sm:text-lg text-slate-600 leading-relaxed mt-4 max-w-xl">{copy.lead}</p>
            <ul className="mt-6 grid sm:grid-cols-2 gap-3">
              {copy.checks.map((c, i) => (
                <li key={i} className="flex gap-2.5 text-sm text-slate-800"><span className="w-5 h-5 rounded-full bg-emerald-50 text-emerald-700 grid place-items-center shrink-0 mt-0.5"><Check size={12} /></span>{c}</li>
              ))}
            </ul>
            <div className="hidden lg:grid grid-cols-3 gap-4 mt-12">
              {copy.steps.map((s, i) => {
                const [t, ...rest] = s.split(" — ");
                return (
                  <div key={i} className="bg-white border border-slate-200 rounded-2xl p-4">
                    <div className="w-7 h-7 rounded-full text-white font-heading font-bold text-sm grid place-items-center" style={{ background: firm ? "#0e7490" : "#0f172a" }}>{i + 1}</div>
                    <div className="font-heading font-bold mt-3">{t}</div>
                    <p className="text-xs text-slate-500 mt-1 leading-relaxed">{rest.join(" — ")}</p>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="lg:sticky lg:top-6">
            {result
              ? <LeadDone result={result} variant={variant} referrer={referrer} firm={firm ? { ...firm, color: "#0e7490" } : null} onSignup={goSignup} />
              : <LeadForm variant={variant} copy={copy} slug={slug} firm={firm ? { ...firm, color: "#0e7490" } : null} sourceTag={sourceTag} onDone={setResult} />}
          </div>
        </div>

        <div className="mt-14 bg-white border border-slate-200 rounded-2xl p-6 grid sm:grid-cols-3 gap-6 text-sm text-slate-500">
          <div><div className="font-mono text-xl font-semibold text-slate-900">94%</div>of transactions auto-categorized</div>
          <div><div className="font-mono text-xl font-semibold text-slate-900">&lt; 2 min</div>weekly owner check-in</div>
          <div><div className="font-mono text-xl font-semibold text-slate-900">Read-only</div>bank access via Plaid, encrypted at rest</div>
        </div>

        {!firm && (
          <p className="mt-10 text-center text-xs text-slate-500">
            Want to earn by referring others? <Link to={`/affiliates${slug ? `?ref=${slug}` : ""}`} className="underline font-medium text-slate-700" data-testid="landing-become-affiliate-link">Become an affiliate</Link>
          </p>
        )}
      </main>
    </div>
  );
}
