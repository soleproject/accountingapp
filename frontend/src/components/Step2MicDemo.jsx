// Step2MicDemo — a scripted mini-demo that fires from the Step 2 tour at
// the "mic" step. Shows a fake "John Smith" contact with 5 fake rows,
// simulates the client tapping the mic and dictating the split, and
// animates the AI categorizing every row (4 × Consulting Income and
// 1 × Loan from Owner). Pure UI — no DB writes, no real API calls.
//
// The demo is timing-driven: each phase advances after `speakAsync`
// resolves (which enforces a minimum duration even when muted). When
// the demo ends, we invoke `onDone` and the parent Step 2 tour
// continues to its next narration step.

import { useEffect, useRef, useState } from "react";
import { Mic, Sparkles, Check, X, Volume2, VolumeX } from "lucide-react";

const FAKE_ROWS = [
  { id: "r1", date: "May 12, 2026", amount: 5000, category: null },
  { id: "r2", date: "May 08, 2026", amount: 5000, category: null },
  { id: "r3", date: "May 01, 2026", amount: 5000, category: null },
  { id: "r4", date: "Apr 24, 2026", amount: 5000, category: null },
  { id: "r5", date: "Apr 15, 2026", amount: 25000, category: null },
];

const DICTATION_SCRIPT = "This is John Smith. He's a consulting client — the four $5,000 deposits are consulting income, and the $25,000 deposit is a loan to the company.";

function stripMd(s) { return (s || "").replace(/[*_`~#>]/g, ""); }

function speakAsync(text, minMs = 3200) {
  return new Promise(resolve => {
    const start = Date.now();
    const finish = () => setTimeout(resolve, Math.max(0, minMs - (Date.now() - start)));
    let muted = false;
    try { muted = localStorage.getItem("axiom_tts") === "0"; } catch { /* ignore */ }
    if (typeof window === "undefined" || !window.speechSynthesis || muted) return finish();
    const clean = stripMd(text);
    if (!clean) return finish();
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.02; u.pitch = 1.0;
    const voices = window.speechSynthesis.getVoices() || [];
    const pref = (() => { try { return localStorage.getItem("axiom_tts_voice") || "Google UK English Female"; } catch { return "Google UK English Female"; } })();
    const pick =
      voices.find(v => v.name === pref) ||
      voices.find(v => v.name.toLowerCase().includes(pref.toLowerCase())) ||
      voices.find(v => v.lang === "en-GB" && /female/i.test(v.name)) ||
      voices.find(v => v.lang === "en-GB") ||
      voices.find(v => v.lang?.startsWith("en") && /female/i.test(v.name)) ||
      null;
    if (pick) { u.voice = pick; u.lang = pick.lang || "en-GB"; }
    u.onend = finish; u.onerror = finish;
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    try { window.speechSynthesis.speak(u); } catch { /* ignore */ }
  });
}

// A tiny "voice waveform" — 8 vertical bars that scale rhythmically
// while `active` is true. Pure CSS animation; no audio API needed.
function Waveform({ active }) {
  const bars = [0, 1, 2, 3, 4, 5, 6, 7];
  return (
    <div className="flex items-end gap-[3px] h-6" aria-hidden>
      {bars.map(i => (
        <span
          key={i}
          className={`inline-block w-[3px] rounded-full ${active ? "bg-red-500" : "bg-slate-400"}`}
          style={{
            height: active ? "60%" : "20%",
            animation: active ? `mic-bar 0.9s ease-in-out ${i * 0.09}s infinite alternate` : "none",
          }}
        />
      ))}
      <style>{`@keyframes mic-bar { from { height: 15%; } to { height: 95%; } }`}</style>
    </div>
  );
}

export default function Step2MicDemo({ open, onDone }) {
  const [phase, setPhase] = useState("intro"); // intro → listening → transcribed → thinking → categorizing → done
  const [rows, setRows] = useState(FAKE_ROWS);
  const [typed, setTyped] = useState("");
  const [aiCaption, setAiCaption] = useState("");
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem("axiom_tts") === "0"; } catch { return false; } });
  const abortRef = useRef(false);

  const toggleMute = () => {
    setMuted(m => {
      const nm = !m;
      try { localStorage.setItem("axiom_tts", nm ? "0" : "1"); } catch { /* ignore */ }
      window.dispatchEvent(new CustomEvent("axiom-tts-changed", { detail: { on: !nm } }));
      if (nm && "speechSynthesis" in window) { try { window.speechSynthesis.cancel(); } catch {} }
      return nm;
    });
  };

  useEffect(() => {
    if (!open) return;
    abortRef.current = false;
    setPhase("intro");
    setRows(FAKE_ROWS);
    setTyped("");
    setAiCaption("");

    (async () => {
      // 1. Intro
      setAiCaption("Here's what happens when you tap the mic — I'll show you on a fake contact called John Smith.");
      await speakAsync(setAiCaptionThenReturn("Here's what happens when you tap the mic — I'll show you on a fake contact called John Smith."), 4200);
      if (abortRef.current) return;

      // 2. Listening
      setPhase("listening");
      setAiCaption("Tap. And now I'm listening…");
      await speakAsync("Tap, and now I'm listening.", 2600);
      if (abortRef.current) return;

      // 3. Transcribe (typewriter) — muted, so we DON'T re-speak this;
      //    it's meant to look like the CLIENT talking.
      setPhase("transcribed");
      setAiCaption("You say:");
      const typewriterDur = DICTATION_SCRIPT.length * 40;
      let idx = 0;
      await new Promise(r => {
        const iv = setInterval(() => {
          idx += 1;
          setTyped(DICTATION_SCRIPT.slice(0, idx));
          if (idx >= DICTATION_SCRIPT.length) { clearInterval(iv); r(); }
          if (abortRef.current) { clearInterval(iv); r(); }
        }, 40);
      });
      if (abortRef.current) return;
      await new Promise(r => setTimeout(r, 800));
      if (abortRef.current) return;

      // 4. AI thinking beat
      setPhase("thinking");
      setAiCaption("Got it — let me pattern-match those against your chart of accounts.");
      await speakAsync("Got it. Let me pattern-match those against your chart of accounts.", 3400);
      if (abortRef.current) return;

      // 5. Categorize each row row-by-row
      setPhase("categorizing");
      setAiCaption("Applying categories…");
      const CATS = [
        { id: "r1", cat: "4000 · Consulting Income", kind: "income" },
        { id: "r2", cat: "4000 · Consulting Income", kind: "income" },
        { id: "r3", cat: "4000 · Consulting Income", kind: "income" },
        { id: "r4", cat: "4000 · Consulting Income", kind: "income" },
        { id: "r5", cat: "2100 · Loan from Owner", kind: "liability" },
      ];
      for (const c of CATS) {
        if (abortRef.current) return;
        await new Promise(r => setTimeout(r, 550));
        setRows(prev => prev.map(row => row.id === c.id ? { ...row, category: c.cat, kind: c.kind } : row));
      }
      if (abortRef.current) return;
      await new Promise(r => setTimeout(r, 700));

      // 6. Done
      setPhase("done");
      setAiCaption("Done — five rows categorized in one shot. Four as consulting income, one as a loan from the owner. That's the whole idea.");
      await speakAsync("Done. Five rows categorized in one shot. Four as consulting income, one as a loan from the owner. That's the whole idea.", 5400);
      if (abortRef.current) return;

      onDone && onDone();
    })();

    return () => {
      abortRef.current = true;
      try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Trivial identity helper so the `setAiCaption` above reads cleanly
  // while still returning the string for `speakAsync`.
  function setAiCaptionThenReturn(t) { return t; }

  if (!open) return null;

  const total = rows.reduce((s, r) => s + r.amount, 0);
  const fmt = (n) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

  return (
    <div
      className="fixed inset-0 z-[1000] bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4"
      data-testid="step2-mic-demo"
      onClick={(e) => { if (e.target === e.currentTarget) { abortRef.current = true; onDone && onDone(); } }}
    >
      <div className="w-full max-w-4xl bg-white rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 bg-slate-900 text-white">
          <div className="flex items-center gap-2 text-sm">
            <Sparkles size={15} className="text-cyan-300" />
            <span className="font-semibold">Voice demo</span>
            <span className="text-xs text-slate-400 ml-2">Fake data — nothing was saved</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={toggleMute} className={`p-1.5 rounded ${muted ? "text-slate-400" : "text-cyan-300"}`} title={muted ? "Narration off" : "Narration on"}>
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            <button onClick={() => { abortRef.current = true; onDone && onDone(); }} className="p-1.5 rounded text-slate-300 hover:text-white" data-testid="step2-mic-demo-close">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="grid grid-cols-1 md:grid-cols-[1fr_320px]">
          {/* Left: rows table */}
          <div className="p-5">
            <div className="mb-3 flex items-baseline justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">Contact 1 of 1</div>
                <div className="text-2xl font-heading font-bold text-slate-900" data-testid="step2-mic-demo-contact">John Smith</div>
              </div>
              <div className="text-xs text-slate-500 text-right">
                5 transactions · <span className="font-semibold text-slate-800">{fmt(total)}</span>
              </div>
            </div>
            <div className="border rounded-lg overflow-hidden" data-testid="step2-mic-demo-rows">
              <div className="grid grid-cols-[100px_1fr_auto] gap-3 px-3 py-2 bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
                <div>Date</div>
                <div>Category</div>
                <div className="text-right">Amount</div>
              </div>
              {rows.map((r, idx) => {
                const hasCat = !!r.category;
                const isLoan = r.kind === "liability";
                return (
                  <div
                    key={r.id}
                    className={`grid grid-cols-[100px_1fr_auto] gap-3 px-3 py-2 text-sm items-center border-t ${hasCat ? (isLoan ? "bg-indigo-50" : "bg-emerald-50") : ""}`}
                    style={{
                      transition: "background-color 0.35s ease-out",
                    }}
                    data-testid={`step2-mic-demo-row-${idx}`}
                  >
                    <div className="text-slate-500 text-xs">{r.date}</div>
                    <div>
                      {hasCat ? (
                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded ${isLoan ? "bg-indigo-100 text-indigo-800" : "bg-emerald-100 text-emerald-800"}`}>
                          <Check size={12} /> {r.category}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400 italic">— pick a category —</span>
                      )}
                    </div>
                    <div className={`text-right font-mono text-sm ${isLoan ? "text-indigo-700 font-semibold" : "text-slate-800"}`}>
                      {fmt(r.amount)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: mic panel */}
          <div className="border-l bg-slate-50 p-5 flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${phase === "listening" ? "bg-red-500 text-white animate-pulse" : "bg-slate-200 text-slate-600"}`}>
                <Mic size={16} />
              </div>
              <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
                {phase === "listening" ? "Listening…" : phase === "thinking" ? "Thinking…" : phase === "categorizing" ? "Applying…" : phase === "done" ? "Done" : "Assistant"}
              </div>
            </div>
            <div className="mb-4"><Waveform active={phase === "listening"} /></div>
            {phase === "transcribed" || phase === "thinking" || phase === "categorizing" || phase === "done" ? (
              <div className="mb-4 rounded-lg bg-white border border-slate-200 p-3">
                <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-1">You said</div>
                <p className="text-sm text-slate-700 leading-snug">
                  "{typed}"
                  {phase === "transcribed" && (
                    <span className="inline-block w-[1px] h-[12px] bg-slate-700 align-middle animate-pulse ml-[1px]" />
                  )}
                </p>
              </div>
            ) : null}
            <div className="mt-auto rounded-lg bg-slate-900 text-white p-3 text-sm leading-snug">
              <div className="text-[10px] uppercase tracking-widest text-cyan-300 font-semibold mb-1">Assistant</div>
              {aiCaption}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
