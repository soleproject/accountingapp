import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Send, Sparkles, X, MessageSquare, Mic, MicOff, Volume2, VolumeX, ChevronDown, Trash2 } from "lucide-react";
import { api, BACKEND_URL } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { TID } from "@/constants/testIds";
import { useAiFocus } from "@/lib/aiFocus";
import { toast } from "sonner";
import { resolveVoiceCommand } from "@/lib/voiceCommands";
import { emitCreate, emitAction, useActionListener } from "@/lib/createBus";
import { stripMarkdownForSpeech } from "@/lib/speechText";

// Compact confirm card used by the create-account / recategorize / transfer
// flows. Same visual language as BulkApproveCard but generic — takes a title,
// a busy label, and an onConfirm/onDismiss pair.
function InlineConfirmCard({ testId, tone = "fuchsia", confirmLabel = "Yes, do it", cancelLabel = "No, thanks", busyLabel = "Applying…", onConfirm, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [handled, setHandled] = useState(false);
  const toneCls = {
    fuchsia: "border-fuchsia-200 bg-fuchsia-50/60",
    indigo:  "border-indigo-200 bg-indigo-50/60",
    emerald: "border-emerald-200 bg-emerald-50/60",
  }[tone] || "border-slate-200 bg-slate-50";
  const btnCls = {
    fuchsia: "bg-fuchsia-600 hover:bg-fuchsia-700",
    indigo:  "bg-indigo-600 hover:bg-indigo-700",
    emerald: "bg-emerald-600 hover:bg-emerald-700",
  }[tone] || "bg-slate-700 hover:bg-slate-800";

  const confirm = async () => {
    if (busy || handled) return;
    setBusy(true);
    try { await onConfirm(); setHandled(true); } finally { setBusy(false); }
  };
  const dismiss = () => { if (handled) return; setHandled(true); onDismiss?.(); };

  return (
    <div data-testid={testId} className={`mt-2 rounded-md border px-3 py-2 text-[13px] ${toneCls}`}>
      <div className="flex items-center gap-2">
        <button data-testid={`${testId}-yes`} disabled={busy || handled} onClick={confirm}
                className={`px-3 py-1 text-xs font-medium rounded text-white disabled:opacity-50 ${btnCls}`}>
          {busy ? busyLabel : confirmLabel}
        </button>
        <button data-testid={`${testId}-no`} disabled={busy || handled} onClick={dismiss}
                className="px-3 py-1 text-xs font-medium rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}

// Compact two-input form shown under an assistant message when the backend
// detected a bimodal amount distribution. Lets the user name the below /
// above categories and fires them through the same natural-language flow.
function SplitHintForm({ hint, onApply, onDismiss }) {
  const [below, setBelow] = useState(hint.previous_below || "");
  const [above, setAbove] = useState(hint.previous_above || "");
  const [busy, setBusy] = useState(false);
  const hasHistory = !!(hint.previous_below || hint.previous_above);
  const apply = async () => {
    if (busy || !below.trim() || !above.trim()) return;
    setBusy(true);
    try { await onApply(below.trim(), above.trim()); } finally { setBusy(false); }
  };
  return (
    <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-[12px]"
         data-testid="split-hint">
      <div className="text-emerald-900 mb-1.5 font-medium flex items-center justify-between">
        <span>Split at ${hint.threshold.toLocaleString()}</span>
        {hasHistory && (
          <span data-testid="split-hint-recall" className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
            recalled from last time
          </span>
        )}
      </div>
      <div className="grid grid-cols-[auto,1fr] gap-x-2 gap-y-1 items-center">
        <span className="text-emerald-900/80 text-[11px]">
          {hint.below.count} rows (${hint.below.min}–${hint.below.max}) →
        </span>
        <input
          data-testid="split-hint-below"
          value={below}
          onChange={(e) => setBelow(e.target.value)}
          placeholder="e.g. Meals"
          className="w-full px-2 py-1 rounded border border-slate-300 bg-white text-[12px]"
          onKeyDown={(e) => { if (e.key === "Enter" && above.trim()) apply(); }}
        />
        <span className="text-emerald-900/80 text-[11px]">
          {hint.above.count} rows (${hint.above.min}–${hint.above.max}) →
        </span>
        <input
          data-testid="split-hint-above"
          value={above}
          onChange={(e) => setAbove(e.target.value)}
          placeholder="e.g. Office Supplies"
          className="w-full px-2 py-1 rounded border border-slate-300 bg-white text-[12px]"
          onKeyDown={(e) => { if (e.key === "Enter" && below.trim()) apply(); }}
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          data-testid="split-hint-apply"
          disabled={busy || !below.trim() || !above.trim()}
          onClick={apply}
          className="px-3 py-1 text-xs font-medium rounded text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy ? "Applying…" : (hasHistory ? "Yes, same again" : "Apply split")}
        </button>
        <button
          data-testid="split-hint-dismiss"
          disabled={busy}
          onClick={onDismiss}
          className="px-3 py-1 text-xs font-medium rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Ignore
        </button>
      </div>
    </div>
  );
}

// Interactive confirmation card shown in the chat stream after a user
// approves a transaction that has other unapproved siblings from the same
// contact. Yes → bulk-approve + rule; No → dismiss.
function BulkApproveCard({ similar, createRule, currentId, onDone, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [handled, setHandled] = useState(false);
  const catName = similar.category_account_name || similar.category_account_code || "the same category";

  const applyBulk = async () => {
    if (busy || handled) return;
    setBusy(true);
    try {
      // Fetch every unapproved txn for this contact — the sample in `similar`
      // caps at 5 for chat display, so ask the server for the full list.
      const r = await api.get(
        `/companies/${currentId}/transactions?contact_id=${similar.contact_id}&limit=1000`
      );
      const ids = (r.data.transactions || [])
        .filter((t) => !t.human_reviewed)
        .map((t) => t.id);
      const res = await api.post(
        `/companies/${currentId}/transactions/apply-bulk-approve-rule`,
        {
          txn_ids: ids,
          category_account_id: similar.category_account_id,
          contact_id: similar.contact_id,
          contact_name: similar.contact_name,
          create_rule: !!createRule,
        }
      );
      const updated = res.data?.updated || 0;
      const ruleId = res.data?.rule_id;
      const msg = ruleId
        ? `Approved ${updated} transaction${updated === 1 ? "" : "s"} and created a rule for ${similar.contact_name}.`
        : `Approved ${updated} transaction${updated === 1 ? "" : "s"}.`;
      setHandled(true);
      onDone(msg);
    } catch (e) {
      onDone("Sorry — bulk approval failed.");
      setHandled(true);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    if (handled) return;
    setHandled(true);
    onDismiss();
  };

  return (
    <div
      data-testid="bulk-approve-card"
      className="mt-2 rounded-md border border-fuchsia-200 bg-fuchsia-50/60 px-3 py-2 text-[13px]"
    >
      <div className="text-fuchsia-900 mb-2">
        <span className="font-semibold">{similar.count}</span> other{" "}
        <span className="font-semibold">{similar.contact_name}</span>{" "}
        transaction{similar.count === 1 ? "" : "s"} → categorize as{" "}
        <span className="font-semibold">{catName}</span> and approve
        {createRule ? " + create a rule" : ""}?
      </div>
      <div className="flex items-center gap-2">
        <button
          data-testid="bulk-approve-yes"
          disabled={busy || handled}
          onClick={applyBulk}
          className="px-3 py-1 text-xs font-medium rounded bg-fuchsia-600 text-white hover:bg-fuchsia-700 disabled:opacity-50"
        >
          {busy ? "Applying…" : "Yes, do it"}
        </button>
        <button
          data-testid="bulk-approve-no"
          disabled={busy || handled}
          onClick={dismiss}
          className="px-3 py-1 text-xs font-medium rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          No, thanks
        </button>
      </div>
    </div>
  );
}

// --------------------- Report → one-sentence spoken summary ---------------------
// Runs entirely on the client from the report API's JSON response so we never
// spin up a chat LLM just to read numbers out loud.
const _fmt$ = (n) => {
  const v = Number(n || 0);
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${v < 0 ? "-" : ""}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `${v < 0 ? "-" : ""}$${(abs / 1_000).toFixed(1)}K`;
  return `${v < 0 ? "-" : ""}$${abs.toFixed(2)}`;
};
function summarizeReport(kind, name, data, filters = {}) {
  if (!data) return `No data for ${name}.`;
  const range = (filters.start && filters.end) ? ` from ${filters.start} to ${filters.end}` : "";
  const basis = filters.basis ? ` on ${filters.basis} basis` : "";
  const suffix = `${range}${basis}`;
  try {
    if (kind === "income-statement") {
      const rev = data.total_revenue || 0;
      const exp = data.total_expense || 0;
      const ni  = data.net_income ?? (rev - exp);
      const topExp = [...(data.expenses || [])]
        .sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 3)
        .map(x => `${x.account_name || x.name} at ${_fmt$(x.amount)}`);
      const topLine = topExp.length ? ` Top expenses: ${topExp.join(", ")}.` : "";
      return `${name}${suffix}: revenue ${_fmt$(rev)}, expenses ${_fmt$(exp)}, net income ${_fmt$(ni)}.${topLine}`;
    }
    if (kind === "balance-sheet") {
      const a = data.total_assets || 0;
      const l = data.total_liabilities || 0;
      const e = data.total_equity || 0;
      return `${name}${suffix}: assets ${_fmt$(a)}, liabilities ${_fmt$(l)}, equity ${_fmt$(e)}.`;
    }
    if (kind === "cash-flow") {
      const net = data.net_change || data.total || 0;
      return `${name}${suffix}: net change in cash ${_fmt$(net)}.`;
    }
    if (kind === "trial-balance") {
      const d = data.total_debit ?? data.total_debits ?? 0;
      const c = data.total_credit ?? data.total_credits ?? 0;
      const bal = Math.abs(d - c) < 0.01 ? "and in balance" : "out of balance";
      return `${name}${suffix}: debits ${_fmt$(d)}, credits ${_fmt$(c)}, ${bal}.`;
    }
    if (kind === "general-ledger") {
      const n = (data.rows || data.entries || []).length;
      return `${name}${suffix}: ${n} ledger entries.`;
    }
    // Fallback: best-effort scalar hunt.
    const t = data.total || data.net_income || data.total_revenue || null;
    return t !== null ? `${name}${suffix}: ${_fmt$(t)}.` : `${name}${suffix}: report loaded.`;
  } catch {
    return `${name}${suffix}: report loaded.`;
  }
}

// Comparative narration. Given a report kind and TWO period responses (now
// and prior), pick the top 2 line-item movers (by |delta|) and speak them.
// Falls back to top-level totals for non-P&L reports.
function summarizeComparison(kind, nowData, priorData, priorLabel = "prior period") {
  if (!nowData || !priorData) return "";
  const pct = (a, b) => {
    if (!isFinite(a) || !isFinite(b) || Math.abs(b) < 0.01) return null;
    return Math.round(((a - b) / Math.abs(b)) * 100);
  };
  const dir = (a, b) => (a > b ? "up" : a < b ? "down" : "flat");

  try {
    if (kind === "income-statement") {
      // Top-line: net income delta.
      const nowNi   = nowData.net_income   ?? ((nowData.total_revenue   || 0) - (nowData.total_expense   || 0));
      const priorNi = priorData.net_income ?? ((priorData.total_revenue || 0) - (priorData.total_expense || 0));
      const niPct = pct(nowNi, priorNi);
      const headline = `Net income is ${dir(nowNi, priorNi)}${niPct != null ? ` ${Math.abs(niPct)}%` : ""} vs ${priorLabel}.`;

      // Combine revenue + expenses into one flat list keyed by account_name.
      const flat = (rpt) => {
        const out = {};
        for (const g of ["revenue", "expenses"]) {
          for (const row of (rpt[g] || [])) {
            const k = (row.account_name || row.name || "").toLowerCase();
            if (!k) continue;
            out[k] = { name: row.account_name || row.name, amount: row.amount || 0, section: g };
          }
        }
        return out;
      };
      const N = flat(nowData), P = flat(priorData);
      const keys = new Set([...Object.keys(N), ...Object.keys(P)]);
      const movers = [];
      for (const k of keys) {
        const n = N[k]?.amount || 0;
        const p = P[k]?.amount || 0;
        const delta = n - p;
        if (Math.abs(delta) < 1) continue;
        movers.push({ name: N[k]?.name || P[k]?.name || k, n, p, delta, pct: pct(n, p) });
      }
      movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      const top = movers.slice(0, 2).map(m =>
        `${m.name} ${dir(m.n, m.p)} ${m.pct != null ? `${Math.abs(m.pct)}%` : _fmt$(Math.abs(m.delta))}`
      );
      const moversLine = top.length ? ` Top movers: ${top.join("; ")}.` : "";
      return `${headline}${moversLine}`;
    }
    if (kind === "balance-sheet") {
      const nA = nowData.total_assets || 0, pA = priorData.total_assets || 0;
      const nL = nowData.total_liabilities || 0, pL = priorData.total_liabilities || 0;
      const nE = nowData.total_equity || 0, pE = priorData.total_equity || 0;
      const bits = [
        `assets ${dir(nA, pA)} ${_fmt$(Math.abs(nA - pA))}`,
        `liabilities ${dir(nL, pL)} ${_fmt$(Math.abs(nL - pL))}`,
        `equity ${dir(nE, pE)} ${_fmt$(Math.abs(nE - pE))}`,
      ];
      return `Vs ${priorLabel}: ${bits.join(", ")}.`;
    }
    if (kind === "cash-flow") {
      const n = nowData.net_change || 0, p = priorData.net_change || 0;
      const cp = pct(n, p);
      return `Net change in cash ${dir(n, p)}${cp != null ? ` ${Math.abs(cp)}%` : ""} vs ${priorLabel}.`;
    }
    return "";
  } catch {
    return "";
  }
}



const getSR = () => window.SpeechRecognition || window.webkitSpeechRecognition;

export default function AiPanel({ collapsed, onToggle }) {
  const { currentId, current, companies, switchCompany } = useCompany();
  const { user } = useAuth();
  const navigate = useNavigate();
  // User-adjustable panel width. Persisted in localStorage. Constrained to a
  // sensible range so it can't be dragged narrower than the header controls
  // or wider than half the viewport.
  const MIN_W = 320;
  const MAX_W = Math.min(900, typeof window !== "undefined" ? Math.floor(window.innerWidth * 0.6) : 900);
  const [panelWidth, setPanelWidth] = useState(() => {
    const stored = parseInt(localStorage.getItem("axiom_ai_panel_width") || "", 10);
    return Number.isFinite(stored) && stored >= MIN_W ? Math.min(MAX_W, stored) : 384;
  });
  useEffect(() => {
    localStorage.setItem("axiom_ai_panel_width", String(panelWidth));
  }, [panelWidth]);
  const resizingRef = useRef(false);
  useEffect(() => {
    if (!resizingRef.current) return;
    const onMove = (e) => {
      if (!resizingRef.current) return;
      // Drag handle is on the LEFT edge — width grows as pointer moves LEFT.
      const w = window.innerWidth - e.clientX;
      const clamped = Math.max(MIN_W, Math.min(MAX_W, w));
      setPanelWidth(clamped);
    };
    const onUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  });
  const startResize = (e) => {
    e.preventDefault();
    resizingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [listening, setListening] = useState(false);
  // Mic mode: "off" | "ptt" (push-to-talk, hold to speak) | "open" (open-mic
  // with silence auto-submit + TTS echo protection). Persisted so a user's
  // preferred conversation mode survives reloads.
  // Legacy value from earlier PTT design: coerce 'ptt' → 'open' on load so
  // returning users don't get stuck in a mode the UI no longer supports.
  const [micMode, setMicMode] = useState(() => {
    const v = localStorage.getItem("axiom_mic_mode") || "off";
    return v === "ptt" ? "open" : v;
  });
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
  // Pending create-intent from the backend parser. When populated, a
  // "confirm" utterance submits it via API; "cancel" clears it.
  const [pendingIntent, setPendingIntent] = useState(null);
  const pendingIntentRef = useRef(null);
  useEffect(() => { pendingIntentRef.current = pendingIntent; }, [pendingIntent]);

  // Weekly-review mode: paced multi-step briefing. When active, the panel
  // shows a progress card and listens for "next / skip / back / exit" cues
  // between steps instead of routing utterances to the chat stream.
  const [review, setReview] = useState(null); // { steps: [...], idx: number }
  const reviewRef = useRef(null);
  useEffect(() => { reviewRef.current = review; }, [review]);

  // Batch resolve mode: paced sprint through flagged transactions. Each row
  // is announced with the AI's best-guess category; user says "yes" to accept,
  // "no it's X" to reclassify, or "skip" to move on. All accepts/rejects are
  // sent to the existing bulk-approve / bulk-reclassify endpoints.
  const [batch, setBatch] = useState(null); // { txns, idx, accounts, decisions }
  const batchRef = useRef(null);
  useEffect(() => { batchRef.current = batch; }, [batch]);
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
  const { focus, setFocus, pinned: focusPinned } = useAiFocus();

  // Cleanup Copilot integration: when the user clicks a chip / "Fix now" on
  // the hero band, the Transactions page emits `cleanup-inquiry` with the
  // action payload. We seed a conversational message so the AI asks about
  // the contact, and stash the action on `pendingIntentRef` so the user's
  // next reply is interpreted as the category description.
  useActionListener("cleanup-inquiry", async (payload) => {
    const a = payload?.action;
    if (!a) return;
    let msg = "";
    if (a.kind === "contact_in_uncat") {
      msg = `I see **${a.count} ${a.contact_name}** transactions sitting in Uncategorized. Tell me about them.`;
    } else if (a.kind === "contact_split") {
      msg = `**${a.contact_name}** is split across ${a.count} different accounts — that's usually a categorization drift. Tell me what these transactions actually are, and I'll consolidate them and create a rule.`;
    } else if (a.kind === "contact_ai_ready") {
      const acode = a.account?.code || "";
      const aname = a.account?.name || "";
      msg = `**${a.count} ${a.contact_name}** transactions were AI-categorized as **${acode} ${aname}** and are waiting for your sign-off. Say **"approve"** to bulk-approve them all, or tell me the correct category if the AI got it wrong.`;
    } else if (a.kind === "flagged_batch") {
      // Fetch the first flagged transaction so we can dive straight in
      // instead of asking "Ready?" — friction the user explicitly called out.
      let first = null;
      if (currentId) {
        try {
          const r = await api.get(
            `/companies/${currentId}/transactions?needs_review=true&limit=1&sort=date_desc`
          );
          const items = r.data?.transactions || r.data?.items || [];
          first = items[0] || null;
        } catch { /* non-fatal */ }
      }
      if (first) {
        const label = first.merchant || first.description || first.contact_name || "this transaction";
        const amt = (typeof first.amount === "number")
          ? ` (${first.amount.toLocaleString("en-US", { style: "currency", currency: "USD" })})`
          : "";
        msg = `Let's run through the ${a.count} flagged transactions together. I'll surface one at a time — tell me what each one is in your own words. The first one is **${label}**${amt}.`;
      } else {
        msg = `Let's run through the ${a.count} flagged transactions together. I'll surface one at a time — tell me what each one is in your own words.`;
      }
    }
    if (!msg) return;

    pendingIntentRef.current = { kind: "cleanup-inquiry", action: a };

    // For contact-in-uncat, probe the amount distribution — if it's bimodal,
    // surface the natural split as a quick-action chip so the user doesn't
    // have to eyeball the amounts themselves.
    let splitHint = null;
    if (a.kind === "contact_in_uncat" && a.contact_id && currentId) {
      try {
        const r = await api.get(
          `/companies/${currentId}/transactions/split-suggestion?contact_id=${a.contact_id}`
        );
        const s = r.data?.suggestion;
        if (s) {
          splitHint = {
            threshold: s.threshold,
            below: s.below,
            above: s.above,
            contactName: a.contact_name,
            previous_below: s.previous_below || null,
            previous_above: s.previous_above || null,
          };
          if (s.previous_below && s.previous_above) {
            msg += `\n\n💡 Last time you split ${a.contact_name} at **$${s.threshold.toLocaleString()}** → **${s.previous_below}** / **${s.previous_above}**. Same again? (${s.below.count} below · ${s.above.count} above)`;
          } else {
            msg += `\n\n💡 These amounts naturally split at **$${s.threshold.toLocaleString()}** — ${s.below.count} rows under, ${s.above.count} rows above. Want to bucket them separately?`;
          }
        }
      } catch { /* non-fatal */ }
    }

    setMessages(m => [...m, { role: "assistant", content: msg, splitHint, showSkip: true, skipContact: { id: a.contact_id, name: a.contact_name, kind: a.kind } }]);
    if (voiceOnRef.current) speakOne(msg.replace(/\*\*/g, ""));
    emitAction("ai-open");
  });

  // Fired from the per-row Sparkles button on the Transactions table. The
  // AI panel is already open (the button emits `ai-open` right after), so
  // we drop an "OK, tell me about this transaction" assistant message and
  // pop open the mic so the user can dictate what it is without hunting
  // for the mic button.
  const inquiryTxnRef = useRef(null);  // txn.id currently under Sparkle inquiry, null otherwise
  const resolveInquiry = () => {
    // End the current single-txn inquiry: drop the pinned focus, close the
    // mic, and forget the txn id. Called after the AI successfully
    // categorizes / marks-as-transfer / creates-account for the focused
    // row — or when the user declines. Safe to call multiple times: only
    // does work when an inquiry is actually active.
    if (!inquiryTxnRef.current) return;
    inquiryTxnRef.current = null;
    setFocus(null, { force: true });
    setMicMode("off");
  };
  useActionListener("ai-tell-me-about", async (payload) => {
    const t = payload?.txn;
    if (!t) return;
    inquiryTxnRef.current = t.id;
    // Pin the focus so the "Cancel focus" pill shows above the input —
    // this is an explicit user gesture (they clicked the sparkle), which
    // is distinct from the ephemeral hover-focus that would only bleed a
    // "Focused transaction" hint without deserving a cancel affordance.
    setFocus(
      {
        id: t.id,
        merchant: t.merchant || t.description || t.contact_name || "Transaction",
        amount: typeof t.amount === "number" ? t.amount : 0,
        date: t.date || "",
      },
      { pin: true },
    );
    const label = t.merchant || t.description || t.contact_name || "this transaction";
    const amt = (typeof t.amount === "number")
      ? ` (${t.amount.toLocaleString("en-US", { style: "currency", currency: "USD" })})`
      : "";
    const msg = `Tell me about this transaction — **${label}**${amt}. What was it for? I'll categorize it (and any similar ones from the same vendor) and offer to create a rule so future imports land in the right place.`;
    setMessages(m => [...m, { role: "assistant", content: msg }]);
    if (voiceOnRef.current) speakOne(msg.replace(/\*\*/g, ""));
    // Give the panel a beat to open + render, then flip on the mic. Doing
    // it via `micMode` mirrors the click on the mic pill in the header
    // (same open-mic + auto-submit-on-silence behavior).
    setTimeout(() => setMicMode("open"), 250);
  });

  // Silent chat-bubble injector — the mega-approve modal's "How To" tour
  // fires this per script step. Posts an assistant bubble without TTS
  // (the modal orchestrator drives its own TTS so it can await utterance
  // ends between steps).
  useActionListener("ai-chat-say", (payload) => {
    const msg = (payload?.message || "").trim();
    if (msg) setMessages(m => [...m, { role: "assistant", content: msg }]);
  });

  // Sibling action fired by the mega-approve modal's per-vendor sparkle
  // button. Primes the chat with the ENTIRE vendor bucket's context (count,
  // dollar volume, current category, whether it's been overridden vs. the
  // AI's original) so the CPA can ask "why is Walmart going to Supplies?"
  // or "make this a rule" and the LLM has everything it needs.
  useActionListener("ai-tell-me-about-bucket", (payload) => {
    const b = payload?.bucket;
    if (!b) return;
    // Silent focus — no primed assistant bubble, no TTS. Just pin the
    // bucket so the "Focused bucket" card renders at the top of chat and
    // the source row on the mega-approve modal picks up the rainbow ring.
    // The LLM sees this focus in its system context on the next user
    // question, so "why is this categorized as supplies?" or "make it a
    // rule" work naturally without any prompting overhead.
    setFocus(
      {
        bucket: true,
        key: b.key,
        contact_name: b.contact_name,
        count: b.count,
        amount: b.amount,
        account_code: b.account_code,
        account_name: b.account_name,
      },
      { pin: true },
    );
    // Auto-open the mic so the CPA can just start talking — same UX as
    // the transaction-row sparkle click.
    setTimeout(() => setMicMode("open"), 250);
  });

  // Live-accountant onboarding coach — the Onboarding page fires this event
  // to inject scripted assistant messages that greet the user at each step
  // ("Great, tell me about your business…"). The rainbow-outline treatment
  // on the last unanswered assistant message is already handled by the
  // chat renderer, so these messages naturally wear the shimmer border.
  useActionListener("onboarding-coach-greet", (payload) => {
    const msg = (payload?.message || "").trim();
    if (!msg) return;
    setMessages(m => [...m, { role: "assistant", content: msg }]);
    if (voiceOnRef.current) speakOne(msg.replace(/\*\*/g, ""));
  });

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
  // Mirror TTS activity into state so the "Stop AI" pill can render
  // reactively. Ref alone doesn't trigger re-renders, so the old
  // "AI speaking — mic muted" indicator only appeared when some other
  // state change forced a paint.
  const [ttsActive, setTtsActive] = useState(false);
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

  // Clear chat: wipes the on-screen conversation AND asks the backend to
  // drop the persisted transcript for this session so a page refresh
  // doesn't restore old messages.
  const clearChatMessages = async () => {
    setMessages([{
      role: "assistant",
      content: `Fresh session. Ask me anything about ${current?.name || "the books"}.`,
    }]);
    setPendingIntent(null);
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    if (currentId) {
      try { await api.delete(`/ai/chat/history?company_id=${currentId}`); } catch { /* non-fatal */ }
    }
  };

  // Dispatch a parsed create/open intent → open the right modal, show a
  // confirmation card in chat.
  const handleParsedIntent = (userMsg, parsed) => {
    const { intent, prefill = {}, say, confidence = 0 } = parsed || {};
    if (!intent || intent === "none" || confidence < 0.4) return false;

    const routeFor = (i) => {
      if (i === "create_invoice" || i === "open_invoice") return "/invoices";
      if (i === "create_bill" || i === "open_bill") return "/bills";
      if (i === "create_contact" || i === "open_contact") return "/contacts";
      if (i === "create_account") return "/accounting/chart-of-accounts";
      if (i === "create_payment") return "/payments";
      if (i === "create_receipt") return "/receipts";
      return null;
    };
    const kindFor = (i) => {
      if (i.startsWith("create_")) return i.slice("create_".length);
      if (i.startsWith("open_"))   return `open-${i.slice("open_".length)}`;
      return null;
    };
    const url = routeFor(intent);
    const kind = kindFor(intent);
    if (!url || !kind) return false;

    // Navigate first so the page mounts and its listener is ready; the
    // createBus queue backstops any race where the event fires early.
    navigate(url);
    setTimeout(() => emitCreate(kind, prefill), 30);

    // Human-friendly card in chat.
    const readable = intent.startsWith("create_")
      ? `Draft ready — review the ${kind} modal, then say "confirm" to save or "cancel" to abort.`
      : say || "Opened.";

    setMessages(m => {
      const copy = [...m];
      // Replace the "Parsing…" placeholder if present, else append.
      const last = copy[copy.length - 1];
      const card = { role: "assistant", content: `${say || readable}\n\n${intent.startsWith("create_") ? readable : ""}`.trim() };
      if (last && last.role === "assistant" && last.content === "Parsing…") {
        copy[copy.length - 1] = card;
      } else {
        copy.push(card);
      }
      return copy;
    });

    // Only creates are pending — opens are already handled by the page nav.
    if (intent.startsWith("create_")) {
      setPendingIntent({ intent, prefill, url });
    } else {
      setPendingIntent(null);
    }
    if (voiceOnRef.current && say) speakOne(say);
    return true;
  };

  // Submit a pending create intent programmatically via API. Returns true
  // on success. On failure we leave the modal open for the user to fix.
  const submitPendingIntent = async (pending) => {
    if (!pending || !currentId) return false;
    const { intent, prefill } = pending;
    try {
      if (intent === "create_invoice") {
        const amt = Number(prefill.amount || 0);
        const body = {
          contact_id: prefill.contact_id || null,
          contact_name: prefill.contact_name || "",
          issue_date: prefill.issue_date || new Date().toISOString().slice(0, 10),
          due_date: prefill.due_date || new Date(Date.now() + (Number(prefill.due_days) || 30) * 86400000).toISOString().slice(0, 10),
          line_items: [{ description: prefill.description || "Services", quantity: 1, rate: amt, amount: amt }],
          tax: Number(prefill.tax || 0),
          status: prefill.status || "sent",
        };
        await api.post(`/companies/${currentId}/invoices`, body);
      } else if (intent === "create_bill") {
        const amt = Number(prefill.amount || 0);
        const body = {
          contact_id: prefill.contact_id || null,
          contact_name: prefill.contact_name || "",
          issue_date: prefill.issue_date || new Date().toISOString().slice(0, 10),
          due_date: prefill.due_date || new Date(Date.now() + (Number(prefill.due_days) || 30) * 86400000).toISOString().slice(0, 10),
          line_items: [{ description: prefill.description || "Services", quantity: 1, rate: amt, amount: amt }],
          status: prefill.status || "open",
        };
        await api.post(`/companies/${currentId}/bills`, body);
      } else if (intent === "create_contact") {
        await api.post(`/companies/${currentId}/contacts`, {
          name: prefill.name || "",
          type: prefill.type || "customer",
          email: prefill.email || "",
          phone: prefill.phone || "",
          address: prefill.address || "",
        });
      } else if (intent === "create_account") {
        await api.post(`/companies/${currentId}/accounts`, {
          code: prefill.code || "9990",
          name: prefill.name || "New Account",
          type: prefill.type || "expense",
          subtype: prefill.subtype || "operating_expense",
        });
      } else {
        return false;
      }
      // Ask the currently open modal to close after a successful save.
      emitAction("close-current-modal");
      toast.success("Created via voice");
      return true;
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to create");
      return false;
    }
  };

  // Start the paced weekly-review briefing. Fetches all 4 steps at once so
  // subsequent "next" utterances are instantaneous (no network hop).
  const startReview = async () => {
    if (!currentId) return;
    setMessages(m => [
      ...m,
      { role: "assistant", content: "One sec — pulling your briefing…" },
    ]);
    try {
      const r = await api.get(`/companies/${currentId}/ai/review`);
      const steps = r.data?.steps || [];
      if (!steps.length) throw new Error("empty");
      setReview({ steps, idx: 0 });
      // Speak step 1 immediately + drop a card into the chat.
      const first = steps[0];
      const intro = `Morning stand-up. ${first.spoken} Say "next" for step 2.`;
      setMessages(m => {
        const copy = [...m];
        copy[copy.length - 1] = { role: "assistant", content: intro };
        return copy;
      });
      if (voiceOnRef.current) speakOne(intro);
    } catch {
      setMessages(m => {
        const copy = [...m];
        copy[copy.length - 1] = { role: "assistant", content: "Couldn't pull the briefing right now." };
        return copy;
      });
    }
  };

  // Advance / step-nav review mode.
  const advanceReview = (direction /* 'next' | 'skip' | 'back' */) => {
    const r = reviewRef.current;
    if (!r) return false;
    let idx = r.idx;
    if (direction === "back") idx = Math.max(0, idx - 1);
    else                       idx = idx + 1;

    if (idx >= r.steps.length) {
      const outro = "That's the briefing. Anything you'd like to dig into?";
      setReview(null);
      setMessages(m => [...m, { role: "assistant", content: outro }]);
      if (voiceOnRef.current) speakOne(outro);
      return true;
    }
    const step = r.steps[idx];
    setReview({ ...r, idx });
    const total = r.steps.length;
    const line = `Step ${idx + 1} of ${total} — ${step.title}. ${step.spoken}` +
      (idx + 1 < total ? ' Say "next" to continue.' : ' Last one — say "next" to finish.');
    setMessages(m => [...m, { role: "assistant", content: line }]);
    if (voiceOnRef.current) speakOne(line);
    return true;
  };

  const exitReview = () => {
    setReview(null);
    setMessages(m => [...m, { role: "assistant", content: "Ended the briefing." }]);
    if (voiceOnRef.current) speakOne("Ended.");
  };

  // ---------------------------- Batch resolve mode ----------------------------
  //
  // Voice-driven sprint through flagged transactions. Uses the existing
  // bulk-approve / bulk-reclassify endpoints so nothing new was needed on
  // the backend. The AI just paces + resolves one row at a time.

  const _fmtMoney = (n) => {
    const v = Number(n || 0);
    return `$${Math.abs(v).toFixed(2)}${v < 0 ? " out" : " in"}`;
  };
  const _announceBatchRow = (txn) => {
    if (!txn) return "";
    const merch = txn.merchant || txn.contact_name || "Unknown";
    const suggested = txn.category_account_name || "Uncategorized";
    return `${merch} for ${_fmtMoney(txn.amount)} — I'll book this to ${suggested}. Yes, skip, or tell me the right category.`;
  };

  const startBatch = async () => {
    if (!currentId) return;
    setMessages(m => [
      ...m,
      { role: "assistant", content: "Pulling flagged transactions…" },
    ]);
    try {
      const [txnsR, acctsR] = await Promise.all([
        api.get(`/companies/${currentId}/transactions?needs_review=true&limit=50`),
        api.get(`/companies/${currentId}/accounts`),
      ]);
      const txns = (txnsR.data.transactions || []).filter(t => t.needs_review);
      const accounts = acctsR.data.accounts || [];
      if (!txns.length) {
        const done = "No flagged transactions — you're clean.";
        setMessages(m => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: done };
          return copy;
        });
        if (voiceOnRef.current) speakOne(done);
        return;
      }
      setBatch({ txns, idx: 0, accounts, accepted: 0, reclassified: 0, skipped: 0 });
      const intro = `Batch resolve — ${txns.length} flagged. First up: ${_announceBatchRow(txns[0])}`;
      setMessages(m => {
        const copy = [...m];
        copy[copy.length - 1] = { role: "assistant", content: intro };
        return copy;
      });
      if (voiceOnRef.current) speakOne(intro);
    } catch (e) {
      setMessages(m => {
        const copy = [...m];
        copy[copy.length - 1] = { role: "assistant", content: "Couldn't pull the flagged queue." };
        return copy;
      });
    }
  };

  // Fuzzy-match a spoken category ("meals", "software subscriptions") to a
  // Chart of Accounts row. Returns the account or null.
  const _matchAccount = (needle, accounts) => {
    if (!needle) return null;
    const q = needle.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (q.length < 2) return null;
    const words = q.split(" ").filter(w => w.length >= 2);
    let best = null, bestScore = 0;
    for (const a of accounts) {
      // Prefer expense/COGS/revenue in batch mode (we're categorizing txns).
      if (!["expense", "cogs", "revenue"].includes(a.type)) continue;
      const n = (a.name || "").toLowerCase();
      let score = 0;
      if (n === q) score = 1000;
      else if (n.includes(q) || q.includes(n)) score = 500 + Math.min(q.length, 20);
      else score = words.reduce((s, w) => s + (n.includes(w) ? 10 : 0), 0);
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return bestScore >= 10 ? best : null;
  };

  const _advanceBatch = (b, updatedCounts) => {
    const nextIdx = b.idx + 1;
    const next = { ...b, ...updatedCounts, idx: nextIdx };
    if (nextIdx >= b.txns.length) {
      const summary = `Done. Accepted ${next.accepted}, reclassified ${next.reclassified}, skipped ${next.skipped}.`;
      setBatch(null);
      setMessages(m => [...m, { role: "assistant", content: summary }]);
      if (voiceOnRef.current) speakOne(summary);
      return;
    }
    setBatch(next);
    const line = `${nextIdx + 1} of ${b.txns.length}. ${_announceBatchRow(b.txns[nextIdx])}`;
    setMessages(m => [...m, { role: "assistant", content: line }]);
    if (voiceOnRef.current) speakOne(line);
  };

  const handleBatchAction = async (action) => {
    const b = batchRef.current;
    if (!b) return;
    const cur = b.txns[b.idx];
    if (!cur) return;

    if (action.action === "exit") {
      const summary = `Ended. Accepted ${b.accepted}, reclassified ${b.reclassified}, skipped ${b.skipped}.`;
      setBatch(null);
      setMessages(m => [...m, { role: "assistant", content: summary }]);
      if (voiceOnRef.current) speakOne(summary);
      return;
    }

    if (action.action === "accept") {
      try {
        // The list endpoint accepts a raw list body — signature: bulk_approve(cid, ids: List[str]).
        await api.post(`/companies/${currentId}/transactions/bulk-approve`, [cur.id]);
        _advanceBatch(b, { accepted: b.accepted + 1 });
      } catch (e) {
        toast.error("Approve failed"); _advanceBatch(b, { skipped: b.skipped + 1 });
      }
      return;
    }
    if (action.action === "skip") {
      _advanceBatch(b, { skipped: b.skipped + 1 });
      return;
    }
    if (action.action === "reclassify") {
      const acct = _matchAccount(action.target, b.accounts);
      if (!acct) {
        const line = `I couldn't find "${action.target}". Try again, say "skip", or "exit".`;
        setMessages(m => [...m, { role: "assistant", content: line }]);
        if (voiceOnRef.current) speakOne(line);
        return;
      }
      try {
        await api.post(`/companies/${currentId}/transactions/bulk-reclassify`, {
          transaction_ids: [cur.id],
          category_account_id: acct.id,
        });
        setMessages(m => [...m, { role: "assistant", content: `Reclassified to ${acct.name}.` }]);
        if (voiceOnRef.current) speakOne(`Reclassified to ${acct.name}.`);
        _advanceBatch(b, { reclassified: b.reclassified + 1 });
      } catch (e) {
        toast.error("Reclassify failed");
        _advanceBatch(b, { skipped: b.skipped + 1 });
      }
    }
  };

  // Manual buttons for batch mode (accessibility + click fallback).
  const batchAcceptBtn  = () => handleBatchAction({ action: "accept" });
  const batchSkipBtn    = () => handleBatchAction({ action: "skip" });
  const batchExitBtn    = () => handleBatchAction({ action: "exit" });




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
        toast.error("Mic keeps failing — turning off. Click the mic again when ready.");
        setMicMode("off");
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

  // Whenever micMode flips, open the mic (open) or close it (off).
  useEffect(() => {
    if (micMode === "open" && !listening) startListening();
    if (micMode === "off"  &&  listening) stopListening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micMode]);

  useEffect(() => {
    if (!currentId) return;
    api.get(`/ai/chat/history?company_id=${currentId}`).then(r => {
      const msgs = r.data.messages || [];
      if (msgs.length === 0) {
        // Skip the generic "Hi — I'm watching X" welcome whenever a
        // step-specific coach is going to greet the user instead: the
        // /onboarding page itself, plus the "let's finish onboarding" nudge
        // that fires on /dashboard for a company that hasn't completed
        // onboarding. Both scenarios produce a warmer, contextual first
        // bubble that makes the generic welcome feel redundant.
        const path = typeof window !== "undefined" ? window.location.pathname : "";
        const onboardingContext =
          path.startsWith("/onboarding") ||
          (current && current.onboarding_complete === false);
        if (onboardingContext) return;
        const firstName = (user?.name || "").split(" ")[0];
        const greeting = firstName
          ? `Hi ${firstName} — I'm watching ${current?.name || "your books"}. I categorize transactions, post JEs, and answer any accounting question. Ask me anything.`
          : `Hi — I'm watching ${current?.name || "your books"}. I categorize transactions, post JEs, and answer any accounting question. Ask me anything.`;
        setMessages([{ role: "assistant", content: greeting }]);
      } else {
        setMessages(msgs.map(m => ({ role: m.role, content: m.content })));
      }
    }).catch(() => {});
  }, [currentId, current?.name, current?.onboarding_complete, user?.name]);

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

    // "Stop" / "quiet" / "shut up" / "be quiet" / "silence" / "hush" / "cancel
    // speech" — kills any current TTS utterance immediately. Doesn't send to
    // the LLM, doesn't post a chat bubble (that would just add MORE for TTS
    // to potentially say next).
    if (/^(?:stop(?: talking| speaking)?|quiet|shush|hush|silence|shut up|be quiet|(?:cancel|stop)\s+speech|(?:cancel|stop)\s+voice)[\s.!]*$/i.test(userMsg)) {
      try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
      ttsSpeakingRef.current = false;
      setTtsActive(false);
      return;
    }

    // "Cancel focus" / "clear focus" / "unfocus" / "stop focus" — voice-
    // and text-driven way to drop the pinned bucket/transaction focus
    // without having to reach for the mouse.
    if (/^(?:cancel|clear|drop|stop|end|remove|unpin|un)[\s-]?focus\b|^unfocus\b/i.test(userMsg)) {
      setFocus(null, { force: true });
      const ack = "Focus cleared. What next?";
      setMessages(m => [...m, { role: "user", content: userMsg }, { role: "assistant", content: ack }]);
      if (voiceOnRef.current) speakOne(ack);
      return;
    }

    // Live-accountant onboarding coach — fire the user's message to any
    // coach listener on either the onboarding page (Business Profile
    // extractor) OR the dashboard's onboarding-not-complete nudge. In BOTH
    // contexts we suppress the normal LLM chat so the coach's clean
    // confirmation isn't tailed by a yappy generic follow-up (avoids two
    // overlapping TTS voices playing at once).
    if (typeof window !== "undefined") {
      const path = window.location.pathname;
      const onOnboarding = path.startsWith("/onboarding");
      const onDashboardWithNudge =
        path.startsWith("/dashboard") && current && current.onboarding_complete === false;
      if (onOnboarding || onDashboardWithNudge) {
        emitAction("onboarding-user-message", { text: userMsg });
        setMessages(m => [...m, { role: "user", content: userMsg }]);
        return;
      }
    }
    // ------ Cleanup-Copilot inquiry interceptor -----------------------
    // The Transactions page emits `cleanup-inquiry` when the user clicks
    // "Fix now" on the hero band. The AI asked "what are these X <contact>
    // transactions?" — the next user message is the answer. Interpret it
    // as a category description, resolve/create the account, and show a
    // bulk-approve confirmation card.
    if (pendingIntentRef.current?.kind === "cleanup-inquiry") {
      const inq = pendingIntentRef.current;
      pendingIntentRef.current = null;
      setMessages(m => [...m, { role: "user", content: userMsg }]);
      const rawText = userMsg;

      // Skip / defer intent — the user wants to leave this contact alone
      // and jump to the next one in the queue. Recognise natural phrasing
      // ("skip", "skip amazon", "let's skip this", "move on", "next",
      // "pass", "come back later"). We deliberately anchor these so a
      // category name that merely CONTAINS "skip" (unlikely, but e.g.
      // "Skiptown Brewery") isn't caught.
      const skipRe = /^(?:let'?s?\s+|please\s+|just\s+|can\s+we\s+|can\s+you\s+)?(?:skip|move\s+on|move\s+past|pass|pass\s+on|next(?:\s+one)?|not\s+(?:now|yet)|come\s+back\s+(?:to\s+(?:this|it|them|these))?\s*later|hold\s+off|ignore|forget\s+(?:it|this|these|them)|leave\s+(?:it|this|these|them))\b(?!\w)/i;
      if (skipRe.test(rawText)) {
        const contactId = inq?.action?.contact_id;
        const contactName = inq?.action?.contact_name || "this contact";
        const say = `Skipped **${contactName}** — moving on.`;
        setMessages(mm => [...mm, { role: "assistant", content: say }]);
        if (voiceOnRef.current) speakOne(say.replace(/\*\*/g, ""));
        // Auto-advance: same event the confirm cards emit, so the
        // CleanupCopilot dismisses this contact + queues up the next.
        emitAction("cleanup-completed", {
          contact_id: contactId,
          kind: inq?.action?.kind || "contact_in_uncat",
          count: 0,
          skipped: true,
        });
        return;
      }

      // Everything past this point goes to the LLM-backed CPA reviewer.
      // The reviewer classifies intent (categorize / approve_existing /
      // redirect / skip / question / unclear) AND, for categorize, resolves
      // the user's words to real Chart-of-Accounts rows — so we never again
      // create an account literally named "they look good the way they are".
      let review;
      try {
        review = await api.post(`/companies/${currentId}/ai/cpa-review`, {
          message: rawText,
          contact_name: inq?.action?.contact_name || "this contact",
          contact_id: inq?.action?.contact_id || null,
        });
      } catch (e) {
        pendingIntentRef.current = inq;
        const say = "I couldn't reach the AI reviewer just now — mind rephrasing?";
        setMessages(m => [...m, { role: "assistant", content: say }]);
        if (voiceOnRef.current) speakOne(say);
        return;
      }
      const rev = review?.data || {};

      // Skip via LLM (belt & suspenders — the regex above already catches most).
      if (rev.intent === "skip") {
        const say = rev.say || `Skipped **${inq?.action?.contact_name || "this contact"}** — moving on.`;
        setMessages(mm => [...mm, { role: "assistant", content: say }]);
        if (voiceOnRef.current) speakOne(say.replace(/\*\*/g, ""));
        emitAction("cleanup-completed", {
          contact_id: inq?.action?.contact_id,
          kind: inq?.action?.kind || "contact_in_uncat",
          count: 0,
          skipped: true,
        });
        return;
      }

      // Approve-existing: user wants to leave rows with their current
      // categories, just mark them human-reviewed.
      if (rev.intent === "approve_existing") {
        try {
          const list = await api.get(
            `/companies/${currentId}/transactions?contact_id=${inq.action.contact_id}&limit=2000`
          );
          const rows = (list.data.transactions || []).filter(t => !t.human_reviewed);
          const catRows = rows.filter(t => !!t.category_account_id);
          const uncatCount = rows.length - catRows.length;
          // Idempotent path: if nothing is left unreviewed for this contact
          // (already approved in an earlier turn, or all rows are truly
          // uncategorized), still emit cleanup-completed so the copilot
          // dismisses this contact and moves on. This is the primary fix for
          // the "same contact keeps coming back" bug the user reported.
          if (rows.length === 0) {
            const name = inq.action.contact_name || "these transactions";
            const say = `Already approved — moving on from **${name}**.`;
            setMessages(mm => [...mm, { role: "assistant", content: say }]);
            if (voiceOnRef.current) speakOne(say.replace(/\*\*/g, ""));
            emitAction("cleanup-completed", {
              contact_id: inq.action.contact_id,
              kind: inq.action.kind || "contact_split",
              count: 0,
            });
            return;
          }
          if (catRows.length === 0) {
            const say = rev.say || "None of these rows have a category yet — I need one before I can approve them. What account should they post to?";
            pendingIntentRef.current = inq;
            setMessages(mm => [...mm, { role: "assistant", content: say }]);
            if (voiceOnRef.current) speakOne(say);
            return;
          }
          // Bucket by existing category so we can send one apply-bulk-approve
          // per unique account.
          const byAcct = new Map();
          for (const t of catRows) {
            const k = t.category_account_id;
            if (!byAcct.has(k)) byAcct.set(k, []);
            byAcct.get(k).push(t.id);
          }
          const groups = [];
          for (const [acctId, ids] of byAcct.entries()) {
            groups.push({ txn_ids: ids, category_account_id: acctId });
          }
          const res = await api.post(
            `/companies/${currentId}/transactions/apply-multi-bulk-approve-rule`,
            { contact_id: inq.action.contact_id, contact_name: inq.action.contact_name,
              groups, create_rules: false }
          );
          const say = `Approved **${res.data?.updated || 0}** ${inq.action.contact_name} rows with their current categorization.${uncatCount ? ` (${uncatCount} without a category were left alone.)` : ""}`;
          setMessages(mm => [...mm, { role: "assistant", content: say }]);
          if (voiceOnRef.current) speakOne(say.replace(/\*\*/g, ""));
          emitAction("txns:changed");
          emitAction("cleanup-completed", {
            contact_id: inq.action.contact_id,
            kind: inq.action.kind || "contact_in_uncat",
            count: res.data?.updated || 0,
          });
        } catch (e) {
          setMessages(mm => [...mm, { role: "assistant", content: "Sorry — I couldn't approve those rows." }]);
        }
        return;
      }

      // Redirect: user wants to jump to a different contact.
      if (rev.intent === "redirect") {
        const target = rev.resolution?.target_contact_name;
        if (!target) {
          const say = rev.say || "Which contact would you like to look at?";
          pendingIntentRef.current = inq;
          setMessages(mm => [...mm, { role: "assistant", content: say }]);
          if (voiceOnRef.current) speakOne(say);
          return;
        }
        // Dismiss the current contact, then look up the target contact by name.
        emitAction("cleanup-completed", {
          contact_id: inq.action.contact_id,
          kind: inq.action.kind || "contact_in_uncat",
          count: 0,
          skipped: true,
        });
        try {
          const cr = await api.get(`/companies/${currentId}/contacts?q=${encodeURIComponent(target)}&limit=5`);
          const list = cr.data.contacts || [];
          const hit = list.find(c => (c.name || "").toLowerCase() === target.toLowerCase()) || list[0];
          if (hit) {
            // Count unreviewed txns for the target.
            const tr = await api.get(`/companies/${currentId}/transactions?contact_id=${hit.id}&status=unreviewed&limit=1`);
            const total = tr.data.total || tr.data.transactions?.length || 0;
            const say = rev.say || `Jumping to **${hit.name}**.`;
            setMessages(mm => [...mm, { role: "assistant", content: say }]);
            if (voiceOnRef.current) speakOne(say.replace(/\*\*/g, ""));
            emitAction("cleanup-inquiry", {
              action: {
                kind: "contact_in_uncat",
                contact_id: hit.id,
                contact_name: hit.name,
                count: total,
                total_amount: 0,
              },
            });
          } else {
            const say = `I couldn't find a contact called "${target}" — try again with the exact name.`;
            setMessages(mm => [...mm, { role: "assistant", content: say }]);
            if (voiceOnRef.current) speakOne(say);
          }
        } catch (e) {
          setMessages(mm => [...mm, { role: "assistant", content: "Sorry — I couldn't redirect." }]);
        }
        return;
      }

      // Question: user is asking about the txns, not categorizing them.
      // Hand off to the normal chat stream so it can answer conversationally.
      if (rev.intent === "question") {
        pendingIntentRef.current = inq; // leave the queue paused for the follow-up
        // Fall through — the code below will hit the streaming assistant path.
      } else if (rev.intent === "unclear") {
        pendingIntentRef.current = inq;
        const say = rev.say || rev.resolution?.clarifying_question ||
          "I need one or two more words — what category should these fall under?";
        setMessages(mm => [...mm, { role: "assistant", content: say }]);
        if (voiceOnRef.current) speakOne(say);
        return;
      } else if (rev.intent === "categorize") {
        // Build the cleanup-multi-confirm card from the LLM's resolved buckets.
        try {
          const list = await api.get(
            `/companies/${currentId}/transactions?contact_id=${inq.action.contact_id}&limit=2000`
          );
          const rows = (list.data.transactions || []).filter(t => !t.human_reviewed);
          const buckets = rev.resolution?.buckets || [];
          if (buckets.length === 0) {
            pendingIntentRef.current = inq;
            const say = "I understood you wanted to categorize, but couldn't pin down which account. Can you try again?";
            setMessages(mm => [...mm, { role: "assistant", content: say }]);
            if (voiceOnRef.current) speakOne(say);
            return;
          }
          // Assign each row to the first bucket whose predicate matches; rows
          // that match nothing go to the last (base) bucket.
          const bucketState = buckets.map(b => ({
            label: b.label || b.account?.name || "everything else",
            account: b.account || {},
            predicate: b.predicate || null,
            txns: [],
          }));
          const baseBucket = bucketState.find(b => !b.predicate) || bucketState[bucketState.length - 1];
          for (const t of rows) {
            const amt = Math.abs(parseFloat(t.amount) || 0);
            let placed = false;
            for (const b of bucketState) {
              const p = b.predicate;
              if (!p) continue;
              const hit = (p.exactAmount != null && Math.abs(amt - p.exactAmount) < 0.5)
                       || (p.max != null && amt <= p.max && (p.min == null || amt >= p.min))
                       || (p.min != null && amt >= p.min && (p.max == null || amt <= p.max));
              if (hit) { b.txns.push(t); placed = true; break; }
            }
            if (!placed && baseBucket) baseBucket.txns.push(t);
          }
          const preview = bucketState.filter(b => b.txns.length > 0);
          if (preview.length === 0) {
            setMessages(mm => [...mm, { role: "assistant", content: "None of the rows matched the buckets — nothing to do." }]);
            return;
          }
          const totalCount = preview.reduce((s, b) => s + b.txns.length, 0);
          const previewLines = preview.map(b => {
            const a = b.account;
            const label = a.existing_account_id
              ? `${a.code || "?"} ${a.name || "?"}`
              : `${a.code || "new"} ${a.name || "?"} (new)`;
            return `• **${b.txns.length}** ${b.txns.length === 1 ? "row" : "rows"} (${b.label}) → **${label}**`;
          }).join("\n");
          const say = `Here's the plan for **${inq.action.contact_name}**:\n${previewLines}\nApply all ${totalCount}, mark them reviewed, and create rules so future imports do the same?`;
          setMessages(m => [...m, {
            role: "assistant", content: say,
            card: {
              kind: "cleanup-multi-confirm",
              // Adapt the LLM-resolved buckets into the shape the existing
              // InlineConfirmCard handler expects.
              preview: preview.map(b => ({
                label: b.label,
                categoryName: b.account?.name || b.label,
                txns: b.txns,
                amount_min: b.predicate?.min ?? null,
                amount_max: b.predicate?.max ?? null,
                existingAccount: b.account?.existing_account_id ? {
                  id: b.account.existing_account_id,
                  code: b.account.code,
                  name: b.account.name,
                } : null,
                guessType: b.account?.type || "expense",
              })),
              contactId: inq.action.contact_id,
              contactName: inq.action.contact_name,
              count: totalCount,
            },
          }]);
          if (voiceOnRef.current) speakOne(say.replace(/\*\*/g, "").replace(/\n/g, ". "));
          // Keep the inquiry PENDING so the user can refine by typing
          // ("no, only the uncategorized ones as Consulting" / "actually
          // make the big one a Loan"). When they click Yes/No on the card
          // OR skip, the handlers clear pendingIntentRef.
          pendingIntentRef.current = inq;
        } catch (e) {
          setMessages(mm => [...mm, { role: "assistant", content: "Sorry — I couldn't build the plan." }]);
        }
        return;
      }
      // Note: if intent === "question", we intentionally fall through to the
      // regular chat stream below.
    }

    // ------ Voice command dispatch (client-side, zero cost) ------
    // If the user's utterance matches a local intent (route/company switch/
    // meta), execute it immediately and skip the LLM round-trip.
    const cmd = resolveVoiceCommand(userMsg, {
      companies,
      navigate,
      switchCompany,
      clearChat: clearChatMessages,
      focus,
      batchActive: !!batchRef.current,
    });

    // --- Batch resolve mode: entry ---
    if (cmd.handled && cmd.remote === "batch-start") {
      setMessages(m => [...m, { role: "user", content: userMsg }]);
      await startBatch();
      return;
    }
    // --- Batch resolve mode: in-flight ---
    if (cmd.handled && cmd.batch && batchRef.current) {
      setMessages(m => [...m, { role: "user", content: userMsg }]);
      await handleBatchAction(cmd.batch);
      return;
    }

    // --- Weekly review mode: entry ---
    if (cmd.handled && cmd.remote === "review-start") {
      setMessages(m => [...m, { role: "user", content: userMsg }]);
      await startReview();
      return;
    }
    // --- Weekly review mode: in-flight navigation ---
    if (cmd.handled && cmd.review && reviewRef.current) {
      setMessages(m => [...m, { role: "user", content: userMsg }]);
      if (cmd.review === "exit") exitReview();
      else advanceReview(cmd.review); // next / skip / back
      return;
    }
    // If a review-command word (e.g. "next") arrived when NO review is
    // active, fall through to LLM chat so it's not silently swallowed.

    // --- Pending intent follow-ups (confirm / cancel) ---
    if (cmd.handled && cmd.pending === "confirm" && pendingIntentRef.current) {
      const p = pendingIntentRef.current;
      // Special-case our bulk-approve-contact intent: run the dedicated flow.
      if (p.kind === "bulk-approve-contact") {
        pendingIntentRef.current = null;
        setPendingIntent(null);
        setMessages(m => [...m, { role: "user", content: userMsg }]);
        try {
          const sim = p.similar;
          // Fetch every unapproved txn for this contact — sample caps at 5.
          const full = await api.get(
            `/companies/${currentId}/transactions?contact_id=${sim.contact_id}&limit=1000`
          );
          const ids = (full.data.transactions || [])
            .filter((t) => !t.human_reviewed)
            .map((t) => t.id);
          const res = await api.post(
            `/companies/${currentId}/transactions/apply-bulk-approve-rule`,
            {
              txn_ids: ids,
              category_account_id: sim.category_account_id,
              contact_id: sim.contact_id,
              contact_name: sim.contact_name,
              create_rule: !!p.create_rule,
            }
          );
          const updated = res.data?.updated || 0;
          const ruleId = res.data?.rule_id;
          const reply = ruleId
            ? `Approved ${updated} transaction${updated === 1 ? "" : "s"} and created a rule for ${sim.contact_name}.`
            : `Approved ${updated} transaction${updated === 1 ? "" : "s"}.`;
          setMessages(m => [...m, { role: "assistant", content: reply }]);
          if (voiceOnRef.current) speakOne(reply);
          emitAction("txns:changed");
        } catch (e) {
          setMessages(m => [...m, { role: "assistant", content: "Sorry — bulk approval failed." }]);
        }
        return;
      }

      // Transfer-match card: user said "yes" to mark the matching leg too.
      if (p.kind === "transfer-match") {
        pendingIntentRef.current = null;
        setPendingIntent(null);
        setMessages(m => [...m, { role: "user", content: userMsg }]);
        try {
          const legId = p.candidates?.[0]?.id;
          if (!legId) throw new Error("no matching leg");
          await api.post(`/companies/${currentId}/transactions/${p.txnId}/mark-as-transfer`, {
            matching_leg_id: legId,
          });
          const say = "Done — both legs of the transfer are categorized correctly and won't hit the P&L.";
          setMessages(m => [...m, { role: "assistant", content: say }]);
          if (voiceOnRef.current) speakOne(say);
          emitAction("txns:changed");
        } catch (e) {
          setMessages(m => [...m, { role: "assistant", content: "Sorry — I couldn't link the matching leg." }]);
        }
        return;
      }

      // Create-account (standalone) card: user said "yes" to create the account.
      if (p.kind === "create-account") {
        pendingIntentRef.current = null;
        setPendingIntent(null);
        setMessages(m => [...m, { role: "user", content: userMsg }]);
        try {
          const r = await api.post(`/companies/${currentId}/accounts/ensure`, {
            name: p.accountName, type: p.accountType,
          });
          const msg = r.data?.created
            ? `Created ${r.data.code} ${r.data.name} (${r.data.type}).`
            : `${r.data.code} ${r.data.name} already exists — using it.`;
          setMessages(m => [...m, { role: "assistant", content: msg }]);
          if (voiceOnRef.current) speakOne(msg);
          emitAction("txns:changed");
        } catch (e) {
          setMessages(m => [...m, { role: "assistant", content: "Sorry — I couldn't create that account." }]);
        }
        return;
      }

      // Create-then-recat card: user said "yes" to create the account AND
      // reclassify the focused transaction to it in a single step.
      if (p.kind === "create-then-recat") {
        pendingIntentRef.current = null;
        setPendingIntent(null);
        setMessages(m => [...m, { role: "user", content: userMsg }]);
        try {
          const r = await api.post(`/companies/${currentId}/accounts/ensure`, {
            name: p.accountName, type: p.accountType,
          });
          await api.patch(`/companies/${currentId}/transactions/${p.txnId}`, {
            category_account_id: r.data.id,
          });
          const msg = `${r.data.created ? "Created" : "Reusing"} ${r.data.code} ${r.data.name} and recategorized this transaction.`;
          setMessages(m => [...m, { role: "assistant", content: msg }]);
          if (voiceOnRef.current) speakOne(msg);
          emitAction("txns:changed");
          if (inquiryTxnRef.current === p.txnId) resolveInquiry();
        } catch (e) {
          setMessages(m => [...m, { role: "assistant", content: "Sorry — I couldn't create the account or recategorize." }]);
        }
        return;
      }
      setPendingIntent(null);
      setMessages(m => [...m, { role: "user", content: userMsg }]);
      const ok = await submitPendingIntent(p);
      const reply = ok ? "Created." : "I couldn't create that — check the modal.";
      setMessages(m => [...m, { role: "assistant", content: reply }]);
      if (voiceOnRef.current) speakOne(reply);
      return;
    }
    if (cmd.handled && cmd.pending === "cancel") {
      // Special-case: cancelling our bulk-approve card doesn't touch a modal.
      if (pendingIntentRef.current?.kind === "bulk-approve-contact") {
        pendingIntentRef.current = null;
        setMessages(m => [
          ...m,
          { role: "user", content: userMsg },
          { role: "assistant", content: "OK — just the one approved." },
        ]);
        if (voiceOnRef.current) speakOne("OK, just the one approved.");
        return;
      }
      setPendingIntent(null);
      emitAction("close-current-modal");
      setMessages(m => [
        ...m,
        { role: "user", content: userMsg },
        { role: "assistant", content: "Cancelled." },
      ]);
      if (voiceOnRef.current) speakOne("Cancelled");
      // User declined to categorize — end the single-txn inquiry.
      resolveInquiry();
      return;
    }
    if (cmd.handled && cmd.pending) {
      // Confirm/cancel with nothing pending in a modal — but if there's a
      // pinned focused transaction and the utterance is affirmative
      // ("yes", "looks good"), treat it as an approve intent on that row.
      if (cmd.pending === "confirm" && focus?.id) {
        setMessages(m => [...m, { role: "user", content: userMsg }]);
        try {
          const r = await api.post(
            `/companies/${currentId}/transactions/${focus.id}/approve-with-suggestion`
          );
          const { similar, rule_exists } = r.data || {};
          if (!similar || !similar.count) {
            const say = "Approved.";
            setMessages(m => [...m, { role: "assistant", content: say }]);
            if (voiceOnRef.current) speakOne(say);
            emitAction("txns:changed");
            if (inquiryTxnRef.current === focus?.id) resolveInquiry();
            return;
          }
          const catName = similar.category_account_name || similar.category_account_code || "the same category";
          const prompt = `Approved. There ${similar.count === 1 ? "is" : "are"} ${similar.count} other unapproved transaction${similar.count === 1 ? "" : "s"} from **${similar.contact_name}**. Would you like me to categorize them all as **${catName}** and approve them${rule_exists ? "" : ", and create a rule for this contact"}?`;
          pendingIntentRef.current = {
            kind: "bulk-approve-contact",
            similar,
            create_rule: !rule_exists,
          };
          setMessages(m => [...m, {
            role: "assistant",
            content: prompt,
            card: { kind: "bulk-approve-confirm", similar, create_rule: !rule_exists },
          }]);
          if (voiceOnRef.current) speakOne(prompt.replace(/\*\*/g, ""));
          emitAction("txns:changed");
        } catch (e) {
          setMessages(m => [...m, { role: "assistant", content: "Sorry — I couldn't approve that transaction." }]);
        }
        return;
      }
      setMessages(m => [
        ...m,
        { role: "user", content: userMsg },
        { role: "assistant", content: cmd.pending === "confirm" ? "Nothing pending to confirm." : "Nothing to cancel." },
      ]);
      return;
    }

    // --- Remote intent: report narration ---
    if (cmd.handled && cmd.remote === "read-report") {
      setMessages(m => [
        ...m,
        { role: "user", content: userMsg },
        { role: "assistant", content: "Fetching numbers…" },
      ]);
      try {
        const params = new URLSearchParams(cmd.filters || {});
        const r = await api.get(`/companies/${currentId}/reports/${cmd.reportKind}?${params.toString()}`);
        const summary = summarizeReport(cmd.reportKind, cmd.reportName, r.data, cmd.filters);
        setMessages(m => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: summary };
          return copy;
        });
        if (voiceOnRef.current) speakOne(summary);
      } catch (e) {
        setMessages(m => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: "Couldn't pull that report." };
          return copy;
        });
      }
      return;
    }

    // --- Remote intent: comparative report narration ---
    //   "read my P&L vs last quarter" → current summary + top 2 movers.
    if (cmd.handled && cmd.remote === "read-report-compare") {
      setMessages(m => [
        ...m,
        { role: "user", content: userMsg },
        { role: "assistant", content: "Comparing periods…" },
      ]);
      try {
        const nowParams   = new URLSearchParams(cmd.filters || {});
        const priorParams = new URLSearchParams(cmd.priorFilters || {});
        const [now, prior] = await Promise.all([
          api.get(`/companies/${currentId}/reports/${cmd.reportKind}?${nowParams.toString()}`),
          api.get(`/companies/${currentId}/reports/${cmd.reportKind}?${priorParams.toString()}`),
        ]);
        const summary = summarizeReport(cmd.reportKind, cmd.reportName, now.data, cmd.filters);
        const delta   = summarizeComparison(cmd.reportKind, now.data, prior.data, cmd.priorLabel);
        const full    = `${summary} ${delta}`.trim();
        setMessages(m => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: full };
          return copy;
        });
        if (voiceOnRef.current) speakOne(full);
      } catch (e) {
        setMessages(m => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: "Couldn't pull that comparison." };
          return copy;
        });
      }
      return;
    }

    // --- Remote intent (backend parser for creates) ---
    if (cmd.handled && cmd.remote === "intent") {
      setMessages(m => [
        ...m,
        { role: "user", content: userMsg },
        { role: "assistant", content: "Parsing…" },
      ]);
      try {
        const r = await api.post(`/companies/${currentId}/ai/parse-intent`, { text: userMsg });
        const parsed = r.data || {};
        const handled = handleParsedIntent(userMsg, parsed);
        if (!handled) {
          setMessages(m => {
            const copy = [...m];
            copy[copy.length - 1] = { role: "assistant", content: "I couldn't parse that as a create action. Try 'create an invoice for John Doe for 500 dollars'." };
            return copy;
          });
        }
      } catch (e) {
        setMessages(m => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: "Sorry — parsing failed." };
          return copy;
        });
      }
      return;
    }

    // --- Remote intent: open account detail (Balance Sheet drilldown by voice) ---
    if (cmd.handled && cmd.remote === "open-account") {
      setMessages(m => [...m, { role: "user", content: userMsg }]);
      try {
        const r = await api.get(`/companies/${currentId}/accounts`);
        const accts = (r.data.accounts || []);
        const needle = (cmd.target || "").toLowerCase().replace(/[^a-z0-9 ]+/g, "").trim();
        // Try (1) exact code match, (2) code prefix, (3) name/fuzzy match.
        let hit = accts.find(a => (a.code || "").toLowerCase() === needle);
        if (!hit) hit = accts.find(a => (a.code || "").toLowerCase().startsWith(needle));
        if (!hit) {
          const words = needle.split(/\s+/).filter(Boolean);
          let best = null, bestScore = 0;
          for (const a of accts) {
            const n = (a.name || "").toLowerCase();
            if (!n) continue;
            let score = 0;
            if (n === needle) score = 1000;
            else if (n.includes(needle) || needle.includes(n)) score = 500;
            else score = words.reduce((s, w) => s + (n.includes(w) ? 1 : 0), 0);
            if (score > bestScore) { bestScore = score; best = a; }
          }
          if (best && bestScore >= (words.length || 1)) hit = best;
        }
        if (hit) {
          const say = `Opening ${hit.code} ${hit.name}`;
          setMessages(m => [...m, { role: "assistant", content: say }]);
          if (voiceOnRef.current) speakOne(say);
          const params = [`account=${hit.id}`];
          if (cmd.start) params.push(`start=${encodeURIComponent(cmd.start)}`);
          if (cmd.end)   params.push(`end=${encodeURIComponent(cmd.end)}`);
          navigate(`/reports/account-detail?${params.join("&")}`);
        } else {
          const say = `I couldn't find an account matching "${cmd.target}".`;
          setMessages(m => [...m, { role: "assistant", content: say }]);
          if (voiceOnRef.current) speakOne(say);
        }
      } catch (e) {
        setMessages(m => [...m, { role: "assistant", content: "Couldn't look up that account." }]);
      }
      return;
    }

    // --- Remote intent: approve the focused transaction, then offer bulk-approve
    //     for every OTHER unapproved txn with the same contact + rule creation. ---
    // --- Remote intent: approve the focused transaction, then offer bulk-approve
    //     for every OTHER unapproved txn with the same contact + rule creation. ---
    if (cmd.handled && cmd.remote === "approve-bucket") {
      setMessages(m => [...m, { role: "user", content: userMsg }]);
      // Hand off to the mega-approve modal which owns the bucket-level
      // approve function (including the "auto-create rule" toggle state).
      emitAction("mega-approve-bucket", { key: cmd.bucket.key });
      const say = `Approving ${cmd.bucket.count} ${cmd.bucket.contact_name} row${cmd.bucket.count === 1 ? "" : "s"}.`;
      setMessages(m => [...m, { role: "assistant", content: say }]);
      if (voiceOnRef.current) speakOne(say);
      // Clear focus once approved — the row is about to disappear.
      setFocus(null, { force: true });
      return;
    }

    if (cmd.handled && cmd.remote === "approve-focused") {
      setMessages(m => [...m, { role: "user", content: userMsg }]);
      try {
        const r = await api.post(
          `/companies/${currentId}/transactions/${cmd.txnId}/approve-with-suggestion`
        );
        const { approved, similar, rule_exists } = r.data || {};
        // Case 1: no meaningful bulk candidates — just confirm the single approval.
        if (!similar || !similar.count) {
          const say = "Approved.";
          setMessages(m => [...m, { role: "assistant", content: say }]);
          if (voiceOnRef.current) speakOne(say);
          emitAction("txns:changed");
          return;
        }
        // Case 2: offer the follow-up. Rendered as an interactive card in the
        // assistant message stream — the user answers yes/no via buttons OR
        // by saying "yes" / "no" (see the `pending: bulk-approve-contact` branch).
        const catName = similar.category_account_name || similar.category_account_code || "the same category";
        const prompt = `Approved. There ${similar.count === 1 ? "is" : "are"} ${similar.count} other unapproved transaction${similar.count === 1 ? "" : "s"} from **${similar.contact_name}**. Would you like me to categorize them all as **${catName}** and approve them${rule_exists ? "" : ", and create a rule for this contact"}?`;
        pendingIntentRef.current = {
          kind: "bulk-approve-contact",
          similar,
          create_rule: !rule_exists,
        };
        setMessages(m => [...m, {
          role: "assistant",
          content: prompt,
          card: {
            kind: "bulk-approve-confirm",
            similar,
            create_rule: !rule_exists,
          },
        }]);
        if (voiceOnRef.current) speakOne(prompt.replace(/\*\*/g, ""));
        emitAction("txns:changed");
      } catch (e) {
        setMessages(m => [...m, { role: "assistant", content: "Sorry — I couldn't approve that transaction." }]);
      }
      return;
    }

    if (cmd.handled && cmd.remote === "unapprove-focused") {
      setMessages(m => [...m, { role: "user", content: userMsg }]);
      try {
        await api.post(`/companies/${currentId}/transactions/${cmd.txnId}/unapprove`);
        const say = "Unapproved.";
        setMessages(m => [...m, { role: "assistant", content: say }]);
        if (voiceOnRef.current) speakOne(say);
        emitAction("txns:changed");
      } catch (e) {
        setMessages(m => [...m, { role: "assistant", content: "Sorry — I couldn't unapprove that." }]);
      }
      return;
    }

    // --- Remote intent: recategorize the focused transaction to a named account. ---
    if (cmd.handled && cmd.remote === "recategorize-focused") {
      setMessages(m => [...m, { role: "user", content: userMsg }]);
      try {
        // Look up an account whose name/code matches the spoken target.
        const r = await api.get(`/companies/${currentId}/accounts`);
        const accts = r.data.accounts || [];
        const needle = cmd.targetName.toLowerCase();
        // Match priority: exact name → exact code → name-starts-with → contains.
        let hit = accts.find(a => (a.name || "").toLowerCase() === needle);
        if (!hit) hit = accts.find(a => (a.code || "") === cmd.targetName);
        if (!hit) hit = accts.find(a => (a.name || "").toLowerCase().startsWith(needle));
        if (!hit) hit = accts.find(a => (a.name || "").toLowerCase().includes(needle));
        if (!hit) {
          // Offer to CREATE it.
          setMessages(m => [...m, {
            role: "assistant",
            content: `I couldn't find an account called "${cmd.targetName}". Want me to create it as an expense category and use it here?`,
            card: {
              kind: "create-account-then-recategorize",
              accountName: cmd.targetName,
              accountType: "expense",
              txnId: cmd.txnId,
            },
          }]);
          pendingIntentRef.current = { kind: "create-then-recat", accountName: cmd.targetName, accountType: "expense", txnId: cmd.txnId };
          return;
        }
        // PATCH the transaction.
        await api.patch(`/companies/${currentId}/transactions/${cmd.txnId}`, {
          category_account_id: hit.id,
        });
        const say = `Recategorized to ${hit.code} ${hit.name}.`;
        setMessages(m => [...m, { role: "assistant", content: say }]);
        if (voiceOnRef.current) speakOne(say);
        emitAction("txns:changed");
        if (inquiryTxnRef.current === cmd.txnId) resolveInquiry();
      } catch (e) {
        setMessages(m => [...m, { role: "assistant", content: "Sorry — I couldn't recategorize that." }]);
      }
      return;
    }

    // --- Remote intent: create a new Chart-of-Accounts entry. ---
    if (cmd.handled && cmd.remote === "create-account") {
      setMessages(m => [...m, {
        role: "user", content: userMsg,
      }, {
        role: "assistant",
        content: `Create a new **${cmd.accountType}** account named **${cmd.accountName}**?`,
        card: {
          kind: "create-account-confirm",
          accountName: cmd.accountName,
          accountType: cmd.accountType,
        },
      }]);
      pendingIntentRef.current = { kind: "create-account", accountName: cmd.accountName, accountType: cmd.accountType };
      return;
    }

    // --- Remote intent: mark focused txn as an internal transfer. ---
    if (cmd.handled && cmd.remote === "mark-transfer") {
      setMessages(m => [...m, { role: "user", content: userMsg }]);
      try {
        const r = await api.post(`/companies/${currentId}/transactions/${cmd.txnId}/mark-as-transfer`, {});
        const { transfer_account, candidates } = r.data || {};
        const acctStr = transfer_account ? `${transfer_account.code} ${transfer_account.name}` : "Transfer";
        if (!candidates || candidates.length === 0) {
          const say = `Done — recategorized to ${acctStr}. No matching leg found on another bank account within ±3 days.`;
          setMessages(m => [...m, { role: "assistant", content: say }]);
          if (voiceOnRef.current) speakOne(say);
          emitAction("txns:changed");
          if (inquiryTxnRef.current === cmd.txnId) resolveInquiry();
          return;
        }
        const first = candidates[0];
        const bank = first.bank_account_name || "another account";
        const prompt = `Recategorized to **${acctStr}**. I also see a matching **${bank}** entry on **${first.date}** for the opposite amount — want me to mark that as the other leg of the transfer too?`;
        setMessages(m => [...m, {
          role: "assistant",
          content: prompt,
          card: {
            kind: "transfer-match-confirm",
            txnId: cmd.txnId,
            candidates,
          },
        }]);
        pendingIntentRef.current = { kind: "transfer-match", txnId: cmd.txnId, candidates };
        if (voiceOnRef.current) speakOne(prompt.replace(/\*\*/g, ""));
        emitAction("txns:changed");
      } catch (e) {
        setMessages(m => [...m, { role: "assistant", content: "Sorry — I couldn't mark that as a transfer." }]);
      }
      return;
    }

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
          focused_bucket: focus?.bucket ? {
            contact_name: focus.contact_name,
            count: focus.count,
            amount: focus.amount,
            account_code: focus.account_code,
            account_name: focus.account_name,
          } : null,
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
    const clean = stripMarkdownForSpeech(text);
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
    u.onstart = () => { ttsSpeakingRef.current = true; setTtsActive(true); };
    const finish = () => {
      // Only clear the flag when the browser queue is genuinely empty —
      // otherwise the NEXT chunked utterance (which fires start slightly
      // after this one's end) would race with a stale-false flag.
      const ss = window.speechSynthesis;
      const idle = !ss.speaking && !ss.pending;
      if (idle) {
        ttsSpeakingRef.current = false;
        setTtsActive(false);
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
    <aside
      className="shrink-0 border-l bg-white flex flex-col relative z-[60]"
      style={{ width: `${panelWidth}px` }}
      data-testid="ai-panel"
    >
      {/* Drag handle — 6px wide invisible strip along the left edge. */}
      <div
        onMouseDown={startResize}
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        data-testid="ai-panel-resize"
        className="absolute left-0 top-0 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-indigo-300/40 z-[65]"
      />
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
        <button
          onClick={clearChatMessages}
          data-testid="ai-chat-clear"
          className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
          title="Clear conversation"
        >
          <Trash2 size={15} />
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
        <div className="mx-3 mt-3 border rounded-md p-2.5 bg-indigo-50/50 border-indigo-200 text-xs" data-testid="ai-focus-card">
          {focus.bucket ? (
            <>
              <div className="font-medium text-slate-700 mb-0.5">Focused bucket</div>
              <div className="text-slate-600 truncate">
                <b>{focus.contact_name}</b> · {focus.count} row{focus.count === 1 ? "" : "s"} · <span className="font-mono-num">${Math.abs(focus.amount).toLocaleString("en-US", {maximumFractionDigits: 0})}</span>
                {focus.account_code && (
                  <> · <span className="text-slate-500">{focus.account_code} · {focus.account_name}</span></>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="font-medium text-slate-700 mb-0.5">Focused transaction</div>
              <div className="text-slate-600 truncate">
                {focus.merchant} · <span className="font-mono-num">${Math.abs(focus.amount).toFixed(2)}</span> · {focus.date}
              </div>
            </>
          )}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {(() => {
          // Which message should wear the rainbow outline? The most-recent
          // assistant message, IF nothing from the user has come in since it.
          // As soon as the user sends anything, the outline vanishes until
          // the AI speaks again.
          let latestUnansweredAssistant = -1;
          for (let j = messages.length - 1; j >= 0; j--) {
            if (messages[j].role === "user") break;
            if (messages[j].role === "assistant") { latestUnansweredAssistant = j; break; }
          }
          return messages.map((m, i) => (
          <div key={i} data-testid={TID.aiChatMessage}
               className={`max-w-[92%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed ${
                 m.role === "user" ? "chat-bubble-user ml-auto" : "chat-bubble-ai"
               } ${i === latestUnansweredAssistant ? "ai-shimmer-bubble" : ""}`}>
            {m.content || (streaming && i === messages.length - 1 ? "…" : "")}
            {m.splitHint && (
              <SplitHintForm
                hint={m.splitHint}
                onApply={(belowCat, aboveCat) => {
                  const t = m.splitHint.threshold;
                  // NOTE: template uses "above is X" (no second threshold)
                  // so the range regex's optional "is/=" doesn't get fooled
                  // by "$100 is" appearing twice in the input.
                  const templated = `under $${t} is ${belowCat}, above is ${aboveCat}`;
                  setInput(templated);
                  setMessages(mm => mm.map((mm2, j) => j === i ? { ...mm2, splitHint: null } : mm2));
                  // Use sendRef so we invoke the LATEST send() closure —
                  // it will read the input state committed by setInput above.
                  setTimeout(() => sendRef.current?.(), 30);
                }}
                onDismiss={() => {
                  setMessages(mm => mm.map((mm2, j) => j === i ? { ...mm2, splitHint: null } : mm2));
                }}
              />
            )}
            {m.showSkip && (
              <div className="mt-1.5" data-testid="cleanup-skip-hint">
                <button
                  data-testid="cleanup-skip-btn"
                  onClick={() => {
                    // Same flow as typing "skip <contact>" — clears the
                    // pending inquiry, notifies the copilot, auto-advances.
                    pendingIntentRef.current = null;
                    const name = m.skipContact?.name || "this contact";
                    const say = `Skipped **${name}** — moving on.`;
                    setMessages(mm => {
                      const cleared = mm.map((mm2, j) => j === i ? { ...mm2, showSkip: false, splitHint: null } : mm2);
                      return [...cleared, { role: "assistant", content: say }];
                    });
                    if (voiceOnRef.current) speakOne(say.replace(/\*\*/g, ""));
                    emitAction("cleanup-completed", {
                      contact_id: m.skipContact?.id,
                      kind: m.skipContact?.kind || "contact_in_uncat",
                      count: 0,
                      skipped: true,
                    });
                  }}
                  className="text-[11px] px-2 py-0.5 rounded-full border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                >
                  or skip {m.skipContact?.name || "this contact"} →
                </button>
              </div>
            )}
            {m.card?.kind === "bulk-approve-confirm" && (
              <BulkApproveCard
                similar={m.card.similar}
                createRule={m.card.create_rule}
                currentId={currentId}
                onDone={(msg) => {
                  pendingIntentRef.current = null;
                  setMessages(mm => [...mm, { role: "assistant", content: msg }]);
                  if (voiceOnRef.current) speakOne(msg);
                  emitAction("txns:changed");
                }}
                onDismiss={() => {
                  pendingIntentRef.current = null;
                  setMessages(mm => [...mm, { role: "assistant", content: "OK — just the one approved." }]);
                  if (voiceOnRef.current) speakOne("OK, just the one approved.");
                }}
              />
            )}
            {m.card?.kind === "create-account-confirm" && (
              <InlineConfirmCard
                testId="create-account-card"
                tone="indigo"
                onConfirm={async () => {
                  const r = await api.post(`/companies/${currentId}/accounts/ensure`, {
                    name: m.card.accountName, type: m.card.accountType,
                  });
                  pendingIntentRef.current = null;
                  const msg = r.data?.created
                    ? `Created ${r.data.code} ${r.data.name} (${r.data.type}).`
                    : `${r.data.code} ${r.data.name} already exists — using it.`;
                  setMessages(mm => [...mm, { role: "assistant", content: msg }]);
                  if (voiceOnRef.current) speakOne(msg);
                  emitAction("txns:changed");
                }}
                onDismiss={() => {
                  pendingIntentRef.current = null;
                  setMessages(mm => [...mm, { role: "assistant", content: "OK — no new account created." }]);
                }}
              />
            )}
            {m.card?.kind === "create-account-then-recategorize" && (
              <InlineConfirmCard
                testId="create-then-recat-card"
                tone="indigo"
                confirmLabel="Yes, create + recategorize"
                onConfirm={async () => {
                  const r = await api.post(`/companies/${currentId}/accounts/ensure`, {
                    name: m.card.accountName, type: m.card.accountType,
                  });
                  await api.patch(`/companies/${currentId}/transactions/${m.card.txnId}`, {
                    category_account_id: r.data.id,
                  });
                  pendingIntentRef.current = null;
                  const msg = `${r.data.created ? "Created" : "Reusing"} ${r.data.code} ${r.data.name} and recategorized this transaction.`;
                  setMessages(mm => [...mm, { role: "assistant", content: msg }]);
                  if (voiceOnRef.current) speakOne(msg);
                  emitAction("txns:changed");
                }}
                onDismiss={() => {
                  pendingIntentRef.current = null;
                  setMessages(mm => [...mm, { role: "assistant", content: "OK — no changes made." }]);
                }}
              />
            )}
            {m.card?.kind === "transfer-match-confirm" && (
              <InlineConfirmCard
                testId="transfer-match-card"
                tone="fuchsia"
                confirmLabel="Yes, mark that leg too"
                onConfirm={async () => {
                  const legId = m.card.candidates[0]?.id;
                  if (!legId) return;
                  await api.post(`/companies/${currentId}/transactions/${m.card.txnId}/mark-as-transfer`, {
                    matching_leg_id: legId,
                  });
                  pendingIntentRef.current = null;
                  const msg = "Done — both legs of the transfer are now categorized correctly and won't hit the P&L.";
                  setMessages(mm => [...mm, { role: "assistant", content: msg }]);
                  if (voiceOnRef.current) speakOne(msg);
                  emitAction("txns:changed");
                }}
                onDismiss={() => {
                  pendingIntentRef.current = null;
                  setMessages(mm => [...mm, { role: "assistant", content: "OK — only this side is marked as a transfer." }]);
                }}
              />
            )}
            {m.card?.kind === "cleanup-multi-confirm" && (
              <InlineConfirmCard
                testId="cleanup-multi-card"
                tone="emerald"
                confirmLabel={`Yes, categorize all ${m.card.count} + create rules`}
                onConfirm={async () => {
                  // 1. Ensure every bucket's category account exists.
                  const groups = [];
                  for (const b of m.card.preview) {
                    let acct = b.existingAccount;
                    if (!acct) {
                      const r = await api.post(`/companies/${currentId}/accounts/ensure`, {
                        name: (b.categoryName || "").replace(/\b(\w)/g, (c) => c.toUpperCase()),
                        type: b.guessType,
                      });
                      acct = r.data;
                    }
                    groups.push({
                      txn_ids: b.txns.map((t) => t.id),
                      category_account_id: acct.id,
                      amount_min: b.amount_min ?? null,
                      amount_max: b.amount_max ?? null,
                      rule_label: b.label,
                    });
                  }
                  // 2. Apply all buckets in one call.
                  const res = await api.post(
                    `/companies/${currentId}/transactions/apply-multi-bulk-approve-rule`,
                    {
                      contact_id: m.card.contactId,
                      contact_name: m.card.contactName,
                      groups,
                      create_rules: true,
                    }
                  );
                  const updated = res.data?.updated || 0;
                  const rules = (res.data?.rule_ids || []).length;
                  const say = `Done — recategorized ${updated} ${m.card.contactName} transactions across ${groups.length} categor${groups.length === 1 ? "y" : "ies"}${rules ? ` and created ${rules} rule${rules === 1 ? "" : "s"}` : ""}.`;
                  setMessages(mm => [...mm, { role: "assistant", content: say }]);
                  if (voiceOnRef.current) speakOne(say);
                  emitAction("txns:changed");
                  // Auto-advance: nudge the Cleanup Copilot to serve up the
                  // next contact from the top-actions queue.
                  emitAction("cleanup-completed", {
                    contact_id: m.card.contactId,
                    kind: "contact_in_uncat",
                    count: updated,
                  });
                }}
                onDismiss={() => {
                  pendingIntentRef.current = {
                    kind: "cleanup-inquiry",
                    action: {
                      kind: "contact_in_uncat",
                      contact_id: m.card.contactId,
                      contact_name: m.card.contactName,
                      count: m.card.count,
                    },
                  };
                  const say = `OK — how would you like to categorize the ${m.card.count} ${m.card.contactName} transactions instead?`;
                  setMessages(mm => [...mm, { role: "assistant", content: say }]);
                  if (voiceOnRef.current) speakOne(say);
                }}
              />
            )}
            {m.card?.kind === "cleanup-bulk-confirm" && (
              <InlineConfirmCard
                testId="cleanup-bulk-card"
                tone="emerald"
                confirmLabel={m.card.existingAccount ? `Yes, categorize all ${m.card.count} + create rule` : `Yes, create + categorize all + rule`}
                onConfirm={async () => {
                  // 1. Ensure the account exists (create if we didn't find a match).
                  let acct = m.card.existingAccount;
                  if (!acct) {
                    const r = await api.post(`/companies/${currentId}/accounts/ensure`, {
                      name: m.card.targetName.replace(/\b(\w)/g, (c) => c.toUpperCase()),
                      type: m.card.guessType,
                    });
                    acct = r.data;
                  }
                  // 2. Grab every unapproved txn for this contact.
                  const list = await api.get(
                    `/companies/${currentId}/transactions?contact_id=${m.card.contactId}&limit=2000`
                  );
                  const ids = (list.data.transactions || [])
                    .filter(t => !t.human_reviewed)
                    .map(t => t.id);
                  // 3. Bulk-approve with rule creation.
                  const res = await api.post(
                    `/companies/${currentId}/transactions/apply-bulk-approve-rule`,
                    {
                      txn_ids: ids,
                      category_account_id: acct.id,
                      contact_id: m.card.contactId,
                      contact_name: m.card.contactName,
                      create_rule: true,
                    }
                  );
                  const updated = res.data?.updated || 0;
                  const say = `Done — recategorized and approved ${updated} ${m.card.contactName} transactions as ${acct.code} ${acct.name}${res.data?.rule_id ? " and created a rule so future imports auto-post here" : ""}.`;
                  setMessages(mm => [...mm, { role: "assistant", content: say }]);
                  if (voiceOnRef.current) speakOne(say);
                  emitAction("txns:changed");
                  emitAction("cleanup-completed", {
                    contact_id: m.card.contactId,
                    kind: "contact_in_uncat",
                    count: updated,
                  });
                }}
                onDismiss={() => {
                  // Re-open the inquiry so the user can give a different category
                  // or add more detail about the transactions.
                  pendingIntentRef.current = {
                    kind: "cleanup-inquiry",
                    action: {
                      kind: "contact_in_uncat",
                      contact_id: m.card.contactId,
                      contact_name: m.card.contactName,
                      count: m.card.count,
                    },
                  };
                  const say = `OK — what should I categorize the ${m.card.count} ${m.card.contactName} transactions as instead? Or tell me more about what they are.`;
                  setMessages(mm => [...mm, { role: "assistant", content: say }]);
                  if (voiceOnRef.current) speakOne(say);
                }}
              />
            )}
          </div>
        ));
        })()}
      </div>

      <div className="border-t p-3">
        {batch && (() => {
          const cur = batch.txns[batch.idx] || {};
          return (
            <div
              className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2"
              data-testid="ai-batch-card"
            >
              <div className="flex items-center gap-2 mb-1">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                <span className="text-[11px] uppercase tracking-wide font-semibold text-amber-900">
                  Batch Resolve · {batch.idx + 1} of {batch.txns.length}
                </span>
                <button
                  data-testid="ai-batch-exit"
                  onClick={batchExitBtn}
                  className="ml-auto text-[11px] text-amber-900/70 hover:text-amber-950"
                >
                  Exit
                </button>
              </div>
              <div className="text-[13px] font-medium text-amber-950 leading-tight">
                {(cur.merchant || cur.contact_name || "Unknown")}
                <span className="ml-1 text-amber-800/80">
                  {typeof cur.amount === "number"
                    ? ` · $${Math.abs(cur.amount).toFixed(2)}${cur.amount < 0 ? " out" : " in"}`
                    : ""}
                </span>
              </div>
              <div className="text-[11px] text-amber-800 mt-0.5">
                Suggested: <b>{cur.category_account_name || "Uncategorized"}</b>
              </div>
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                <button
                  data-testid="ai-batch-accept"
                  onClick={batchAcceptBtn}
                  className="text-[11px] px-2 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-700"
                >
                  ✓ Accept
                </button>
                <button
                  data-testid="ai-batch-skip"
                  onClick={batchSkipBtn}
                  className="text-[11px] px-2 py-0.5 rounded text-amber-900 hover:bg-amber-100"
                >
                  Skip
                </button>
                <span className="text-[10px] text-amber-800/70 ml-1">
                  say <b>"yes"</b> · <b>"skip"</b> · <b>"no, it's meals"</b>
                </span>
              </div>
            </div>
          );
        })()}
        {review && (
          <div
            className="mb-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-2"
            data-testid="ai-review-card"
          >
            <div className="flex items-center gap-2 mb-1">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-[11px] uppercase tracking-wide font-semibold text-emerald-800">
                Review Mode · Step {review.idx + 1} of {review.steps.length}
              </span>
              <button
                data-testid="ai-review-exit"
                onClick={exitReview}
                className="ml-auto text-[11px] text-emerald-800/70 hover:text-emerald-900"
              >
                Exit
              </button>
            </div>
            <div className="text-[13px] font-medium text-emerald-950 leading-tight">
              {review.steps[review.idx]?.title}
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              <button
                data-testid="ai-review-back"
                onClick={() => advanceReview("back")}
                disabled={review.idx === 0}
                className="text-[11px] px-2 py-0.5 rounded text-emerald-900 hover:bg-emerald-100 disabled:opacity-40"
              >
                ← Back
              </button>
              <button
                data-testid="ai-review-next"
                onClick={() => advanceReview("next")}
                className="text-[11px] px-2 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700"
              >
                Next →
              </button>
              <span className="text-[11px] text-emerald-800/70 ml-1">
                or say <b>"next"</b> · <b>"back"</b> · <b>"exit"</b>
              </span>
            </div>
          </div>
        )}
        {pendingIntent && (
          <div
            className="mb-2 flex items-center gap-2 rounded-md bg-indigo-50 border border-indigo-200 px-2.5 py-2"
            data-testid="ai-pending-intent"
          >
            <Sparkles size={13} className="text-indigo-600 flex-shrink-0" />
            <span className="text-xs text-indigo-900 flex-1 leading-tight">
              Pending: <b>{pendingIntent.intent.replace(/_/g, " ")}</b>
              {pendingIntent.prefill?.contact_name ? ` · ${pendingIntent.prefill.contact_name}` : ""}
              {pendingIntent.prefill?.amount ? ` · $${pendingIntent.prefill.amount}` : ""}
            </span>
            <button
              data-testid="ai-pending-confirm"
              onClick={async () => {
                const p = pendingIntent;
                setPendingIntent(null);
                const ok = await submitPendingIntent(p);
                const reply = ok ? "Created." : "Couldn't create — check the modal.";
                setMessages(m => [...m, { role: "assistant", content: reply }]);
                if (voiceOnRef.current) speakOne(reply);
              }}
              className="text-[11px] px-2 py-0.5 rounded bg-indigo-600 text-white hover:bg-indigo-700"
            >
              Confirm
            </button>
            <button
              data-testid="ai-pending-cancel"
              onClick={() => {
                setPendingIntent(null);
                emitAction("close-current-modal");
              }}
              className="text-[11px] px-2 py-0.5 rounded text-indigo-800 hover:bg-indigo-100"
            >
              Cancel
            </button>
          </div>
        )}
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
        {ttsActive && (
          <button
            data-testid="ai-stop-speaking"
            onClick={() => {
              // Kill any queued + currently-speaking utterances immediately.
              try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
              ttsSpeakingRef.current = false;
              setTtsActive(false);
            }}
            className="mb-2 w-full flex items-center justify-center gap-2 rounded-md bg-red-600 hover:bg-red-700 text-white text-xs font-semibold px-2.5 py-2 shadow-sm transition"
            title='Stop the AI from talking (or say "stop" / "quiet")'
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-white/60 opacity-75 animate-ping" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
            </span>
            Stop AI speaking
            <span className="text-[10px] font-normal opacity-80">(or say "stop")</span>
          </button>
        )}
        {focus && focusPinned && (
          <button
            data-testid="ai-cancel-focus"
            onClick={() => setFocus(null, { force: true })}
            className="mb-2 w-full flex items-center justify-center gap-2 rounded-md border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-medium px-2.5 py-1.5 transition"
            title="Stop focusing on this transaction / bucket"
          >
            <X size={12} /> Cancel focus
            <span className="text-[10px] text-indigo-500 font-normal">
              (or say "cancel focus")
            </span>
          </button>
        )}
        <div className="flex gap-2">
          <MicButton
            mode={micMode}
            listening={listening}
            streaming={streaming}
            ttsSpeaking={ttsSpeakingRef.current}
            onCycle={() => {
              // Simple binary toggle: off ↔ open (live mic).
              setMicMode(prev => (prev === "off" ? "open" : "off"));
            }}
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
    'Try: "walk me through the books"  (paced review)',
    'Try: "let\'s clear the flagged transactions"',
    'Try: "read my P&L vs last quarter"',
    'Try: "why are my liabilities negative?"',
    'Try: "transactions for Walmart"',
    'Try: "open the July 15th McDonald\'s transaction"',
    'Try: "create an invoice for John Doe for 500 dollars"',
    'Try: "overdue invoices"',
    'Say "looks good" to save a draft · "stop" cancels speech',
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


function MicButton({ mode, listening, streaming, ttsSpeaking, onCycle }) {
  // Simplified click-to-toggle: mic is either OFF or LIVE (open-mic).
  // No push-to-talk. One click flips the state.
  const isLive = mode === "open" || mode === "ptt"; // treat legacy 'ptt' as live
  const armed = isLive && listening;
  const cls = ttsSpeaking
    ? "border-slate-200 bg-slate-100 text-slate-400"
    : armed
      ? "bg-red-500 border-red-500 text-white"
      : isLive
        ? "border-red-300 text-red-600 hover:bg-red-50"
        : "border-slate-200 text-slate-600 hover:bg-slate-50";
  const title = isLive
    ? "Voice on — click to mute"
    : "Voice off — click to go live";
  return (
    <div className="relative">
      <button
        data-testid="ai-chat-mic"
        onClick={(e) => { e.preventDefault(); onCycle(); }}
        disabled={streaming}
        className={`relative w-9 h-9 flex items-center justify-center rounded-md border transition select-none ${cls}`}
        title={title}
        aria-pressed={isLive}
      >
        {armed ? <MicOff size={15} /> : <Mic size={15} />}
      </button>
      {isLive && !ttsSpeaking && (
        <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white" />
      )}
    </div>
  );
}

