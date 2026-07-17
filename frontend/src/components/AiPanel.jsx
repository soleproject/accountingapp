import { useEffect, useRef, useState } from "react";
import { Send, Sparkles, X, MessageSquare, Mic, MicOff, Volume2, VolumeX, ChevronDown } from "lucide-react";
import { api, BACKEND_URL } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { useAiFocus } from "@/lib/aiFocus";
import { toast } from "sonner";

const getSR = () => window.SpeechRecognition || window.webkitSpeechRecognition;

export default function AiPanel({ collapsed, onToggle }) {
  const { currentId, current } = useCompany();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [voiceOn, setVoiceOn] = useState(() => localStorage.getItem("axiom_tts") === "1");
  const [voiceName, setVoiceName] = useState(() => localStorage.getItem("axiom_tts_voice") || "Google UK English Female");
  const [voices, setVoices] = useState([]);
  const [voiceMenuOpen, setVoiceMenuOpen] = useState(false);
  const recognitionRef = useRef(null);
  const scrollRef = useRef(null);
  // TTS pointers: how much of the current assistant reply we've already
  // queued to the browser's speechSynthesis. Kept in a ref so streaming
  // delta callbacks don't cause React re-renders on every chunk.
  const spokenIdxRef = useRef(0);
  const voiceOnRef = useRef(voiceOn);
  const voiceNameRef = useRef(voiceName);
  useEffect(() => {
    voiceOnRef.current = voiceOn;
    localStorage.setItem("axiom_tts", voiceOn ? "1" : "0");
    if (!voiceOn && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }, [voiceOn]);
  useEffect(() => {
    voiceNameRef.current = voiceName;
    localStorage.setItem("axiom_tts_voice", voiceName || "");
  }, [voiceName]);
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

  // Set up SpeechRecognition once
  useEffect(() => {
    const SR = getSR();
    if (!SR) return;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += t;
        else interimText += t;
      }
      if (finalText) {
        setInput(prev => (prev + " " + finalText).replace(/\s+/g, " ").trim());
      }
      setInterim(interimText);
    };
    rec.onerror = (e) => {
      console.warn("SpeechRecognition error", e);
      setListening(false);
    };
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    return () => { try { rec.stop(); } catch {} };
  }, []);

  const toggleMic = () => {
    const rec = recognitionRef.current;
    if (!rec) {
      toast.error("Voice input isn't supported in this browser. Try Chrome/Edge.");
      return;
    }
    if (listening) {
      try { rec.stop(); } catch {}
      setListening(false);
      setInterim("");
    } else {
      setInterim("");
      try {
        rec.start();
        setListening(true);
      } catch (e) {
        toast.error("Could not start microphone");
      }
    }
  };

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

  const send = async () => {
    if (!input.trim() || streaming || !currentId) return;
    // Stop mic on send
    if (listening && recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
      setListening(false); setInterim("");
    }
    const userMsg = input.trim();
    setInput("");
    setMessages(m => [...m, { role: "user", content: userMsg }, { role: "assistant", content: "" }]);
    // Fresh reply → reset TTS pointer and stop any prior speech so we don't
    // read overlapping messages.
    spokenIdxRef.current = 0;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
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
    u.rate = 1.05;
    u.pitch = 1.0;
    u.volume = 1.0;
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
            <span className="text-xs text-red-700">Listening… {interim && <span className="italic text-red-600">"{interim}"</span>}</span>
          </div>
        )}
        <div className="flex gap-2">
          <button
            data-testid="ai-chat-mic"
            onClick={toggleMic}
            disabled={streaming}
            className={`w-9 h-9 flex items-center justify-center rounded-md border transition ${
              listening ? "bg-red-500 border-red-500 text-white" : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
            title={listening ? "Stop listening" : "Voice input"}
          >
            {listening ? <MicOff size={15} /> : <Mic size={15} />}
          </button>
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
        <div className="mt-2 text-[10px] text-slate-500">
          Tip: hover a transaction row → it becomes context for your next question. Try the mic and say "regarding the Walmart purchase on May 3rd…"
        </div>
      </div>
    </aside>
  );
}

function VoicePicker({ voices, voiceOn, setVoiceOn, voiceName, setVoiceName, speakOne, onClose }) {
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

