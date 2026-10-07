import { useState } from "react";
import { Hourglass, Landmark, Mail, Star, Send, ArrowRight } from "lucide-react";
import { SendSheet } from "./SendSheet";
import { fmtUsd } from "./tools";

const ICON = { trial_ending: [Hourglass, "bg-orange-50 text-orange-700"], no_bank: [Landmark, "bg-cyan-50 text-cyan-700"],
  stale_lead: [Mail, "bg-indigo-50 text-indigo-700"], ask_intro: [Star, "bg-emerald-50 text-emerald-700"], first_text: [Send, "bg-slate-100 text-slate-700"] };

export function TodayTab({ center, toolkit, onChanged, onGoto }) {
  const [sheet, setSheet] = useState(null);
  if (!center) return <div className="text-sm text-slate-400 p-6">Loading…</div>;
  const s = center.stats || {};
  const stats = [
    ["Clicks · 30d", s.clicks_30d || 0, s.clicks_delta ? `${s.clicks_delta > 0 ? "▲" : "▼"} ${Math.abs(s.clicks_delta)} vs prior 30d` : "—"],
    ["Leads", s.leads || 0, s.clicks_30d ? `${Math.round(100 * (s.leads || 0) / s.clicks_30d)}% of clicks` : "—"],
    ["Signed up", s.signed_up || 0, `${s.trialing || 0} in trial`],
    ["Paying", s.paying || 0, `${fmtUsd(s.recurring_cents || 0)}/mo to you`],
  ];
  return (
    <div data-testid="today-tab">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stats.map(([k, v, d]) => (
          <div key={k} className="bg-white border border-slate-200 rounded-2xl px-4 py-3" data-testid={`today-stat-${k.split(" ")[0].toLowerCase()}`}>
            <div className="text-[11px] uppercase tracking-[.1em] text-slate-500 font-semibold">{k}</div>
            <div className="font-mono text-2xl font-semibold mt-1">{v}</div>
            <div className="text-[11px] text-slate-500 mt-0.5">{d}</div>
          </div>
        ))}
      </div>

      <div className="text-[11px] font-bold tracking-[.14em] uppercase text-indigo-600 mt-7 mb-2">Do this today</div>
      {center.today.length === 0 && (
        <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-6 text-sm text-slate-500" data-testid="today-empty">
          Nothing urgent. Everyone in your pipeline is on track — a good day to send one new text. <button onClick={() => onGoto("toolkit")} className="underline font-medium text-slate-700">Open the Toolkit</button>
        </div>
      )}
      <div className="space-y-2">
        {center.today.map((it, i) => {
          const [Icon, cls] = ICON[it.kind] || ICON.first_text;
          const lead = center.pipeline.find(r => r.email === it.email);
          return (
            <div key={i} className={"bg-white border rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center gap-3 " + (it.kind === "trial_ending" ? "border-orange-200" : "border-slate-200")} data-testid={`today-item-${it.kind}`}>
              <div className={"w-9 h-9 rounded-xl grid place-items-center shrink-0 " + cls}><Icon size={16} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm text-slate-900">{it.title}</div>
                <div className="text-xs text-slate-500 mt-0.5">{it.body}</div>
              </div>
              <button onClick={() => setSheet({ templateId: it.template, ctx: it.ctx, lead: lead ? { ...lead, lead_id: lead.lead_id } : { email: it.email, phone: it.phone } })}
                className="h-9 px-4 rounded-full bg-slate-900 text-white text-xs font-semibold flex items-center justify-center gap-1.5 shrink-0" data-testid={`today-cta-${it.kind}`}>
                {it.cta} <ArrowRight size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {center.pipeline.length > 0 && (
        <div className="mt-7 flex items-center justify-between">
          <div className="text-[11px] font-bold tracking-[.14em] uppercase text-slate-500">Pipeline</div>
          <button onClick={() => onGoto("pipeline")} className="text-xs font-medium text-slate-700 underline" data-testid="today-open-pipeline">Open the board →</button>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {center.stages?.map(st => (center.counts?.[st] || 0) > 0 && (
          <span key={st} className="inline-flex items-center h-7 px-3 rounded-full bg-white border border-slate-200 text-xs font-semibold text-slate-700" data-testid={`today-count-${st}`}>{st.replace("_", " ")} · {center.counts[st]}</span>
        ))}
      </div>

      <SendSheet open={!!sheet} onClose={() => setSheet(null)} toolkit={toolkit} templateId={sheet?.templateId} ctx={sheet?.ctx} lead={sheet?.lead} onLogged={onChanged} />
    </div>
  );
}
