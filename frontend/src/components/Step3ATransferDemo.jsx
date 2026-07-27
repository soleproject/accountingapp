// Step3ATransferDemo — scripted mini-demo shown from Step3ATour. Walks
// through a fake $1,000 Chase → Wells intercompany transfer pair,
// animates the confidence badge, then simulates approving it and shows
// both legs getting booked. Pure UI (no DB writes).

import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, Check, X, Sparkles, Volume2, VolumeX } from "lucide-react";

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

export default function Step3ATransferDemo({ open, onDone }) {
  const [phase, setPhase] = useState("intro"); // intro → scanning → matched → approving → booked
  const [caption, setCaption] = useState("");
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
    setPhase("intro"); setCaption("");
    (async () => {
      setCaption("Say you moved $1,000 from your Chase business checking to your Wells savings on the same day.");
      await speakAsync("Say you moved $1,000 from your Chase business checking to your Wells savings on the same day.", 4400);
      if (abortRef.current) return;

      setPhase("scanning");
      setCaption("I scan your unreviewed transactions and spot both legs — a debit and a credit for the same amount, opposite signs, different bank accounts.");
      await speakAsync("I scan your unreviewed transactions and spot both legs. A debit and a credit for the same amount, opposite signs, different bank accounts.", 5200);
      if (abortRef.current) return;

      setPhase("matched");
      setCaption("Same day, exact amount match — that's 100% confidence. Green badge, safe to bulk-approve.");
      await speakAsync("Same day, exact amount match. That's one hundred percent confidence. Green badge, safe to bulk-approve.", 4800);
      if (abortRef.current) return;

      setPhase("approving");
      setCaption("Click Approve and both legs get booked as a Bank Transfer on the balance sheet — no P&L impact.");
      await speakAsync("Click Approve and both legs get booked as a Bank Transfer on the balance sheet. No P and L impact.", 4600);
      if (abortRef.current) return;

      setPhase("booked");
      setCaption("Done. Two rows resolved with one click — that's the pattern for every intercompany transfer in your queue.");
      await speakAsync("Done. Two rows resolved with one click. That's the pattern for every intercompany transfer in your queue.", 4400);
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

  const scanning = phase === "scanning";
  const revealed = ["matched", "approving", "booked"].includes(phase);
  const approving = phase === "approving";
  const booked = phase === "booked";

  return (
    <div className="fixed inset-0 z-[1000] bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4" data-testid="step3a-transfer-demo" onClick={(e) => { if (e.target === e.currentTarget) { abortRef.current = true; onDone && onDone(); } }}>
      <div className="w-full max-w-3xl bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 bg-slate-900 text-white">
          <div className="flex items-center gap-2 text-sm">
            <Sparkles size={15} className="text-cyan-300" />
            <span className="font-semibold">Transfer demo</span>
            <span className="text-xs text-slate-400 ml-2">Fake data — nothing was saved</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={toggleMute} className={`p-1.5 rounded ${muted ? "text-slate-400" : "text-cyan-300"}`}>
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            <button onClick={() => { abortRef.current = true; onDone && onDone(); }} className="p-1.5 rounded text-slate-300 hover:text-white" data-testid="step3a-transfer-demo-close">
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="p-6">
          {scanning && (
            <div className="text-center py-10">
              <div className="inline-block px-4 py-2 rounded-full bg-cyan-50 border border-cyan-200 text-cyan-800 text-sm font-medium">
                <Sparkles className="inline mr-1.5" size={14} /> Scanning for matching pairs…
              </div>
            </div>
          )}
          {(revealed || phase === "intro") && !scanning ? (
            <div className={`rounded-xl border-2 p-5 transition-all ${revealed ? "border-cyan-400 ring-2 ring-cyan-100 shadow-lg" : "border-slate-200"} ${booked ? "opacity-70" : ""}`} data-testid="step3a-demo-pair">
              <div className="flex items-baseline justify-between mb-4">
                <div className="flex items-center gap-2">
                  <ArrowLeftRight className="text-cyan-600" size={18} />
                  <div className="font-heading font-semibold text-lg">Intercompany transfer</div>
                </div>
                {revealed && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold bg-emerald-100 text-emerald-800 border-emerald-300">
                    100% · ±0d
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="rounded-md bg-rose-50 border border-rose-200 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-rose-700 font-semibold mb-1">Debit (source)</div>
                  <div className="text-sm font-semibold text-slate-900">Chase Business Checking</div>
                  <div className="text-xs text-slate-500 mt-0.5">Apr 15, 2026</div>
                  <div className="text-lg font-bold text-rose-700 mt-1 font-mono">-$1,000.00</div>
                </div>
                <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-emerald-700 font-semibold mb-1">Credit (destination)</div>
                  <div className="text-sm font-semibold text-slate-900">Wells Fargo Savings</div>
                  <div className="text-xs text-slate-500 mt-0.5">Apr 15, 2026</div>
                  <div className="text-lg font-bold text-emerald-700 mt-1 font-mono">+$1,000.00</div>
                </div>
              </div>
              {revealed && (
                <div className={`flex items-center justify-between rounded-md px-3 py-2 text-sm ${booked ? "bg-emerald-100 text-emerald-800" : approving ? "bg-cyan-100 text-cyan-800 animate-pulse" : "bg-slate-100 text-slate-700"}`}>
                  <span className="inline-flex items-center gap-1.5">
                    {booked ? <Check size={14} /> : <ArrowLeftRight size={14} />}
                    <span className="font-medium">
                      {booked ? "Booked as Bank Transfer" : approving ? "Booking both legs…" : "Ready to book as Bank Transfer"}
                    </span>
                  </span>
                  <span className="text-xs opacity-75">No P&L impact</span>
                </div>
              )}
            </div>
          ) : null}
          <div className="mt-5 rounded-lg bg-slate-900 text-white p-3 text-sm leading-snug" data-testid="step3a-demo-caption">
            <div className="text-[10px] uppercase tracking-widest text-cyan-300 font-semibold mb-1">Assistant</div>
            {caption}
          </div>
        </div>
      </div>
    </div>
  );
}
