import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Send, Sparkles, X, MessageSquare, Mic, MicOff, Volume2, VolumeX, ChevronDown } from "lucide-react";
import { api, BACKEND_URL } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { useAiFocus } from "@/lib/aiFocus";
import { toast } from "sonner";
import { resolveVoiceCommand } from "@/lib/voiceCommands";

const getSR = () => window.SpeechRecognition || window.webkitSpeechRecognition;

export default function AiPanel({ collapsed, onToggle }) {
  const { currentId, current, companies, switchCompany } = useCompany();
  const navigate = useNavigate();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [listening, setListening] = useState(false);
  // Mic mode: "off" | "ptt" (push-to-talk, hold to speak) | "open" (open-mic
  // with silence auto-submit + TTS echo protection). Persisted so a user's
  // preferred conversation mode survives reloads.
  const [micMode, setMicMode] = useState(() => localStorage.getItem("axiom_mic_mode") || "off");
  useEffect(() => { localStorage.setItem("axiom_mic_mode", micMode); }, [micMode]);
  const micModeRef = useRef(micMode);
  useEffect(() => { micModeRef.current = micMode; }, [micMode]);
  const [interim, setInterim] = useState("");
  const [voiceOn, setVoiceOn] = useState(() => localStorage.getItem("axiom_tts") === "1");
  const [voiceName, setVoiceName] = useState(() => localStorage.getItem("axiom_tts_voice") || "Google UK English Female");
  const [voices, setVoices] = useState([]);
  const [voiceMenuOpen, setVoiceMenuOpen] = useState(false);
  const [voiceRate, setVoiceRate] = useState(() => {
    const v = parseFloat(localStorage.getItem("axiom_tts_rate") || "1.05");
    return isFinite(v) ? v : 1.05;
  });
  const [terseness, setTerseness] = useState(() =>
    localStorage.getItem("axiom_terseness") || "balanced"
  );
  useEffect(() => { localStorage.setItem("axiom_terseness", terseness); }, [terseness]);
  const recognitionRef = useRef(null);
  const scrollRef = useRef(null);
  // TTS pointers: how much of the current assistant reply we've already
  // queued to the browser's speechSynthesis. Kept in a ref so streaming
  // delta callbacks don't cause React re-renders on every chunk.
  const spokenIdxRef = useRef(0);
  const voiceOnRef = useRef(voiceOn);
  const voiceNameRef = useRef(voiceName);
  const voiceRateRef = useRef(voiceRate);
  useEffect(() => {
    voiceOnRef.current = voiceOn;
    localStorage.setItem("axiom_tts", voiceOn ? "1" : "0");
    if (!voiceOn && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }, [voiceOn]);
  useEffect(() => {
    voiceNameRef.current = voiceName;
    localStorage.setItem("axiom_tts_voice", voiceName || "");
  }, [voiceName]);
  useEffect(() => {
    voiceRateRef.current = voiceRate;
    localStorage.setItem("axiom_tts_rate", String(voiceRate));
  }, [voiceRate]);
  // Populate voices — Chrome loads them asynchronously so we subscribe to
  // the `voiceschanged` event as well as reading once on mount.
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const load = () => {
      const v = window.speechSynthesis.getVoices() || [];
      setVoices(v);
      // Auto-select the best default if the current pick isn't available:
      // 1) Google UK English Female  2) any en-GB female  3) any en-* voice
      //    4) whatever the OS gives us first.
      if (v.length && !v.find(x => x.name === voiceNameRef.current)) {
        const pick =
          v.find(x => /google uk english female/i.test(x.name))
          || v.find(x => /en-gb/i.test(x.lang) && /female/i.test(x.name))
          || v.find(x => /^en(-|$)/i.test(x.lang))
          || v[0];
        if (pick) setVoiceName(pick.name);
      }
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  const { focus } = useAiFocus();

  // ------------------------- Open-mic + TTS-echo protection -------------------------
  // Rules (see architecture doc in PR):
  //   1. Recognizer is continuous + self-heals on `onend` while a "listening" flag holds.
  //   2. In "open" mode a silence timer auto-submits after SILENCE_MS of no speech
  //      events, but only when the AI isn't talking (ttsSpeaking gate).
  //   3. Transcripts arriving while TTS is speaking are dropped entirely.
  //   4. A short TAIL_MS grace after TTS ends continues to drop transcripts so
  //      hardware audio tail can't leak into the user's next turn.
  //   5. Barge-in: recognizer's own `onspeechstart` past the tail grace during
  //      TTS is treated as the user cutting in — cancel TTS, drop the flag,
  //      and let subsequent transcripts flow through normally.
  const SILENCE_MS = 1800;
  const TAIL_MS = 300;
  const ERROR_WINDOW_MS = 5000;
  const ERROR_MAX = 3;
  const ttsSpeakingRef = useRef(false);
  const ttsTailUntilRef = useRef(0);
  const silenceTimerRef = useRef(null);
  const lastFinalRef = useRef({ text: "", at: 0 });
  const errorLogRef = useRef([]);      // timestamps of recent recognizer errors
  const inputRef = useRef("");
  const submitInFlightRef = useRef(false);

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  const armSilenceTimer = () => {
    // In "open" mode only — refuses to arm while TTS is talking.
    if (micModeRef.current !== "open") return;
    if (ttsSpeakingRef.current) return;
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => {
      // Re-check TTS state at fire-time — user may have started listening
      // while AI was still speaking.
      if (ttsSpeakingRef.current) return;
      if (Date.now() < ttsTailUntilRef.current) return;
      // Read input via ref (not via setInput callback) so React StrictMode's
      // double-invocation of setter callbacks can't fire send() twice.
      const current = (inputRef.current || "").trim();
      if (!current) return;
      // Idempotency guard: if a submit is already in flight, don't dispatch
      // another one from a re-arm race.
      if (submitInFlightRef.current) return;
      submitInFlightRef.current = true;
      // Defer so React can commit any pending state before send() reads it.
      setTimeout(() => {
        try { sendRef.current && sendRef.current(); }
        finally { submitInFlightRef.current = false; }
      }, 0);
    }, SILENCE_MS);
  };

  // Kept as a ref so the timer callback can call the latest `send`.
  const sendRef = useRef(null);

  const startRecognizer = () => {
    const SR = getSR();
    if (!SR) return null;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (event) => {
      // LAYER 1: while TTS is playing, drop transcripts entirely.
      if (ttsSpeakingRef.current) return;
      // LAYER 2: within the TAIL_MS grace after TTS ends, still drop.
      if (Date.now() < ttsTailUntilRef.current) return;

      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += t;
        else interimText += t;
      }
      if (finalText) {
        // Chrome sometimes fires the same final result twice around onend
        // restarts — dedupe identical strings within 500ms.
        const cleaned = finalText.trim();
        const last = lastFinalRef.current;
        if (cleaned && !(cleaned === last.text && Date.now() - last.at < 500)) {
          setInput(prev => (prev + " " + cleaned).replace(/\s+/g, " ").trim());
          lastFinalRef.current = { text: cleaned, at: Date.now() };
        }
      }
      setInterim(interimText);
      // Any speech event re-arms the silence timer.
      armSilenceTimer();
    };

    rec.onspeechstart = () => {
      // LAYER 3 (barge-in): if the user starts speaking while TTS is playing
      // (past the tail grace so we don't self-trigger from AI's own audio),
      // cancel TTS and open the gate so the incoming transcript is kept.
      if (ttsSpeakingRef.current && Date.now() >= ttsTailUntilRef.current) {
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
        ttsSpeakingRef.current = false;
      }
      armSilenceTimer();
    };

    rec.onerror = (e) => {
      const now = Date.now();
      errorLogRef.current = errorLogRef.current
        .filter(t => now - t < ERROR_WINDOW_MS)
        .concat(now);
      if (errorLogRef.current.length >= ERROR_MAX) {
        toast.error("Mic keeps failing — switched to manual push-to-talk.");
        setMicMode("ptt");
        setListening(false);
      }
    };

    rec.onend = () => {
      // Self-heal: if we're still supposed to be listening (open-mic or a
      // long ptt press), restart. Otherwise clear listening state.
      if (micModeRef.current === "open") {
        try { rec.start(); return; } catch { /* fall through */ }
      }
      setListening(false);
    };

    try {
      rec.start();
      return rec;
    } catch (e) {
      toast.error("Could not start microphone");
      return null;
    }
  };

  // Set up SpeechRecognition once — but the *instance* is (re)created inside
  // startRecognizer so we always get a fresh state machine.
  useEffect(() => {
    return () => {
      const rec = recognitionRef.current;
      if (rec) { try { rec.stop(); } catch {} }
      clearSilenceTimer();
    };
  }, []);

  const startListening = () => {
    if (!getSR()) {
      toast.error("Voice input isn't supported in this browser. Try Chrome/Edge.");
      return;
    }
    setInterim("");
    const rec = startRecognizer();
    if (rec) {
      recognitionRef.current = rec;
      setListening(true);
    }
  };
  const stopListening = () => {
    const rec = recognitionRef.current;
    if (rec) { try { rec.stop(); } catch {} }
    clearSilenceTimer();
    setListening(false);
    setInterim("");
  };

  // Push-to-talk handlers (space bar OR hold on the mic button)
  const pttStart = () => {
    if (micModeRef.current !== "ptt") return;
    if (!listening) startListening();
  };
  const pttEnd = () => {
    if (micModeRef.current !== "ptt") return;
    if (listening) stopListening();
  };

  // Whenever micMode flips, open the mic (open) or close it (off).
  useEffect(() => {
    if (micMode === "open" && !listening) startListening();
    if (micMode === "off"  &&  listening) stopListening();
    // "ptt" mode: don't auto-start — wait for user to press-and-hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micMode]);

  useEffect(() => {
    if (!currentId) return;
    api.get(`/ai/chat/history?company_id=${currentId}`).then(r => {
      const msgs = r.data.messages || [];
      if (msgs.length === 0) {
        setMessages([{
          role: "assistant",
          content: `Hi ${current?.name ? "" : "there"}${current?.name ? "— I'm watching " + current.name : ""}. I categorize transactions, post JEs, and answer any accounting question. Ask me anything.`
        }]);
      } else {
        setMessages(msgs.map(m => ({ role: m.role, content: m.content })));
      }
    }).catch(() => {});
  }, [currentId, current?.name]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // Expose the latest send() to the silence timer via ref.
  useEffect(() => { sendRef.current = send; });
  // Mirror `input` state into a ref so refs-only code paths (silence timer,
  // barge-in handler) can read it without React StrictMode double-invoke.
  useEffect(() => { inputRef.current = input; }, [input]);

  const send = async () => {
    if (!input.trim() || streaming || !currentId) return;
    // In open-mic mode we deliberately keep the recognizer alive across
    // turns so the user never re-taps. In ptt/off modes, stop.
    if (listening && micModeRef.current !== "open") {
      stopListening();
    }
    clearSilenceTimer();
    const userMsg = input.trim();
    setInput("");

    // ------ Voice command dispatch (client-side, zero cost) ------
    // If the user's utterance matches a local intent (route/company switch/
    // meta), execute it immediately and skip the LLM round-trip.
    const cmd = resolveVoiceCommand(userMsg, {
      companies,
      navigate,
      switchCompany,
      clearChat: () => setMessages([]),
    });
    if (cmd.handled) {
      setMessages(m => [
        ...m,
        { role: "user", content: userMsg },
        { role: "assistant", content: cmd.say || "Done." },
      ]);
      if (voiceOnRef.current && cmd.say) speakOne(cmd.say);
      return;
    }

    setMessages(m => [...m, { role: "user", content: userMsg }, { role: "assistant", content: "" }]);
    // Fresh reply → reset TTS pointer and stop any prior speech so we don't
    // read overlapping messages.
    spokenIdxRef.current = 0;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    ttsSpeakingRef.current = false;
    ttsTailUntilRef.current = 0;
    setStreaming(true);
    try {
      const token = localStorage.getItem("axiom_token");
      const resp = await fetch(`${BACKEND_URL}/api/ai/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          company_id: currentId,
          message: userMsg,
          focused_transaction_id: focus?.id || null,
          terseness,
        }),
      });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const p of parts) {
          if (!p.startsWith("data: ")) continue;
          try {
            const j = JSON.parse(p.slice(6));
            if (j.delta) {
              setMessages(m => {
                const copy = [...m];
                const prev = copy[copy.length - 1].content;
                const next = prev + j.delta;
                copy[copy.length - 1] = { role: "assistant", content: next };
                // Feed newly-completed sentences to speechSynthesis
                // immediately — this is what makes the voice "real-time":
                // as soon as Claude finishes a sentence, we speak it while
                // the next sentence is still being generated.
                if (voiceOnRef.current) speakNewSentences(next);
                return copy;
              });
            }
          } catch {}
        }
      }
    } catch (e) {
      setMessages(m => {
        const copy = [...m];
        copy[copy.length - 1] = { role: "assistant", content: "[Error contacting AI]" };
        return copy;
      });
    } finally {
      // Flush any trailing text that didn't end in a sentence terminator.
      if (voiceOnRef.current) {
        setMessages(m => {
          const last = m[m.length - 1];
          if (last && last.role === "assistant") speakRemainder(last.content);
          return m;
        });
      }
      setStreaming(false);
    }
  };

  // Split on sentence terminators (., !, ?, newline, colon) — speak completed
  // sentences and keep the trailing partial buffered until it terminates. This
  // yields the shortest possible time-to-first-word.
  const SENTENCE_END = /([.!?\n:])\s+/;
  const speakOne = (text) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(clean);
    const wanted = voiceNameRef.current;
    if (wanted) {
      const v = (window.speechSynthesis.getVoices() || []).find(x => x.name === wanted);
      if (v) { u.voice = v; u.lang = v.lang; }
    }
    u.rate = Math.max(0.5, Math.min(2.0, voiceRateRef.current || 1.05));
    u.pitch = 1.0;
    u.volume = 1.0;
    u.onstart = () => { ttsSpeakingRef.current = true; };
    const finish = () => {
      // Only clear the flag when the browser queue is genuinely empty —
      // otherwise the NEXT chunked utterance (which fires start slightly
      // after this one's end) would race with a stale-false flag.
      const ss = window.speechSynthesis;
      const idle = !ss.speaking && !ss.pending;
      if (idle) {
        ttsSpeakingRef.current = false;
        ttsTailUntilRef.current = Date.now() + TAIL_MS;
      }
    };
    u.onend = finish;
    u.onerror = finish;
    window.speechSynthesis.speak(u);
  };
  const speakNewSentences = (full) => {
    let start = spokenIdxRef.current;
    if (start >= full.length) return;
    const pending = full.slice(start);
    // Find the last sentence terminator in the pending text — everything up
    // to (and including) that terminator is safe to speak. The remainder is
    // held over for the next delta.
    let match;
    let lastEnd = -1;
    const re = new RegExp(SENTENCE_END.source, "g");
    while ((match = re.exec(pending)) !== null) lastEnd = match.index + match[0].length;
    if (lastEnd <= 0) return;
    const chunk = pending.slice(0, lastEnd);
    speakOne(chunk);
    spokenIdxRef.current = start + lastEnd;
  };
  const speakRemainder = (full) => {
    const rest = (full || "").slice(spokenIdxRef.current);
    if (rest.trim()) {
      speakOne(rest);
      spokenIdxRef.current = full.length;
    }
  };

  if (collapsed) {
    return (
      <div className="w-12 shrink-0 border-l bg-white flex flex-col items-center py-4">
        <button
          data-testid={TID.aiPanelToggle}
          onClick={onToggle}
          className="p-2 rounded-md hover:bg-slate-100 text-slate-600"
          title="Open Assistant"
        >
          <MessageSquare size={18} />
        </button>
      </div>
    );
  }

  return (
    <aside className="w-96 shrink-0 border-l bg-white flex flex-col" data-testid="ai-panel">
      <div className="h-16 shrink-0 border-b px-4 flex items-center gap-2">
        <div className="w-7 h-7 rounded-md bg-gradient-to-br from-indigo-500 to-blue-500 flex items-center justify-center">
          <Sparkles size={14} className="text-white" />
        </div>
        <div>
          <div className="font-heading font-semibold text-sm">Axiom Assistant</div>
          <div className="text-[11px] text-slate-500">Claude Sonnet 4.5 · GAAP-aware</div>
        </div>
        <button
          onClick={() => setVoiceOn(v => !v)}
          data-testid="ai-tts-toggle"
          className={`ml-auto p-1.5 rounded hover:bg-slate-100 ${
            voiceOn ? "text-emerald-600" : "text-slate-400"
          }`}
          title={voiceOn ? "Voice on — click to mute" : "Voice off — click to enable"}
        >
          {voiceOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </button>
        <div className="relative">
          <button
            onClick={() => setVoiceMenuOpen(v => !v)}
            data-testid="ai-tts-voice-menu"
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            title="Voice settings"
          >
            <ChevronDown size={14} />
          </button>
          {voiceMenuOpen && (
            <VoicePicker
              voices={voices}
              voiceOn={voiceOn}
              setVoiceOn={setVoiceOn}
              voiceName={voiceName}
              setVoiceName={setVoiceName}
              voiceRate={voiceRate}
              setVoiceRate={setVoiceRate}
              terseness={terseness}
              setTerseness={setTerseness}
              speakOne={speakOne}
              onClose={() => setVoiceMenuOpen(false)}
            />
          )}
        </div>
        <button
          data-testid={TID.aiPanelToggle}
          onClick={onToggle}
          className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
          title="Collapse"
        >
          <X size={16} />
        </button>
      </div>

      {focus && (
        <div className="mx-3 mt-3 border rounded-md p-2.5 bg-indigo-50/50 border-indigo-200 text-xs">
          <div className="font-medium text-slate-700 mb-0.5">Focused transaction</div>
          <div className="text-slate-600 truncate">
            {focus.merchant} · <span className="font-mono-num">${Math.abs(focus.amount).toFixed(2)}</span> · {focus.date}
          </div>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.map((m, i) => (
          <div key={i} data-testid={TID.aiChatMessage}
               className={`max-w-[92%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed ${
                 m.role === "user" ? "chat-bubble-user ml-auto" : "chat-bubble-ai"
               }`}>
            {m.content || (streaming && i === messages.length - 1 ? "…" : "")}
          </div>
        ))}
      </div>

      <div className="border-t p-3">
        {listening && (
          <div className="mb-2 flex items-center gap-2 rounded-md bg-red-50 border border-red-200 px-2.5 py-1.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 animate-ping" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
            </span>
            <span className="text-xs text-red-700 flex-1">
              {ttsSpeakingRef.current
                ? <>AI speaking — mic muted <span className="opacity-60">(barge in to interrupt)</span></>
                : <>Listening {micMode === "open" ? "· open-mic" : ""} {interim && <span className="italic">"{interim}"</span>}</>
              }
            </span>
          </div>
        )}
        <div className="flex gap-2">
          <MicButton
            mode={micMode}
            listening={listening}
            streaming={streaming}
            ttsSpeaking={ttsSpeakingRef.current}
            onCycle={() => {
              const nextMode = micMode === "off" ? "ptt" : micMode === "ptt" ? "open" : "off";
              setMicMode(nextMode);
            }}
            onPttStart={pttStart}
            onPttEnd={pttEnd}
          />
          <input
            data-testid={TID.aiChatInput}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder={listening ? "Speak now, or type…" : "Ask about a transaction, report, or anything..."}
            className="flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:border-slate-400"
            disabled={streaming}
          />
          <button
            data-testid={TID.aiChatSend}
            onClick={send}
            disabled={streaming || !input.trim()}
            className="w-9 h-9 flex items-center justify-center rounded-md bg-slate-900 text-white disabled:opacity-50"
          >
            <Send size={15} />
          </button>
        </div>
        <VoiceHintTape micMode={micMode} />
      </div>
    </aside>
  );
}

function VoiceHintTape({ micMode }) {
  // Rotating "Try saying..." examples to teach voice commands without a
  // wall-of-text tutorial. Only shows when the mic is engaged so it's
  // discoverable at the right moment.
  const HINTS = [
    'Try: "show flagged transactions"',
    'Try: "open 317 LLC"',
    'Try: "go to reports"',
    'Try: "suggested rules"',
    'Try: "overdue invoices"',
    'Try: "clear chat"',
    'Try: "stop" — cancels the AI mid-speech',
    'Tip: hover a transaction row to make it the AI\'s context',
    'Tip: say "why" to get a deeper answer',
  ];
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setIdx(i => (i + 1) % HINTS.length), 4500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const active = micMode !== "off";
  return (
    <div
      key={idx}
      data-testid="ai-voice-hint"
      className={`mt-2 text-[10px] transition-opacity duration-500 ${
        active ? "text-indigo-600" : "text-slate-500"
      }`}
      style={{ animation: "fadeInUp 0.5s" }}
    >
      {HINTS[idx]}
    </div>
  );
}

function VoicePicker({ voices, voiceOn, setVoiceOn, voiceName, setVoiceName, voiceRate, setVoiceRate, terseness, setTerseness, speakOne, onClose }) {
  // Prefer English voices at the top of the list — everything else follows,
  // grouped by language. Keeps "Google UK English Female" easy to find on a
  // machine with 60+ voices installed.
  const sorted = [...voices].sort((a, b) => {
    const aEn = /^en/i.test(a.lang) ? 0 : 1;
    const bEn = /^en/i.test(b.lang) ? 0 : 1;
    if (aEn !== bEn) return aEn - bEn;
    return (a.lang + a.name).localeCompare(b.lang + b.name);
  });
  const preview = () => {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    speakOne("Hi — this is your Axiom assistant. I'll read replies aloud in this voice.");
  };
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="absolute right-0 top-full mt-1 z-50 w-72 rounded-md border bg-white shadow-lg p-3 space-y-2"
        data-testid="ai-tts-voice-panel"
      >
        <label className="flex items-center gap-2 cursor-pointer text-sm">
          <input
            type="checkbox"
            checked={voiceOn}
            onChange={(e) => setVoiceOn(e.target.checked)}
            data-testid="ai-tts-auto-checkbox"
          />
          Read responses aloud automatically
        </label>
        <div>
          <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">
            Voice
          </label>
          <select
            value={voiceName}
            onChange={(e) => setVoiceName(e.target.value)}
            data-testid="ai-tts-voice-select"
            className="w-full border rounded px-2 py-1.5 text-sm"
          >
            {sorted.length === 0 && <option value="">System default</option>}
            {sorted.map(v => (
              <option key={`${v.name}-${v.lang}`} value={v.name}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">
            Reply length
          </label>
          <div
            className="inline-flex rounded-md border border-slate-300 overflow-hidden text-xs w-full"
            data-testid="ai-terseness"
          >
            {[
              { k: "concise",  l: "Concise",  hint: "1 sentence, ≤25 words" },
              { k: "balanced", l: "Balanced", hint: "1-3 sentences (default)" },
              { k: "detailed", l: "Detailed", hint: "Deep analysis, multi-paragraph" },
            ].map((o, i) => (
              <button
                key={o.k}
                onClick={() => setTerseness(o.k)}
                data-testid={`ai-terseness-${o.k}`}
                title={o.hint}
                className={`flex-1 px-2 py-1 ${i > 0 ? "border-l border-slate-300" : ""} ${
                  terseness === o.k ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {o.l}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[11px] uppercase tracking-wider text-slate-500">Rate</label>
            <span className="text-[11px] tabular-nums text-slate-600">{voiceRate.toFixed(2)}×</span>
          </div>
          <input
            type="range"
            min="0.8"
            max="1.4"
            step="0.05"
            value={voiceRate}
            onChange={(e) => setVoiceRate(parseFloat(e.target.value))}
            data-testid="ai-tts-rate-slider"
            className="w-full accent-slate-900 cursor-pointer"
          />
        </div>
        <button
          onClick={preview}
          data-testid="ai-tts-preview"
          className="w-full text-xs px-2.5 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 inline-flex items-center justify-center gap-1"
        >
          <Volume2 size={12} /> Preview
        </button>
        {sorted.length === 0 && (
          <p className="text-[11px] text-slate-500">
            No voices detected yet — Chrome loads them asynchronously. Refresh the page or
            check your OS voice settings.
          </p>
        )}
      </div>
    </>
  );
}


function MicButton({ mode, listening, streaming, ttsSpeaking, onCycle, onPttStart, onPttEnd }) {
  // Visual states:
  //   off      — grey mic
  //   ptt idle — indigo outline mic (hint the button is "armed")
  //   ptt held — red mic (currently listening)
  //   open     — red mic with dot indicator
  //   speaking-back (any mode, ttsSpeaking) — dimmed with distinctive tint
  const isOpen = mode === "open";
  const isPtt = mode === "ptt";
  const armed = (isOpen && listening) || (isPtt && listening);
  const cls = ttsSpeaking
    ? "border-slate-200 bg-slate-100 text-slate-400"
    : armed
      ? "bg-red-500 border-red-500 text-white"
      : isPtt
        ? "border-indigo-300 text-indigo-600 hover:bg-indigo-50"
        : isOpen
          ? "border-red-300 text-red-600 hover:bg-red-50"
          : "border-slate-200 text-slate-600 hover:bg-slate-50";
  const title =
    mode === "off" ? "Voice input off — click to enable push-to-talk"
    : mode === "ptt" ? "Click to switch to open-mic · hold to speak"
    : "Click to turn off · open-mic is on";
  // Tap-vs-hold discriminator: press-hold ≥ HOLD_MS triggers PTT; a quick
  // press-release (< HOLD_MS) is treated as a click and cycles the mode.
  // This avoids the classic mousedown+click race on a dual-purpose button.
  const HOLD_MS = 220;
  const holdRef = useRef({ timer: null, held: false });
  const pointerDown = (e) => {
    e.preventDefault();
    holdRef.current.held = false;
    holdRef.current.timer = setTimeout(() => {
      holdRef.current.held = true;
      if (mode === "ptt") onPttStart();
    }, HOLD_MS);
  };
  const pointerUp = () => {
    clearTimeout(holdRef.current.timer);
    if (holdRef.current.held) {
      if (mode === "ptt") onPttEnd();
    } else {
      onCycle();
    }
    holdRef.current.held = false;
  };
  return (
    <div className="relative">
      <button
        data-testid="ai-chat-mic"
        onPointerDown={pointerDown}
        onPointerUp={pointerUp}
        onPointerLeave={() => {
          clearTimeout(holdRef.current.timer);
          if (holdRef.current.held && mode === "ptt") onPttEnd();
          holdRef.current.held = false;
        }}
        disabled={streaming}
        className={`relative w-9 h-9 flex items-center justify-center rounded-md border transition select-none ${cls}`}
        title={title}
      >
        {armed ? <MicOff size={15} /> : <Mic size={15} />}
      </button>
      {isOpen && !ttsSpeaking && (
        <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white" />
      )}
      {isPtt && !armed && !ttsSpeaking && (
        <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[8px] text-indigo-500 font-semibold uppercase tracking-wider">
          Hold
        </span>
      )}
    </div>
  );
}

