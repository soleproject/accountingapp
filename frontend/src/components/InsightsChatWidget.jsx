/**
 * InsightsChatWidget — a QBO-Intuit-Intelligence-style floating AI
 * companion. Small pill at bottom-right by default; click it and it
 * expands into a side sheet that can further grow to embed a live
 * chart.
 *
 * INTENTIONALLY SEPARATE from `AiPanel` (the big right-edge cockpit).
 * • Uses its own endpoint: `/companies/{cid}/ai/insights/ask`
 * • Uses its own conversation memory (session-scoped, sessionStorage)
 * • Auto-hides when the AiPanel is open (checks `--ai-panel-width`)
 *   so the two never fight for the same pixels.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { getRegisteredChartIds } from "@/hooks/useRegisterChart";
import { toast } from "sonner";
import {
  Sparkles, Send, X, ChevronDown, ChevronUp, ArrowUpRight,
  Loader2, MessageSquare, BarChart3, Mic, MicOff, AlertCircle,
} from "lucide-react";

const STARTER_PROMPTS = [
  "How's my profit doing this quarter?",
  "Who owes me money right now?",
  "What's my inventory worth?",
  "What do I need to reorder?",
];

const SESSION_KEY = "insights_chat_session";

export default function InsightsChatWidget() {
  const { currentId } = useCompany();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);   // {role, text, chart_id?, chart_title?, chart_data?, quick_actions?}
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiPanelWidth, setAiPanelWidth] = useState(0);
  const sessionId = useMemo(() => {
    let s = sessionStorage.getItem(SESSION_KEY);
    if (!s) { s = crypto.randomUUID(); sessionStorage.setItem(SESSION_KEY, s); }
    return s;
  }, []);
  const listRef = useRef(null);

  // ── Cost cap awareness ────────────────────────────────────────────
  // Per-company monthly ceiling stored in localStorage (v1); backend
  // meters actual spend and returns 'ok' | 'warn' (≥80%) | 'block'.
  const monthlyCap = Number(localStorage.getItem("insights_monthly_cap") || 0);
  const [budget, setBudget] = useState(null);   // {status, spent, cap, ...}

  // ── Voice input (Web Speech API — no external deps) ───────────────
  const [listening, setListening] = useState(false);
  const recogRef = useRef(null);
  const voiceSupported = typeof window !== "undefined"
    && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
  const toggleMic = () => {
    if (!voiceSupported) { toast.info("Voice input isn't supported in this browser."); return; }
    if (listening) { recogRef.current?.stop(); setListening(false); return; }
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new Ctor();
    r.lang = "en-US"; r.interimResults = true; r.continuous = false;
    r.onresult = (ev) => {
      const parts = Array.from(ev.results).map(r => r[0].transcript).join(" ");
      setQ(parts.trim());
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    r.start();
    recogRef.current = r; setListening(true);
  };

  // Open the panel when the sidebar (or any other launcher) fires a
  // global `insights:open` event. Lets us keep this component as the
  // single source of truth for the panel while allowing multiple entry
  // points across the app.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("insights:open", onOpen);
    return () => window.removeEventListener("insights:open", onOpen);
  }, []);

  // Track how many pixels the right-edge AiPanel is currently
  // consuming so we can slide the pill left instead of hiding it.
  // AiPanel exposes `body[data-ai-panel-open="1"]` when expanded; the
  // saved width lives in `--ai-panel-width`.
  useEffect(() => {
    const check = () => {
      const open = document.body.getAttribute("data-ai-panel-open") === "1";
      if (!open) { setAiPanelWidth(0); return; }
      const w = getComputedStyle(document.documentElement)
        .getPropertyValue("--ai-panel-width").trim();
      setAiPanelWidth(parseInt(w, 10) || 0);
    };
    check();
    const t = setInterval(check, 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, busy]);

  // Fetch current budget once on mount so the warning banner reflects
  // reality even before the first ask of the session.
  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/ai/insights/budget`,
            { params: monthlyCap > 0 ? { monthly_cap: monthlyCap } : {} })
      .then(r => setBudget(r.data))
      .catch(() => {});
  }, [currentId, monthlyCap]);

  const ask = async (text) => {
    const question = (text ?? q).trim();
    if (!question || !currentId) return;
    setMessages(m => [...m, { role: "user", text: question }]);
    setQ("");
    setBusy(true);
    // Insert an empty assistant bubble we'll stream into.
    const assistantIdx = messages.length + 1;
    setMessages(m => [...m, { role: "assistant", text: "", streaming: true }]);
    try {
      const authToken = localStorage.getItem("token")
        || sessionStorage.getItem("token") || "";
      const apiBase = process.env.REACT_APP_BACKEND_URL || "";
      const resp = await fetch(
        `${apiBase}/api/companies/${currentId}/ai/insights/ask/stream`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            question,
            session_id: sessionId,
            page: location.pathname,
            page_charts: getRegisteredChartIds(),
            monthly_cap_usd: monthlyCap || null,
          }),
        }
      );
      if (resp.status === 402) {
        const err = await resp.json().catch(() => ({}));
        setMessages(m => {
          const copy = [...m];
          copy[assistantIdx] = {
            role: "assistant",
            text: err?.detail?.message
              || "Monthly Insights budget reached — raise the cap in Settings.",
            streaming: false,
            capBlocked: true,
          };
          return copy;
        });
        return;
      }
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        // Split on \n\n boundaries — that's the SSE event delimiter.
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = frame.split("\n");
          let evName = "message"; let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) evName = line.slice(7).trim();
            else if (line.startsWith("data: ")) dataStr += line.slice(6);
          }
          if (!dataStr) continue;
          let data; try { data = JSON.parse(dataStr); } catch { continue; }
          if (evName === "text_delta") {
            setMessages(m => {
              const copy = [...m];
              const b = copy[assistantIdx];
              copy[assistantIdx] = { ...b, text: (b?.text || "") + (data.content || "") };
              return copy;
            });
          } else if (evName === "chart") {
            setMessages(m => {
              const copy = [...m];
              copy[assistantIdx] = {
                ...copy[assistantIdx],
                chart_id: data.chart_id,
                chart_title: data.chart_title,
                chart_data: data.chart_data,
                quick_actions: data.quick_actions || [],
              };
              return copy;
            });
          } else if (evName === "done") {
            setMessages(m => {
              const copy = [...m];
              copy[assistantIdx] = { ...copy[assistantIdx], streaming: false };
              return copy;
            });
            // Refresh budget so the warning banner tracks after each ask.
            api.get(`/companies/${currentId}/ai/insights/budget`,
                    { params: monthlyCap > 0 ? { monthly_cap: monthlyCap } : {} })
              .then(r => setBudget(r.data)).catch(() => {});
          } else if (evName === "error") {
            throw new Error(data.message || "stream error");
          }
        }
      }
    } catch (e) {
      toast.error(e.message || "AI is temporarily unavailable");
      setMessages(m => {
        const copy = [...m];
        copy[assistantIdx] = {
          role: "assistant",
          text: "Sorry — I couldn't reach the insights service. Please try again in a moment.",
          streaming: false,
        };
        return copy;
      });
    } finally { setBusy(false); }
  };

  const hardReset = () => {
    setMessages([]);
    sessionStorage.removeItem(SESSION_KEY);
    location.reload && location.reload();
  };

  // Never render on the login page / when there's no company selected.
  if (!currentId) return null;

  // Slide the pill LEFT of the expanded AiPanel edge (+16px gap) so
  // they never overlap. When AiPanel is collapsed the offset is 0 and
  // the pill sits in its natural bottom-right home.
  const rightOffset = aiPanelWidth > 0 ? aiPanelWidth + 24 : 24;

  return (
    <>
      {open && (
        <div
          data-testid="insights-chat-panel"
          style={{ right: `${rightOffset}px`, bottom: aiPanelWidth > 0 ? "84px" : "24px" }}
          className={`fixed z-40 bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col ${
            messages.some(m => m.chart_data)
              ? "w-[min(720px,calc(100vw-3rem))] h-[min(680px,calc(100vh-3rem))]"
              : "w-[min(420px,calc(100vw-3rem))] h-[min(560px,calc(100vh-3rem))]"
          } transition-[width,height,right,bottom] duration-200`}
        >
          <header className="flex items-center gap-2 px-4 py-3 border-b bg-gradient-to-br from-indigo-50 to-fuchsia-50 rounded-t-2xl">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-600 to-fuchsia-600 grid place-items-center text-white">
              <Sparkles size={14} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-slate-800">Insights</div>
              <div className="text-[10px] text-slate-500 truncate">
                Ask about any report or number
              </div>
            </div>
            {messages.length > 0 && (
              <button onClick={hardReset}
                      data-testid="insights-chat-reset"
                      className="text-[11px] text-slate-500 hover:text-slate-800 px-2 py-1 rounded hover:bg-white/60">
                New chat
              </button>
            )}
            <button onClick={() => setOpen(false)}
                    data-testid="insights-chat-close"
                    className="p-1 rounded hover:bg-white/60">
              <X size={14} />
            </button>
          </header>

          <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {budget?.status === "warn" && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 flex items-start gap-2" data-testid="insights-budget-warn">
                <AlertCircle size={12} className="mt-0.5 text-amber-700 shrink-0" />
                <div>
                  You're at ${budget.spent?.toFixed(2)} of your ${budget.cap?.toFixed(2)} monthly Insights budget.
                  <button
                    onClick={() => {
                      const v = prompt("New monthly cap (USD, 0 for unlimited):", String(monthlyCap || ""));
                      if (v != null) {
                        localStorage.setItem("insights_monthly_cap", String(Math.max(0, Number(v) || 0)));
                        location.reload();
                      }
                    }}
                    className="ml-1 underline text-amber-800 hover:text-amber-900"
                  >Adjust</button>
                </div>
              </div>
            )}
            {!messages.length && (
              <div className="space-y-3" data-testid="insights-chat-starter">
                <div className="text-sm text-slate-700 leading-relaxed">
                  Hey! Ask me anything about your books — I'll pull the right
                  chart and walk you through what it means.
                </div>
                <div className="grid grid-cols-1 gap-1.5">
                  {STARTER_PROMPTS.map((p, i) => (
                    <button
                      key={i}
                      onClick={() => ask(p)}
                      data-testid={`insights-chat-starter-${i}`}
                      className="text-left text-xs px-3 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 inline-flex items-center gap-2"
                    >
                      <MessageSquare size={11} className="text-slate-400" />
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <MessageBubble key={i} msg={m} navigate={navigate} />
            ))}

            {busy && (
              <div className="flex items-center gap-2 text-xs text-slate-500 px-1">
                <Loader2 size={12} className="animate-spin" />
                Thinking…
              </div>
            )}
          </div>

          <div className="border-t bg-white px-3 py-2.5 rounded-b-2xl">
            <div className="flex items-center gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }}
                placeholder={listening ? "Listening…" : "Ask about a report, number, or trend…"}
                data-testid="insights-chat-input"
                className="flex-1 text-sm bg-slate-50 border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-300"
              />
              {voiceSupported && (
                <button
                  onClick={toggleMic}
                  data-testid="insights-chat-mic"
                  title={listening ? "Stop listening" : "Speak your question"}
                  className={`p-2 rounded-lg border ${listening ? "bg-rose-500 text-white border-rose-500 animate-pulse" : "bg-white hover:bg-slate-50 text-slate-600"}`}
                >
                  {listening ? <MicOff size={13} /> : <Mic size={13} />}
                </button>
              )}
              <button
                onClick={() => ask()}
                disabled={busy || !q.trim()}
                data-testid="insights-chat-send"
                className="p-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40"
              >
                <Send size={13} />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}


function MessageBubble({ msg, navigate }) {
  const [chartOpen, setChartOpen] = useState(true);
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-indigo-600 text-white px-3 py-2 text-sm">
          {msg.text}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-slate-100 text-slate-800 px-3 py-2 text-sm whitespace-pre-wrap">
        {msg.text}
        {msg.streaming && <span className="ml-0.5 inline-block w-1.5 h-3.5 bg-slate-500 align-middle animate-pulse" />}
      </div>
      {msg.chart_data && (
        <div className="border rounded-xl bg-white overflow-hidden" data-testid={`insights-chart-${msg.chart_id}`}>
          <button
            onClick={() => setChartOpen(o => !o)}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-50 hover:bg-slate-100"
          >
            <BarChart3 size={12} className="text-indigo-600" />
            {msg.chart_title}
            <span className="ml-auto text-slate-400">
              {chartOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </span>
          </button>
          {chartOpen && (
            <div className="p-3">
              <ChartRenderer chartId={msg.chart_id} data={msg.chart_data} />
            </div>
          )}
        </div>
      )}
      {msg.quick_actions?.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {msg.quick_actions.map((qa, i) => (
            <button
              key={i}
              onClick={() => qa.to && navigate(qa.to)}
              data-testid={`insights-quick-action-${i}`}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100"
            >
              {qa.label}
              <ArrowUpRight size={10} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


/** Minimalist renderer for the 6 registered charts. Doesn't try to be a
 *  full report — just gives the user a readable summary of the actual
 *  numbers, which is 95% of what QBO's chat does too. */
function ChartRenderer({ chartId, data }) {
  if (!data) return <div className="text-xs text-slate-400 italic">No data.</div>;
  if (chartId === "income_statement") {
    return (
      <div className="space-y-1.5 text-xs">
        <Row label="Total revenue" value={data.total_revenue} bold />
        <Row label="Total expenses" value={data.total_expense} bold />
        <div className="border-t pt-1.5 mt-1.5">
          <Row label="Net income" value={data.net_income} bold accent={(data.net_income || 0) >= 0 ? "emerald" : "rose"} />
        </div>
        {data.expense_rows?.length > 0 && (
          <details className="pt-1">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-800 text-[11px]">Top expense categories</summary>
            <div className="pl-3 pt-1 space-y-0.5">
              {data.expense_rows.filter(r => r.amount).slice(0, 8).map((r, i) => (
                <Row key={i} label={r.name} value={r.amount} small />
              ))}
            </div>
          </details>
        )}
      </div>
    );
  }
  if (chartId === "balance_sheet") {
    return (
      <div className="space-y-1.5 text-xs">
        <Row label="Total assets" value={data.total_assets} bold accent="indigo" />
        <Row label="Total liabilities" value={data.total_liabilities} bold />
        <Row label="Total equity" value={data.total_equity} bold accent="fuchsia" />
      </div>
    );
  }
  if (chartId === "ar_aging" || chartId === "ap_aging") {
    const rows = data.rows || [];
    return (
      <div className="space-y-1 text-xs">
        <div className="text-slate-500 pb-1">
          {rows.length} {chartId === "ar_aging" ? "customer" : "vendor"}{rows.length === 1 ? "" : "s"} outstanding
        </div>
        {rows.slice(0, 6).map((r, i) => (
          <Row key={i}
               label={r.contact_name || r.customer_name || r.vendor_name || "Unknown"}
               value={r.total_open || r.total}
               small
               subtext={r.oldest_days ? `${r.oldest_days}d oldest` : undefined} />
        ))}
        {rows.length > 6 && <div className="text-[10px] text-slate-400 pt-1">+{rows.length - 6} more</div>}
      </div>
    );
  }
  if (chartId === "inventory_valuation") {
    const rows = data.rows || [];
    return (
      <div className="space-y-1 text-xs">
        <Row label="Total inventory value" value={data.total_value} bold accent="indigo" />
        <div className="text-slate-500 py-1">{data.item_count} tracked items</div>
        {rows.slice(0, 5).map((r) => (
          <Row key={r.item_id} label={r.name} value={r.value} small
               subtext={`${r.qoh} × ${fmtMoney(r.cost_basis)}`} />
        ))}
      </div>
    );
  }
  if (chartId === "reorder_alerts") {
    const rows = data.rows || [];
    return (
      <div className="space-y-1 text-xs">
        <div className="text-slate-500 pb-1">
          {rows.length} item{rows.length === 1 ? "" : "s"} at or below low-stock threshold
        </div>
        {rows.slice(0, 8).map((r) => (
          <div key={r.item_id} className="flex justify-between gap-2 py-0.5">
            <span className="truncate text-slate-700">{r.name}</span>
            <span className="text-amber-700 font-mono-num whitespace-nowrap">
              {r.qoh} / {r.threshold}
            </span>
          </div>
        ))}
      </div>
    );
  }
  return <pre className="text-[10px] text-slate-500 overflow-auto max-h-40">{JSON.stringify(data, null, 2)}</pre>;
}


function Row({ label, value, bold = false, small = false, accent, subtext }) {
  const accentCls = {
    emerald: "text-emerald-700",
    rose: "text-rose-700",
    indigo: "text-indigo-700",
    fuchsia: "text-fuchsia-700",
  }[accent] || "text-slate-800";
  return (
    <div className="flex items-baseline justify-between gap-2">
      <div className="min-w-0 flex-1">
        <div className={`truncate ${small ? "text-slate-600" : "text-slate-700"}`}>{label}</div>
        {subtext && <div className="text-[10px] text-slate-400 truncate">{subtext}</div>}
      </div>
      <div className={`font-mono-num whitespace-nowrap ${bold ? "font-semibold" : ""} ${accentCls}`}>
        {fmtMoney(value)}
      </div>
    </div>
  );
}
