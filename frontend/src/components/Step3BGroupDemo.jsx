// Step3BGroupDemo — scripted mini-demo shown from Step3BTour. Walks
// through a fake batch of 3 "AMZN Mktp US" rows grouped by description
// signature (no contact) and demonstrates bulk-approving them as
// Software Subscriptions. Pure UI (no DB writes).

import { useEffect, useRef, useState } from "react";
import { Sparkles, Check, X, Volume2, VolumeX, Package } from "lucide-react";

const FAKE_ROWS = [
  { id: "r1", date: "May 12, 2026", amount: 29.99, desc: "AMZN Mktp US*A7Y3X" },
  { id: "r2", date: "May 05, 2026", amount: 29.99, desc: "AMZN Mktp US*BK92L" },
  { id: "r3", date: "Apr 28, 2026", amount: 29.99, desc: "AMZN Mktp US*C4M0P" },
];

function stripMd(s) { return (s || "").replace(/[*_`~#>]/g, ""); }
function speakAsync(text, minMs = 3200) {
  return new Promise(resolve => {
    const start = Date.now();
    const finish = () => setTimeout(resolve, Math.max(0, minMs - (Date.now() - start)));
    let muted = false;
    try { muted = localStorage.getItem("axiom_tts") === "0"; } catch {}
    if (typeof window === "undefined" || !window.speechSynthesis || muted) return finish();
    const clean = stripMd(text); if (!clean) return finish();
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.02; u.pitch = 1.0;
    const voices = window.speechSynthesis.getVoices() || [];
    const pref = (() => { try { return localStorage.getItem("axiom_tts_voice") || "Google UK English Female"; } catch { return "Google UK English Female"; } })();
    const pick = voices.find(v => v.name === pref) || voices.find(v => v.lang === "en-GB" && /female/i.test(v.name)) || voices.find(v => v.lang === "en-GB") || voices.find(v => v.lang?.startsWith("en") && /female/i.test(v.name)) || null;
    if (pick) { u.voice = pick; u.lang = pick.lang || "en-GB"; }
    u.onend = finish; u.onerror = finish;
    try { window.speechSynthesis.cancel(); } catch {}
    try { window.speechSynthesis.speak(u); } catch {}
  });
}

export default function Step3BGroupDemo({ open, onDone }) {
  const [phase, setPhase] = useState("intro"); // intro → grouped → selecting → applying → done
  const [caption, setCaption] = useState("");
  const [rows, setRows] = useState(FAKE_ROWS.map(r => ({ ...r, category: null })));
  const [pickedCategory, setPickedCategory] = useState(null);
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem("axiom_tts") === "0"; } catch { return false; } });
  const abortRef = useRef(false);

  const toggleMute = () => {
    setMuted(m => {
      const nm = !m;
      try { localStorage.setItem("axiom_tts", nm ? "0" : "1"); } catch {}
      window.dispatchEvent(new CustomEvent("axiom-tts-changed", { detail: { on: !nm } }));
      if (nm && "speechSynthesis" in window) { try { window.speechSynthesis.cancel(); } catch {} }
      return nm;
    });
  };

  useEffect(() => {
    if (!open) return;
    abortRef.current = false;
    setPhase("intro"); setCaption(""); setPickedCategory(null);
    setRows(FAKE_ROWS.map(r => ({ ...r, category: null })));
    (async () => {
      setCaption("Here's a group I found — three Amazon charges with different reference codes but the same signature. I clustered them so you can categorize the whole batch in one click.");
      await speakAsync("Here's a group I found. Three Amazon charges with different reference codes but the same signature. I clustered them so you can categorize the whole batch in one click.", 6600);
      if (abortRef.current) return;

      setPhase("grouped");
      setCaption("Three rows, $29.99 each — $89.97 total.");
      await speakAsync("Three rows, twenty-nine ninety-nine each. Eighty-nine ninety-seven total.", 3200);
      if (abortRef.current) return;

      setPhase("selecting");
      setCaption("Pick a category from the dropdown — I'll suggest 'Software Subscriptions' based on the amount and vendor pattern.");
      await speakAsync("Pick a category from the dropdown. I'll suggest Software Subscriptions based on the amount and vendor pattern.", 4400);
      if (abortRef.current) return;
      await new Promise(r => setTimeout(r, 400));
      setPickedCategory("6420 · Software Subscriptions");
      if (abortRef.current) return;

      setPhase("applying");
      setCaption("Hit Approve — every row gets stamped at once.");
      await speakAsync("Hit Approve. Every row gets stamped at once.", 2800);
      if (abortRef.current) return;

      // Apply category to each row with a small stagger
      for (const r of FAKE_ROWS) {
        if (abortRef.current) return;
        await new Promise(res => setTimeout(res, 450));
        setRows(prev => prev.map(row => row.id === r.id ? { ...row, category: "6420 · Software Subscriptions" } : row));
      }
      if (abortRef.current) return;
      await new Promise(r => setTimeout(r, 700));

      setPhase("done");
      setCaption("Done — three rows categorized in one shot. That's Step 3B in a nutshell. Rip through the rest of your groups and you're officially finished with the setup checklist.");
      await speakAsync("Done. Three rows categorized in one shot. That's Step 3B in a nutshell. Rip through the rest of your groups and you're officially finished with the setup checklist.", 6800);
      if (abortRef.current) return;

      onDone && onDone();
    })();
    return () => {
      abortRef.current = true;
      try { window.speechSynthesis?.cancel(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const fmt = (n) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

  return (
    <div className="fixed inset-0 z-[1000] bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4" data-testid="step3b-group-demo" onClick={(e) => { if (e.target === e.currentTarget) { abortRef.current = true; onDone && onDone(); } }}>
      <div className="w-full max-w-4xl bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 bg-slate-900 text-white">
          <div className="flex items-center gap-2 text-sm">
            <Sparkles size={15} className="text-cyan-300" />
            <span className="font-semibold">Group demo</span>
            <span className="text-xs text-slate-400 ml-2">Fake data — nothing was saved</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={toggleMute} className={`p-1.5 rounded ${muted ? "text-slate-400" : "text-cyan-300"}`}>
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            <button onClick={() => { abortRef.current = true; onDone && onDone(); }} className="p-1.5 rounded text-slate-300 hover:text-white" data-testid="step3b-group-demo-close">
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_320px]">
          <div className="p-5">
            <div className="mb-3 flex items-baseline justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">Group 1 of 1 · No contact</div>
                <div className="text-2xl font-heading font-bold text-slate-900 flex items-center gap-2" data-testid="step3b-demo-group">
                  <Package size={20} className="text-slate-500" /> AMZN Mktp US*
                </div>
              </div>
              <div className="text-xs text-slate-500 text-right">
                3 rows · <span className="font-semibold text-slate-800">{fmt(total)}</span>
              </div>
            </div>
            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Bulk-categorize all 3 rows</div>
              <div className={`px-3 py-2 rounded-md border text-sm ${pickedCategory ? "bg-cyan-50 border-cyan-300 text-cyan-900" : "bg-slate-50 border-slate-300 text-slate-500"}`} data-testid="step3b-demo-category-picker">
                {pickedCategory || "— pick a category —"}
              </div>
            </div>
            <div className="border rounded-lg overflow-hidden" data-testid="step3b-demo-rows">
              <div className="grid grid-cols-[100px_1fr_auto] gap-3 px-3 py-2 bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
                <div>Date</div>
                <div>Description / Category</div>
                <div className="text-right">Amount</div>
              </div>
              {rows.map((r, idx) => {
                const hasCat = !!r.category;
                return (
                  <div
                    key={r.id}
                    className={`grid grid-cols-[100px_1fr_auto] gap-3 px-3 py-2 text-sm items-center border-t transition-colors ${hasCat ? "bg-emerald-50" : ""}`}
                    data-testid={`step3b-demo-row-${idx}`}
                  >
                    <div className="text-slate-500 text-xs">{r.date}</div>
                    <div>
                      <div className="text-slate-700 text-xs font-mono truncate">{r.desc}</div>
                      {hasCat && (
                        <span className="inline-flex items-center gap-1.5 mt-1 text-xs font-medium px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
                          <Check size={11} /> {r.category}
                        </span>
                      )}
                    </div>
                    <div className="text-right font-mono text-sm text-slate-800">{fmt(r.amount)}</div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="border-l bg-slate-50 p-5 flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${phase === "applying" ? "bg-cyan-500 text-white animate-pulse" : phase === "done" ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-600"}`}>
                {phase === "done" ? <Check size={18} /> : <Sparkles size={16} />}
              </div>
              <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
                {phase === "intro" ? "Group found" : phase === "grouped" ? "Details" : phase === "selecting" ? "Pick category" : phase === "applying" ? "Applying…" : "Done"}
              </div>
            </div>
            <div className="mt-auto rounded-lg bg-slate-900 text-white p-3 text-sm leading-snug">
              <div className="text-[10px] uppercase tracking-widest text-cyan-300 font-semibold mb-1">Assistant</div>
              {caption}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
