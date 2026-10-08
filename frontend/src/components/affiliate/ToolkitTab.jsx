import { useState } from "react";
import { Copy, QrCode, ChevronDown } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { renderTpl, copyText } from "./tools";

const SECTIONS = [["pitch", "Start here · pitch"], ["who", "Who to talk to first"], ["templates", "Text & email templates"], ["objections", "Objections"], ["social", "Social posts"], ["links", "My links & QR"]];
const STAGES = [["first_touch", "First touch"], ["follow_up", "Follow-up"], ["signed_up", "Signed up"], ["trial_ending", "Trial ending"], ["ask_intro", "Ask for intro"], ["win_back", "Win-back"]];

function CopyBtn({ text, testid }) {
  return <button onClick={() => copyText(text)} className="h-8 px-3 rounded-full border border-slate-300 bg-white text-slate-900 text-xs font-semibold flex items-center gap-1 hover:bg-slate-50" data-testid={testid}><Copy size={12} /> Copy</button>;
}

function Merged({ text, ctx }) {
  const parts = renderTpl(text, ctx).split(/(\{[a-z_]+\})/g);
  return <>{parts.map((p, i) => /^\{[a-z_]+\}$/.test(p) ? <span key={i} className="font-mono text-[12px] text-indigo-700 bg-indigo-50 px-1 rounded">{p}</span> : <span key={i}>{p}</span>)}</>;
}

export function ToolkitTab({ toolkit }) {
  const [sec, setSec] = useState("pitch");
  const [stage, setStage] = useState("first_touch");
  const [openObj, setOpenObj] = useState(0);
  const [qr, setQr] = useState(null);
  if (!toolkit) return <div className="text-sm text-slate-400 p-6">Loading…</div>;
  const tk = toolkit.toolkit; const ctx = toolkit.ctx;
  const links = [["Business owner", toolkit.links.my_link_owner, "owner"], ["Accountant / firm", toolkit.links.my_link_pro, "pro"], ["Enterprise / multi-entity", toolkit.links.my_link_enterprise, "enterprise"]];

  return (
    <div className="grid md:grid-cols-[200px_1fr] gap-5" data-testid="toolkit-tab">
      <nav className="flex md:flex-col gap-1 overflow-x-auto">
        {SECTIONS.map(([k, l]) => <button key={k} onClick={() => setSec(k)} className={"text-left px-3 py-2 rounded-lg text-xs md:text-sm font-medium whitespace-nowrap " + (sec === k ? "bg-white border border-slate-200 font-bold text-slate-900" : "text-slate-600 hover:bg-slate-100")} data-testid={`toolkit-nav-${k}`}>{l}</button>)}
      </nav>
      <div className="min-w-0">
        {sec === "pitch" && (
          <div className="space-y-3" data-testid="toolkit-pitches">
            <p className="text-sm text-slate-500">Say it out loud twice. Then stop reading and just talk.</p>
            {tk.pitches.map(p => (
              <div key={p.id} className="rounded-2xl bg-slate-900 text-slate-200 p-5 text-sm leading-relaxed relative">
                <div className="text-[10px] tracking-[.12em] uppercase font-bold text-indigo-300 mb-2">{p.title}</div>
                <div className="pr-20">“{p.body}”</div>
                <div className="absolute top-4 right-4"><CopyBtn text={p.body} testid={`toolkit-copy-${p.id}`} /></div>
              </div>
            ))}
          </div>
        )}
        {sec === "who" && (
          <div className="grid sm:grid-cols-2 gap-3" data-testid="toolkit-who">
            {tk.who_first.map((w, i) => (
              <div key={i} className="bg-white border border-slate-200 rounded-2xl p-4"><div className="font-semibold text-sm">{i + 1} · {w.title}</div><p className="text-xs text-slate-500 mt-1 leading-relaxed">{w.body}</p></div>
            ))}
          </div>
        )}
        {sec === "templates" && (
          <div data-testid="toolkit-templates">
            <div className="flex flex-wrap gap-2 mb-3">
              {STAGES.map(([k, l]) => <button key={k} onClick={() => setStage(k)} className={"h-7 px-3 rounded-full text-xs font-semibold border " + (stage === k ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-200 text-slate-600")} data-testid={`toolkit-stage-${k}`}>{l}</button>)}
            </div>
            <div className="grid lg:grid-cols-2 gap-3">
              {tk.templates.filter(t => t.stage === stage).map(t => (
                <div key={t.id} className="bg-white border border-slate-200 rounded-2xl p-4 text-sm leading-relaxed relative" data-testid={`toolkit-template-${t.id}`}>
                  <div className="text-[11px] text-slate-500 mb-1.5 pr-20">{t.title}</div>
                  {t.subject && <div className="font-semibold mb-1">Subject: <Merged text={t.subject} ctx={ctx} /></div>}
                  <div className="whitespace-pre-wrap"><Merged text={t.body} ctx={ctx} /></div>
                  <div className="absolute top-3 right-3"><CopyBtn text={(t.subject ? `Subject: ${renderTpl(t.subject, ctx)}\n\n` : "") + renderTpl(t.body, ctx)} testid={`toolkit-copy-${t.id}`} /></div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-500 mt-3">Highlighted fields like <span className="font-mono text-indigo-700 bg-indigo-50 px-1 rounded">{"{first_name}"}</span> are filled automatically when you send from Today or Pipeline.</p>
          </div>
        )}
        {sec === "objections" && (
          <div data-testid="toolkit-objections">
            {tk.objections.map((o, i) => (
              <div key={i} className="bg-white border border-slate-200 rounded-xl mb-2 overflow-hidden">
                <button onClick={() => setOpenObj(openObj === i ? -1 : i)} className="w-full text-left px-4 py-3 font-semibold text-sm flex justify-between items-center gap-3" data-testid={`toolkit-objection-${i}`}>{o.q}<ChevronDown size={14} className={"shrink-0 transition-transform " + (openObj === i ? "rotate-180" : "")} /></button>
                {openObj === i && <div className="px-4 pb-4 text-sm text-slate-700 leading-relaxed border-t border-slate-100 pt-3 flex gap-3 items-start"><span className="flex-1">{o.a}</span><CopyBtn text={o.a} testid={`toolkit-copy-objection-${i}`} /></div>}
              </div>
            ))}
          </div>
        )}
        {sec === "social" && (
          <div className="grid lg:grid-cols-2 gap-3" data-testid="toolkit-social">
            {tk.social.map((s, i) => (
              <div key={i} className="bg-white border border-slate-200 rounded-2xl p-4 text-sm leading-relaxed relative"><div className="text-[11px] text-slate-500 mb-1.5">{s.title}</div><div className="whitespace-pre-wrap pr-16"><Merged text={s.body} ctx={ctx} /></div><div className="absolute top-3 right-3"><CopyBtn text={renderTpl(s.body, ctx)} testid={`toolkit-copy-social-${i}`} /></div></div>
            ))}
          </div>
        )}
        {sec === "links" && (
          <div className="space-y-2" data-testid="toolkit-links">
            {links.map(([l, u, k]) => (
              <div key={k} className="bg-white border border-slate-200 rounded-xl px-3 py-2.5 flex items-center gap-2 text-xs">
                <span className="font-semibold w-36 shrink-0">{l}</span><span className="font-mono text-slate-500 truncate flex-1">{u}</span>
                <CopyBtn text={u} testid={`toolkit-link-copy-${k}`} />
                <button onClick={() => setQr(qr === k ? null : k)} className="h-8 px-3 rounded-full border border-slate-300 bg-white text-xs font-semibold flex items-center gap-1" data-testid={`toolkit-link-qr-${k}`}><QrCode size={12} /> QR</button>
              </div>
            ))}
            {qr && <div className="bg-white border border-slate-200 rounded-2xl p-5 inline-block" data-testid="toolkit-qr"><QRCodeSVG value={links.find(x => x[2] === qr)[1]} size={160} /></div>}
            <p className="text-[11px] text-slate-500">All three attribute to you. Add <span className="font-mono">&amp;src=linkedin</span> (any tag) to see which channel converts.</p>
          </div>
        )}
      </div>
    </div>
  );
}
