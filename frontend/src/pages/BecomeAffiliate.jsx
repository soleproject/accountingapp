/** Public recruiting page — /affiliates. Live earnings calculator from real payout tiers. */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import axios from "axios";
import { Sparkles, ChevronDown } from "lucide-react";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const usd = c => "$" + Math.round(c / 100).toLocaleString();

export default function BecomeAffiliate() {
  const [params] = useSearchParams();
  const ref = params.get("ref") || "";
  const [prog, setProg] = useState(null);
  const [owners, setOwners] = useState(10);
  const [firms, setFirms] = useState(2);
  const [planIx, setPlanIx] = useState(2);
  const [openFaq, setOpenFaq] = useState(0);

  useEffect(() => { axios.get(`${API}/public/affiliate-program`).then(r => setProg(r.data)).catch(() => setProg({ payouts: [], faq: [] })); }, []);

  const biz = useMemo(() => (prog?.payouts || []).filter(p => p.audience === "Business"), [prog]);
  const firm = useMemo(() => (prog?.payouts || []).find(p => p.audience !== "Business"), [prog]);
  const plan = biz[Math.min(planIx, Math.max(0, biz.length - 1))];
  const monthly = (plan ? owners * plan.payout_cents : 0) + (firm ? firms * firm.payout_cents : 0);
  const signupHref = `/signup/affiliate${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;

  return (
    <div className="min-h-screen bg-[#F5F6F8] text-slate-900" data-testid="become-affiliate-page">
      <header className="h-14 bg-white/85 backdrop-blur border-b border-slate-200 flex items-center px-4 sm:px-8 gap-3">
        <div className="h-7 w-7 rounded-lg bg-slate-900 grid place-items-center text-white"><Sparkles size={14} /></div>
        <span className="font-heading font-extrabold tracking-tight text-lg">SmartBooks</span>
        <span className="flex-1" />
        <Link to="/login" className="text-sm text-slate-500 hover:text-slate-900 hidden sm:inline">Sign in</Link>
        <Link to={signupHref} className="h-9 px-4 rounded-full bg-slate-900 text-white text-sm font-semibold flex items-center" data-testid="affiliates-header-cta">Become an affiliate</Link>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-8 pb-20">
        <section className="grid lg:grid-cols-2 gap-10 items-center pt-10 sm:pt-16">
          <div>
            <div className="text-[11px] font-bold tracking-[.14em] uppercase text-indigo-600">Affiliate program</div>
            <h1 className="font-heading font-extrabold tracking-tight text-4xl sm:text-5xl lg:text-6xl leading-[1.05] mt-3">Refer a business once.<br />Get paid every month they stay.</h1>
            <p className="text-base sm:text-lg text-slate-600 leading-relaxed mt-5">Earn a fixed payout on <b>every invoice</b> your referrals pay — business owners <i>and</i> accounting firms — for as long as they're customers. No cap, no decay, paid monthly. We give you the links, the scripts and a pipeline that tells you who to call.</p>
            <div className="flex flex-wrap gap-3 mt-7">
              <Link to={signupHref} className="h-12 px-6 rounded-full bg-slate-900 text-white font-semibold flex items-center" data-testid="affiliates-hero-cta">Get my link — it's free</Link>
              <a href="#how" className="h-12 px-5 rounded-full border border-slate-300 bg-white font-semibold flex items-center">See how it works ↓</a>
            </div>
            <p className="text-xs text-slate-500 mt-3">Takes 60 seconds · no customer account needed · upgrade to the full platform any time</p>
          </div>

          <div className="rounded-3xl bg-slate-900 text-white p-6 sm:p-7" data-testid="affiliates-calculator">
            <div className="text-[11px] tracking-[.12em] uppercase font-bold text-indigo-300">Earnings calculator</div>
            <label className="flex justify-between text-sm text-slate-300 mt-4">Business owners you refer <b className="font-mono text-white" data-testid="calc-owners-value">{owners}</b></label>
            <input type="range" min={0} max={100} value={owners} onChange={e => setOwners(+e.target.value)} className="w-full accent-emerald-400 mt-2" data-testid="calc-owners" />
            <label className="flex justify-between text-sm text-slate-300 mt-4">Accounting firms you refer <b className="font-mono text-white" data-testid="calc-firms-value">{firms}</b></label>
            <input type="range" min={0} max={30} value={firms} onChange={e => setFirms(+e.target.value)} className="w-full accent-emerald-400 mt-2" data-testid="calc-firms" />
            <label className="flex justify-between text-sm text-slate-300 mt-4">Average business plan <b className="font-mono text-white" data-testid="calc-plan-value">{plan ? `${plan.plan} · $${plan.price_cents / 100}` : "—"}</b></label>
            <input type="range" min={0} max={Math.max(0, biz.length - 1)} value={Math.min(planIx, Math.max(0, biz.length - 1))} onChange={e => setPlanIx(+e.target.value)} className="w-full accent-emerald-400 mt-2" data-testid="calc-plan" />
            <div className="grid grid-cols-2 gap-3 mt-6">
              <div className="rounded-2xl bg-slate-800 p-4"><div className="text-[11px] text-indigo-300 uppercase tracking-[.1em] font-bold">Per month</div><div className="font-mono text-3xl font-bold text-emerald-300 mt-1" data-testid="calc-monthly">{usd(monthly)}</div></div>
              <div className="rounded-2xl bg-slate-800 p-4"><div className="text-[11px] text-indigo-300 uppercase tracking-[.1em] font-bold">Per year</div><div className="font-mono text-3xl font-bold text-emerald-300 mt-1" data-testid="calc-yearly">{usd(monthly * 12)}</div></div>
            </div>
            <p className="text-xs text-slate-400 mt-3">{firm ? `Firms: ${usd(firm.payout_cents)}/mo each on the $${firm.price_cents / 100} plan. ` : ""}{plan ? `Owners: ${usd(plan.payout_cents)}/mo each on ${plan.plan}.` : ""} Paid on every invoice they pay.</p>
          </div>
        </section>

        <section id="how" className="mt-20">
          <div className="text-[11px] font-bold tracking-[.14em] uppercase text-indigo-600">How it works</div>
          <h2 className="font-heading font-bold text-2xl sm:text-3xl tracking-tight mt-2">Three steps, and the app does the chasing.</h2>
          <div className="grid sm:grid-cols-3 gap-4 mt-6">
            {[["Get your link", "One link, three landing pages (owner / accountant / enterprise). Share by text, QR or post."],
              ["Introduce, don't sell", "We send the welcome, the trial reminders and the walkthrough invite. Your Sales Center tells you the one thing to do each day."],
              ["Get paid monthly", "Every invoice your referral pays shows in Payouts. Monthly payout. Forever."]].map(([t, b], i) => (
              <div key={i} className="bg-white border border-slate-200 rounded-2xl p-5"><div className="w-8 h-8 rounded-full bg-slate-900 text-white font-heading font-bold grid place-items-center">{i + 1}</div><div className="font-heading font-bold mt-3">{t}</div><p className="text-sm text-slate-500 mt-1 leading-relaxed">{b}</p></div>
            ))}
          </div>
        </section>

        <section className="mt-16">
          <div className="text-[11px] font-bold tracking-[.14em] uppercase text-indigo-600">What you earn</div>
          <h2 className="font-heading font-bold text-2xl sm:text-3xl tracking-tight mt-2">Fixed payout, every plan, every month.</h2>
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden mt-5 overflow-x-auto" data-testid="affiliates-payout-table">
            <table className="w-full text-sm min-w-[520px]">
              <thead><tr className="text-left text-[11px] uppercase tracking-[.08em] text-slate-500 bg-slate-50"><th className="px-4 py-3 font-semibold">Referral type</th><th className="px-4 py-3 font-semibold">They pay / mo</th><th className="px-4 py-3 font-semibold">You earn / mo</th><th className="px-4 py-3 font-semibold">10 referrals</th></tr></thead>
              <tbody>
                {(prog?.payouts || []).map(p => (
                  <tr key={p.plan} className="border-t border-slate-100" data-testid={`payout-row-${p.plan.replace(/\s+/g, "-").toLowerCase()}`}>
                    <td className="px-4 py-3">{p.audience === "Business" ? "Business" : <b>Accounting firm</b>} · {p.plan}</td>
                    <td className="px-4 py-3 font-mono">${p.price_cents / 100}{p.audience !== "Business" && <span className="text-slate-400"> + $15/client</span>}</td>
                    <td className="px-4 py-3 font-mono text-emerald-700 font-semibold">{usd(p.payout_cents)}</td>
                    <td className="px-4 py-3 font-mono">{usd(p.payout_cents * 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-16 grid lg:grid-cols-2 gap-10">
          <div>
            <div className="text-[11px] font-bold tracking-[.14em] uppercase text-indigo-600">Questions</div>
            <h2 className="font-heading font-bold text-2xl tracking-tight mt-2 mb-4">Straight answers</h2>
            {(prog?.faq || []).map((f, i) => (
              <div key={i} className="bg-white border border-slate-200 rounded-xl mb-2 overflow-hidden">
                <button onClick={() => setOpenFaq(openFaq === i ? -1 : i)} className="w-full text-left px-4 py-3 font-semibold text-sm flex justify-between items-center gap-3" data-testid={`affiliates-faq-${i}`}>{f.q}<ChevronDown size={14} className={"shrink-0 transition-transform " + (openFaq === i ? "rotate-180" : "")} /></button>
                {openFaq === i && <div className="px-4 pb-4 text-sm text-slate-600 leading-relaxed border-t border-slate-100 pt-3">{f.a}</div>}
              </div>
            ))}
          </div>
          <div className="bg-white border border-slate-200 rounded-2xl p-6 h-fit lg:sticky lg:top-6">
            <h3 className="font-heading font-bold text-lg">Get your link</h3>
            <p className="text-sm text-slate-500 mt-1">60 seconds. We'll email your login and the first three texts to send.</p>
            <ul className="mt-4 space-y-2 text-sm text-slate-700">
              {["Free Sales Center login — no customer account needed", "Daily “do this today” list and a pipeline of every referral", "Scripts, objection answers and copy-paste templates"].map((t, i) => <li key={i} className="flex gap-2"><span className="w-5 h-5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-bold grid place-items-center shrink-0">✓</span>{t}</li>)}
            </ul>
            <Link to={signupHref} className="mt-5 h-12 w-full rounded-full bg-slate-900 text-white font-semibold flex items-center justify-center" data-testid="affiliates-signup-cta">Create my affiliate account →</Link>
            <p className="text-[11px] text-slate-500 text-center mt-2.5">By continuing you agree to the affiliate terms. Payouts monthly once the referral's invoice settles.</p>
          </div>
        </section>
      </main>
    </div>
  );
}
