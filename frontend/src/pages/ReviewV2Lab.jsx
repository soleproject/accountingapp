/**
 * Review v2 Lab — parallel 3-stage batch review UI at
 *   /accounting/lab/review-v2
 *
 * Lives alongside the existing 11-item production flow (never modifies
 * it). Reshapes the current batch data via `transformBatchToV2` so we
 * can iterate on the redesign without touching the client route.
 *
 * "Preview as client" toggle strips CPA affordances (unsupported-data
 * banner, keyboard legend, stage jump) so the CPA can see exactly what
 * the client will experience once a magic-link wrapper is added.
 *
 * Components are intentionally kept in one file for the MVP so the
 * whole flow is easy to read + rip out. When we wire the real
 * `/client-review/v2/{token}` route, this page becomes a shell that
 * imports the pieces.
 */
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { transformBatchToV2, cleanMerchant } from "@/lib/reviewV2Transform";
import { toast } from "sonner";
import {
  CheckCircle2, Circle, AlertTriangle, ArrowLeftRight,
  Loader2, HelpCircle, ExternalLink, Info, Keyboard,
  ArrowDownRight, ArrowUpRight, ChevronRight, Send, Mic, MicOff,
  Sparkles, X,
} from "lucide-react";

// ---------------------------------------------------------------- Page

export default function ReviewV2Lab() {
  const { currentId, current } = useCompany();
  const isLabV3 = (current?.categorization_mode === "lab_v3");
  const [batch, setBatch]         = useState(null);
  const [ledgerPairs, setLedger]  = useState([]);
  const [audit, setAudit]         = useState(null);   // verification-based audit
  const [labV3Queue, setLabV3Queue] = useState(null); // lab_v3 queue payload
  const [loading, setLoading]     = useState(true);
  const [stage, setStage]         = useState(1);
  const [cursor, setCursor]       = useState(0);
  const [answers, setAnswers]     = useState({});   // item_id → answer_key
  const [reloadTick, setReloadTick] = useState(0);  // bump to refetch after answer
  const [stickyCardKey, setStickyCardKey] = useState(null); // pin cursor to same card across reloads

  useEffect(() => {
    if (!currentId) return;
    let ok = true;
    setLoading(true);

    if (isLabV3) {
      // Lab v3 mode — single call to the linkage endpoint. It returns
      // the full 3-stage model + progress + auto-handled counters.
      api.get(`/companies/${currentId}/reviewv2/lab-v3-queue`)
        .then(r => {
          if (!ok) return;
          setLabV3Queue(r.data || null);
          setBatch(null); setLedger([]); setAudit(null);
        })
        .catch(() => { if (ok) setLabV3Queue(null); })
        .finally(() => { if (ok) setLoading(false); });
      return () => { ok = false; };
    }

    // Standard mode — legacy 3-fetch parallel load.
    Promise.all([
      api.get(`/client-review/latest-for-company/${currentId}`)
        .then(async (r) => {
          if (!r.data?.has_pending) return null;
          const full = await api.get(`/client-review/by-id/${r.data.batch_id}`)
                                .catch(() => ({ data: null }));
          return full.data || null;
        })
        .catch(() => null),
      api.get(`/companies/${currentId}/reviewv2/account-pairs`)
        .then(r => r.data?.pairs || [])
        .catch(() => []),
      api.get(`/companies/${currentId}/reviewv2/audit-preview`)
        .then(r => r.data)
        .catch(() => null),
    ]).then(([b, pairs, aud]) => {
      if (!ok) return;
      setBatch(b);
      setLedger(pairs);
      setAudit(aud);
      setLabV3Queue(null);
    }).finally(() => { if (ok) setLoading(false); });
    return () => { ok = false; };
  }, [currentId, isLabV3, reloadTick]);

  const model = useMemo(() => {
    if (isLabV3 && labV3Queue) {
      // Lab v3 payload already matches transformBatchToV2's shape.
      return {
        stage1_accounts: labV3Queue.stage1_accounts || [],
        stage2_patterns: labV3Queue.stage2_patterns || [],
        stage3_oneoffs:  labV3Queue.stage3_oneoffs  || [],
        progress:        labV3Queue.progress || { pct_confirmed: 0, questions_left: 0 },
        unsupported_flags: labV3Queue.unsupported_flags || [],
      };
    }
    return transformBatchToV2(batch, ledgerPairs, { includeExamples: false });
  }, [isLabV3, labV3Queue, batch, ledgerPairs]);

  // Prefer lab-v3 counters when in that mode.
  const effectiveAudit = (isLabV3 && labV3Queue) ? labV3Queue : audit;

  const stageList = [
    { n: 1, label: "Your accounts",  sub: `${model.stage1_accounts.length} question${model.stage1_accounts.length === 1 ? "" : "s"}`, count: model.stage1_accounts.length },
    { n: 2, label: "Confirm patterns", sub: "Biggest dollars first",             count: model.stage2_patterns.length },
    { n: 3, label: "A few one-offs",   sub: "Checks and flags",                  count: model.stage3_oneoffs.length },
  ];

  const currentStage = stageList.find(s => s.n === stage) || stageList[0];
  const currentList  =
      stage === 1 ? model.stage1_accounts
    : stage === 2 ? model.stage2_patterns
    :               model.stage3_oneoffs;

  const activeItem = currentList[cursor] || null;

  // After a follow-up transition (e.g. "Another business" → affiliate
  // reason), the queue reloads and the same card_key stays in the
  // list under a new review_reason. Pin the cursor to that card so
  // it shows up in the same slot instead of jumping past it.
  useEffect(() => {
    if (!stickyCardKey) return;
    for (const [stg, list] of [
      [1, model.stage1_accounts],
      [2, model.stage2_patterns],
      [3, model.stage3_oneoffs],
    ]) {
      const idx = list.findIndex(x => x.card_key === stickyCardKey);
      if (idx >= 0) {
        if (stg !== stage) setStage(stg);
        setCursor(idx);
        return;
      }
    }
    // Card_key no longer in the queue → answered fully. Clear the pin.
    setStickyCardKey(null);
  }, [model, stickyCardKey, stage]);

  // Auto-advance across stages: when a stage has no items OR the
  // cursor runs past the end, jump to the next non-empty stage.
  useEffect(() => {
    if (!activeItem && currentList.length === 0 && stage < 3) {
      setStage(stage + 1); setCursor(0);
    }
  }, [activeItem, currentList.length, stage]);

  const answer = useCallback(async (itemId, key, item) => {
    setAnswers(a => ({ ...a, [itemId]: key }));

    // Lab v3 — post the answer, refetch the queue.
    if (isLabV3 && item?._labV3) {
      // AI-book path for affiliate follow-up cards. The FreeTextAnswer
      // Block's onConfirm packs the full proposal into the key as JSON
      // so we can POST proposed_account_code + reasoning + affiliate.
      if (key.startsWith("ai_book_affiliate:")) {
        let meta;
        try { meta = JSON.parse(key.slice("ai_book_affiliate:".length)); }
        catch { toast.error("Malformed proposal"); return; }
        try {
          const r = await api.post(`/companies/${currentId}/reviewv2/lab-v3-answer`, {
            card_key:              item.card_key,
            reason:                item.reason,
            choice:                "ai_book",
            txn_ids:               item.txn_ids || [],
            unknown_account_key:   item.unknown_account_key || null,
            affiliate_name:        meta.affiliate || null,
            proposed_account_code: meta.code || null,
            ai_reasoning:          meta.reason || null,
            user_description:      meta.desc || null,
          });
          toast.success(`Posted to ${r.data?.account_name || meta.name || "AI proposal"}`);
          setStickyCardKey(null);
          setReloadTick(t => t + 1);
        } catch (e) {
          toast.error(e?.response?.data?.detail || "Could not save answer.");
        }
        return;
      }

      const choice = key.startsWith("ai_confirm:") ? "confirm"
                   : key.startsWith("relationship:") ? key.split(":")[1]
                   : key.startsWith("payee:") ? "confirm"
                   : key === "ask_accountant" ? "flag"
                   : key;
      try {
        await api.post(`/companies/${currentId}/reviewv2/lab-v3-answer`, {
          card_key:            item.card_key,
          reason:              item.reason,
          choice,
          txn_ids:             item.txn_ids || [],
          contact_id:          item.contact_id || null,
          pfc_detailed:        item.pfc_detailed || null,
          bank_account_id:     item.bank_account_id || null,
          unknown_account_key: item.unknown_account_key || null,
          note:                key.startsWith("payee:") ? key.slice("payee:".length) : null,
        });
        toast.success(choice === "flag" ? "Flagged for accountant" : "Posted");
        if (choice === "another_biz") setStickyCardKey(item.card_key);
        else setStickyCardKey(null);
        setReloadTick(t => t + 1);
      } catch (e) {
        toast.error(e?.response?.data?.detail || "Could not save answer.");
      }
      return;
    }

    // Legacy standard-mode batch — real writes not wired yet on this path.
    toast.success("Recorded");
  }, [isLabV3, currentId]);

  const advance = useCallback(() => {
    if (cursor + 1 < currentList.length) {
      setCursor(cursor + 1);
    } else if (stage < 3) {
      setStage(stage + 1); setCursor(0);
    } else {
      toast.success("Review complete (lab preview)");
    }
  }, [cursor, currentList.length, stage]);

  // Step backwards through the queue — previous card in the same stage,
  // or the last card of the previous stage. Silently no-ops on the
  // very first card so the button can render unconditionally.
  const goBack = useCallback(() => {
    if (cursor > 0) {
      setCursor(cursor - 1);
      return;
    }
    if (stage > 1) {
      const prevStage = stage - 1;
      const prevList =
          prevStage === 1 ? model.stage1_accounts
        : prevStage === 2 ? model.stage2_patterns
        :                   model.stage3_oneoffs;
      setStage(prevStage);
      setCursor(Math.max(0, (prevList?.length || 1) - 1));
    }
  }, [cursor, stage, model]);

  const canGoBack = cursor > 0 || stage > 1;

  // Keyboard shortcuts — 1-9 trigger the Nth answer option on the
  // active card, S skips, A asks accountant, B goes back.
  useEffect(() => {
    if (!activeItem) return;
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key, 10) - 1;
        const opts = _optionsFor(stage, activeItem);
        if (opts[idx]) { answer(activeItem.pair_id || activeItem.group_id || activeItem.one_off_id, opts[idx].key, activeItem); advance(); }
      } else if (e.key === "s" || e.key === "S") {
        advance();
      } else if (e.key === "b" || e.key === "B") {
        goBack();
      } else if (e.key === "a" || e.key === "A") {
        answer(activeItem.pair_id || activeItem.group_id || activeItem.one_off_id, "ask_accountant", activeItem);
        advance();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeItem, stage, answer, advance, goBack]);

  if (loading) {
    return <PageShell><div className="text-slate-400 text-sm flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading batch for {current?.name}…</div></PageShell>;
  }
  if (isLabV3 && !labV3Queue) {
    return (
      <PageShell>
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-slate-300 text-sm">
          <b className="text-slate-100">Lab v3 mode — no lab-v3 rows found for {current?.name || "this company"}.</b>
          <div className="mt-2 text-slate-400">
            Run a Plaid sync (or the manual pipeline) to stamp <code className="text-slate-300">ai_source=lab_v3</code> on
            transactions. This page reads directly from those rows.
          </div>
        </div>
      </PageShell>
    );
  }
  if (!isLabV3 && !batch) {
    return (
      <PageShell>
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-slate-300 text-sm">
          <b className="text-slate-100">No pending review batch for {current?.name || "this company"}.</b>
          <div className="mt-2 text-slate-400">
            Generate one from the CPA Cockpit → Agent Inquiries card, or run the
            <code className="text-slate-300 mx-1">rebuild_test519_window_batch.py</code>
            seed script if you're testing on Test 519 LLC.
          </div>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <ProgressBar model={model} audit={effectiveAudit} />

      <div className="mt-6 grid grid-cols-[220px_1fr] gap-6">
        <StageSidebar
          stages={stageList}
          activeStage={stage}
          onPick={(n) => { setStage(n); setCursor(0); }}
          hideKeys={true}
        />

        <div>
          {activeItem ? (
            <CardRenderer
              stage={stage}
              item={activeItem}
              stageIdx={cursor + 1}
              stageTotal={currentList.length}
              cid={currentId}
              onAnswer={(key) => {
                answer(activeItem.pair_id || activeItem.group_id || activeItem.one_off_id, key, activeItem);
                // Don't jump forward when the answer triggers a
                // follow-up card at the same card_key (2-step "Another
                // business" flow). Queue refresh will show the follow-
                // up in this same slot.
                const rawKey = key.startsWith("affiliate:") ? key.split(":")[1].split("|")[0] : key;
                if (rawKey !== "another_biz") advance();
              }}
              onSkip={advance}
              onBack={goBack}
              canGoBack={canGoBack}
              onAskAccountant={() => {
                answer(activeItem.pair_id || activeItem.group_id || activeItem.one_off_id, "ask_accountant", activeItem);
                advance();
              }}
            />
          ) : (
            <div className="rounded-2xl border border-emerald-700/40 bg-emerald-950/20 p-8 text-center">
              <CheckCircle2 size={28} className="mx-auto text-emerald-400 mb-2" />
              <div className="text-emerald-100 font-semibold">All questions answered</div>
              <div className="text-emerald-300/70 text-xs mt-1">Your CPA will finalize the long tail.</div>
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}

// ---------------------------------------------------------------- Shell

function PageShell({ children }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-10">
      <div className="max-w-5xl mx-auto">
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Bits

function ProgressBar({ model, audit }) {
  const pct = model.progress.pct_confirmed;
  const left = model.progress.questions_left;
  // Prefer real verification-based audit numbers when available;
  // otherwise hide the banner entirely rather than showing a mock.
  const autoCount   = audit?.auto_handled?.count ?? 0;
  const autoDollars = audit?.auto_handled?.dollars ?? 0;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] text-slate-300">
          Your books are <span className="text-slate-100 font-semibold text-lg">{pct}%</span> confirmed by dollar value
        </div>
        <div className="text-[12px] text-slate-400">{left} question{left === 1 ? "" : "s"} left</div>
      </div>
      <div className="mt-2 h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
        <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      {audit && autoCount > 0 && (
        <div className="mt-1.5 text-[11px] text-slate-500 flex items-center gap-1.5 flex-wrap">
          AI already auto-handled{" "}
          <b className="text-slate-300">${autoDollars.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</b>{" "}
          across <b className="text-slate-300">{autoCount.toLocaleString()}</b> verified rows.
          {audit.auto_handled.by_reason?.transfer_both_connected > 0 && (
            <span className="text-slate-600">
              · {audit.auto_handled.by_reason.transfer_both_connected} matched transfer legs
            </span>
          )}
          {audit.auto_handled.by_reason?.recognized_vendor > 0 && (
            <span className="text-slate-600">
              · {audit.auto_handled.by_reason.recognized_vendor} recognized vendor rows
            </span>
          )}
          <button className="text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline inline-flex items-center gap-0.5">
            View log to undo any of them <ExternalLink size={10} />
          </button>
        </div>
      )}
      {audit && autoCount === 0 && (
        <div className="mt-1.5 text-[11px] text-slate-500">
          Nothing has been auto-handled yet — {audit.rules_count} saved rule{audit.rules_count === 1 ? "" : "s"},{" "}
          {audit.connected_account_count} connected account{audit.connected_account_count === 1 ? "" : "s"}.
          Confirm patterns below to start saving rules.
        </div>
      )}
    </div>
  );
}

function StageSidebar({ stages, activeStage, onPick, hideKeys }) {
  return (
    <div className="space-y-2">
      {stages.map(s => {
        const done = s.count === 0;
        const active = s.n === activeStage;
        return (
          <button
            key={s.n}
            onClick={() => onPick(s.n)}
            data-testid={`reviewv2-stage-${s.n}`}
            className={`w-full text-left rounded-lg border px-3 py-2.5 flex items-start gap-2 transition
              ${active ? "border-blue-500/60 bg-blue-950/30" : "border-slate-800 bg-slate-900/40 hover:border-slate-700"}`}
          >
            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0
              ${done ? "bg-emerald-500/20 text-emerald-300" : active ? "bg-blue-500 text-white" : "bg-slate-700 text-slate-300"}`}>
              {done ? "✓" : s.n}
            </div>
            <div className="min-w-0">
              <div className={`text-[13px] ${active ? "text-slate-100 font-semibold" : "text-slate-300"}`}>{s.label}</div>
              <div className="text-[11px] text-slate-500">{s.sub}</div>
            </div>
          </button>
        );
      })}
      {!hideKeys && (
        <div className="mt-4 space-y-1 text-[10px] text-slate-500 pl-1">
          <div className="flex items-center gap-1.5"><Keyboard size={10} /> shortcuts</div>
          <div><kbd className="kbd">1</kbd>–<kbd className="kbd">4</kbd> answer</div>
          <div><kbd className="kbd">S</kbd> skip &nbsp;<kbd className="kbd">A</kbd> ask accountant</div>
        </div>
      )}
      <style>{`.kbd { padding:1px 5px; border-radius:3px; background:#1e293b; border:1px solid #334155; color:#cbd5e1; font-family:ui-monospace,monospace; font-size:10px; }`}</style>
    </div>
  );
}

// ------------------------------------------------- Options per card kind
function _optionsFor(stage, item) {
  // Lab v3 rows carry their own option list, computed server-side per
  // review_reason. Use it directly so both keyboard shortcuts and the
  // rendered button strip line up.
  if (item?._labV3 && Array.isArray(item.options)) return item.options;
  if (stage === 1) {
    return [
      { key: "yes_both", label: "Yes, both are ours" },
      { key: "one_personal", label: "One is a personal account" },
      { key: "one_other_biz", label: "One belongs to another business" },
    ];
  }
  if (stage === 2) {
    if (item.is_mixed) {
      return [
        { key: "customer",   label: "Customer" },
        { key: "contractor", label: "Contractor I pay" },
        { key: "owner",      label: "Owner or family" },
        { key: "something",  label: "Something else" },
      ];
    }
    if (item.ai_suggestion) {
      return [
        { key: "confirm_ai", label: `Confirm: ${item.ai_suggestion}` },
        { key: "change",     label: "Change category" },
      ];
    }
    return [
      { key: "customer",   label: "Customer" },
      { key: "contractor", label: "Contractor I pay" },
      { key: "owner",      label: "Owner or family" },
      { key: "something",  label: "Something else" },
    ];
  }
  // stage 3
  if (item.kind === "check") return [];   // payee input, not options
  return [
    { key: "confirm", label: "Confirm" },
    { key: "flag",    label: "Flag for accountant" },
  ];
}

// -------- Direction badge (money in / money out) ---------------------
function DirectionBadge({ direction }) {
  if (direction !== "in" && direction !== "out") return null;
  const isIn = direction === "in";
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider ${
      isIn ? "bg-emerald-950/60 text-emerald-300 border border-emerald-800/60"
           : "bg-rose-950/60 text-rose-300 border border-rose-800/60"
    }`}>
      {isIn ? <ArrowDownRight size={10} /> : <ArrowUpRight size={10} />}
      Money {isIn ? "in" : "out"}
    </span>
  );
}

// -------- Free-text answer + mic + inline AI proposal -----------------
// Sits under every card. When the client types + submits, we call
// POST /companies/{cid}/reviewv2/ai-propose which returns a proposed
// account/reason/confidence + conflict/flag_for_cpa hints. Nothing
// books until Confirm is clicked.
function FreeTextAnswerBlock({ cid, context, direction, onConfirm, chatShortcut, initialText }) {
  const [text, setText]         = useState(initialText || "");
  const [busy, setBusy]         = useState(false);
  const [proposal, setProposal] = useState(null);
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);

  // Allow the parent (affiliate flow's quick-pick chips) to inject a
  // starter description into the input.
  useEffect(() => {
    if (typeof initialText === "string") setText(initialText);
  }, [initialText]);

  const submit = async () => {
    const answer = text.trim();
    if (!answer) return;
    // If the caller passed a `chatShortcut` handler (used by the
    // mixed-direction card so the client can just type "confirm"),
    // give it first crack. If it returns true, we don't hit the AI.
    if (chatShortcut && chatShortcut(answer)) {
      setText("");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post(`/companies/${cid}/reviewv2/ai-propose`, {
        context, user_answer: answer,
      });
      setProposal(r.data || null);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "AI could not respond — try again.");
    } finally {
      setBusy(false);
    }
  };

  // Web Speech API mic. Falls back to disabled if the browser doesn't
  // expose it (Safari desktop, most Firefox builds).
  const startMic = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast.error("Voice input isn't supported in this browser."); return; }
    if (listening) { recRef.current?.stop(); return; }
    const rec = new SR();
    rec.lang = "en-US"; rec.interimResults = true; rec.continuous = false;
    let last = "";
    rec.onresult = (e) => {
      let t = "";
      for (let i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript;
      last = t; setText(last);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  const supportsMic = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  return (
    <div className="mt-5 border-t border-slate-800 pt-4 space-y-3">
      <div className="flex items-center gap-2 text-[11px] text-slate-500">
        <Sparkles size={11} /> Or tell us in your own words —
        <span className="text-slate-400">the AI will propose a booking. Nothing posts until you confirm.</span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. this was rent for my office"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          disabled={busy}
          data-testid="reviewv2-freetext-input"
          className="flex-1 bg-slate-800/70 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500 disabled:opacity-50"
        />
        <button
          onClick={startMic}
          disabled={!supportsMic || busy}
          title={supportsMic ? "Speak your answer" : "Voice input unavailable"}
          data-testid="reviewv2-mic"
          className={`p-2 rounded-md border ${listening ? "bg-rose-950/60 border-rose-800 text-rose-300 animate-pulse" : "bg-slate-800/70 border-slate-700 text-slate-300"} disabled:opacity-40`}>
          {listening ? <MicOff size={15} /> : <Mic size={15} />}
        </button>
        <button
          onClick={submit}
          disabled={busy || !text.trim()}
          data-testid="reviewv2-freetext-submit"
          className="p-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>
      </div>

      {proposal && <AiProposalBlock proposal={proposal} context={context} direction={direction} onConfirm={onConfirm} onDismiss={() => setProposal(null)} />}
    </div>
  );
}

function AiProposalBlock({ proposal, context, direction, onConfirm, onDismiss }) {
  if (!proposal.ok) {
    return (
      <div className="rounded-md border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-[12px] text-amber-200 flex items-start gap-2">
        <AlertTriangle size={12} className="mt-0.5" />
        <div className="flex-1">{proposal.reason || "AI couldn't produce a proposal — try again or use 'Ask my accountant'."}</div>
        <button onClick={onDismiss} className="text-amber-300 hover:text-amber-100"><X size={12} /></button>
      </div>
    );
  }
  return (
    <div className={`rounded-md border px-3 py-3 ${proposal.conflict ? "border-amber-700/60 bg-amber-950/25" : proposal.flag_for_cpa ? "border-blue-700/60 bg-blue-950/25" : "border-emerald-800/60 bg-emerald-950/20"}`}>
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
            <Sparkles size={10} /> AI proposal
            {proposal.confidence != null && (
              <span className="text-slate-500 normal-case tracking-normal">· {Math.round((proposal.confidence || 0) * 100)}% confident</span>
            )}
          </div>
          <div className="mt-1 text-[13px] text-slate-100">
            Book to <b className="text-white">{proposal.account_code} · {proposal.account_name}</b>
          </div>
          {proposal.reason && <div className="mt-1 text-[12px] text-slate-300">{proposal.reason}</div>}

          {proposal.conflict && (
            <div className="mt-2 flex items-start gap-1.5 text-[12px] text-amber-200">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>Your answer doesn't match the bank description. Check the transaction before confirming.</span>
            </div>
          )}
          {proposal.flag_for_cpa && (
            <div className="mt-2 flex items-start gap-1.5 text-[12px] text-blue-200">
              <Info size={12} className="mt-0.5 shrink-0" />
              <span>This one needs accountant review before it posts — we'll flag it for your CPA.</span>
            </div>
          )}
        </div>
        <button onClick={onDismiss} className="text-slate-400 hover:text-slate-200"><X size={13} /></button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => onConfirm(proposal)}
          data-testid="reviewv2-proposal-confirm"
          className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-[12px] font-medium inline-flex items-center gap-1">
          <CheckCircle2 size={12} /> Confirm & book
        </button>
        <button
          onClick={onDismiss}
          data-testid="reviewv2-proposal-change"
          className="px-3 py-1.5 rounded-md bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-200 text-[12px]">
          Change my answer
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------- Card Renderer

// Quick-pick suggestions for the affiliate description (used to fill
// the AI-propose input in one click).
const AFFILIATE_QUICK_PICKS = [
  "I loaned them money — they'll pay me back",
  "They loaned me money — I'll pay them back",
  "I moved my own money between my two businesses",
  "I paid them for services or goods they provided",
  "They paid me for services or goods I provided",
  "Expense reimbursement — I paid a bill we're sharing",
  "Repayment of a loan they made to me earlier",
  "Repayment of a loan I made to them earlier",
];

function CardRenderer({ stage, item, stageIdx, stageTotal, onAnswer, onSkip, onAskAccountant, onBack, canGoBack, cid }) {
  // Local state for the affiliate-name follow-up (2-step "Another
  // business" flow). Reset every time the active card changes so a
  // half-typed name doesn't leak into the next question.
  const [affiliateName, setAffiliateName] = useState("");
  const [affiliateDescription, setAffiliateDescription] = useState("");
  useEffect(() => {
    setAffiliateName(""); setAffiliateDescription("");
  }, [item?.card_key || item?.pair_id || item?.group_id || item?.one_off_id]);

  const stageLabel =
      stage === 1 ? "Your accounts"
    : stage === 2 ? "Confirm patterns"
    :               "A few one-offs";
  // Direction badge — Stage 1 is always a transfer (net-zero), so no
  // badge. Stage 2/3 always carry a direction we can display.
  const dir =
      stage === 2
        ? (item.is_mixed ? null
           : item.money_in_count >= item.money_out_count ? "in" : "out")
    : stage === 3 ? item.direction
    : null;

  // Build the "context" object we hand to the AI proposal endpoint.
  // Hoisted above every conditional return so React's hook ordering
  // stays stable across mixed vs single vs stage-1 render paths.
  const proposalContext = useMemo(() => {
    if (stage === 2) {
      const biggest = [...(item.samples_in || []), ...(item.samples_out || [])]
        .sort((a, b) => (b.amount || 0) - (a.amount || 0))[0] || {};
      return {
        date:        biggest.date,
        amount:      dir === "in" ? +biggest.amount : -Math.abs(biggest.amount || 0),
        description: biggest.desc || item.label,
        merchant:    item.label,
      };
    }
    if (stage === 3) {
      const it = item.raw_item || item;
      const ctx = it.context || {};
      return {
        date:        ctx.date || item.date,
        amount:      Number(ctx.amount ?? (dir === "in" ? item.amount : -Math.abs(item.amount || 0))),
        description: ctx.description || item.description,
        merchant:    ctx.merchant || item.merchant,
        account:     ctx.account,
      };
    }
    return {};
  }, [stage, item, dir]);

  // Mixed-direction Stage 2 pattern → dedicated preview-then-confirm
  // card. Skips the generic option-button + free-text block below
  // and renders its own controls (top pills, live column preview,
  // Remember checkbox, Confirm N button, chat "confirm" shortcut).
  //
  // Lab-v3: use the mixed card when the group is truly mixed AND the
  // question is genuinely "who is this to your business?" — i.e.
  // uncategorized / unidentified_counterparty. For owner-comp and
  // sensitive-first-time we keep the binary option strip since those
  // are known-contact yes/no questions.
  const _labV3MixedEligible =
      item._labV3 && item.is_mixed &&
      (item.reason === "uncategorized" || item.reason === "unidentified_counterparty");
  if (stage === 2 && item.is_mixed && (!item._labV3 || _labV3MixedEligible)) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 md:p-6"
           data-testid="reviewv2-card-stage-2-mixed">
        <div className="flex items-baseline justify-between text-[11px] text-slate-500">
          <div>{stageLabel} · {stageIdx} of {stageTotal}</div>
        </div>
        <Stage2MixedCard
          item={item}
          cid={cid}
          onConfirm={(payload) => onAnswer(`relationship:${payload.relationship}`)}
        />
        <div className="mt-5 flex items-center justify-between text-[12px]">
          <div className="flex items-center gap-4">
            <button
              onClick={onBack}
              disabled={!canGoBack}
              className="text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline disabled:opacity-30 disabled:cursor-not-allowed"
              data-testid="reviewv2-back"
            >
              ← Back
            </button>
            <button onClick={onSkip} className="text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline" data-testid="reviewv2-skip">
              Skip for now
            </button>
          </div>
          <button onClick={onAskAccountant} className="text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline" data-testid="reviewv2-ask">
            Ask my accountant
          </button>
        </div>
      </div>
    );
  }
  const opts = _optionsFor(stage, item);

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 md:p-6"
         data-testid={`reviewv2-card-stage-${stage}`}>
      <div className="flex items-baseline justify-between text-[11px] text-slate-500">
        <div className="flex items-center gap-2">
          <span>{stageLabel} · {stageIdx} of {stageTotal}</span>
          <DirectionBadge direction={dir} />
        </div>
        {stage === 2 && <div>Sorted by dollars</div>}
      </div>

      {stage === 1 && <Stage1Body item={item} />}
      {stage === 2 && <Stage2Body item={item} />}
      {stage === 3 && <Stage3Body item={item} onAnswer={onAnswer} />}

      {/* Affiliate flow (2-step "Another business") — free-text
          description that the AI maps to THIS company's actual CoA,
          instead of a fixed button strip that guesses account names/
          codes. Ships a name input + quick-pick chips that pre-fill
          the description. */}
      {item.needs_affiliate_name && (
        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-[11px] uppercase tracking-widest text-slate-400 mb-1">
              Affiliate business name <span className="text-slate-500 normal-case tracking-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={affiliateName}
              onChange={(e) => setAffiliateName(e.target.value)}
              placeholder="e.g. Northgate Advisory LLC"
              autoFocus
              className="w-full px-3 py-2 rounded-lg bg-slate-800/60 border border-slate-700 text-[13px] text-slate-100 focus:outline-none focus:border-slate-500"
              data-testid="reviewv2-affiliate-name-input"
            />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-widest text-slate-400 mb-1">
              Quick-pick — click to fill the description
            </div>
            <div className="flex flex-wrap gap-1.5">
              {AFFILIATE_QUICK_PICKS.map((q, i) => (
                <button
                  key={i}
                  onClick={() => setAffiliateDescription(q)}
                  data-testid={`reviewv2-affiliate-chip-${i}`}
                  className="text-[11px] px-2 py-1 rounded-full border border-slate-700 bg-slate-800/40 hover:bg-slate-800 hover:border-slate-500 text-slate-200"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {opts.length > 0 && (
        <div className="mt-4 space-y-2">
          {opts.map((o, i) => (
            <button
              key={o.key}
              onClick={() => onAnswer(o.key)}
              data-testid={`reviewv2-opt-${o.key}`}
              className="w-full text-left px-4 py-2.5 rounded-lg border border-slate-700 bg-slate-800/40 hover:bg-slate-800 hover:border-slate-600 flex items-center gap-3 text-[13px] text-slate-100 transition"
            >
              <kbd className="kbd shrink-0">{i + 1}</kbd>
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Free-text + mic + inline AI proposal — omitted on Stage 1
          pair questions (they're a yes/no on ownership). Enabled for
          the 2-step affiliate follow-up so the AI can pick the right
          account from THIS company's actual Chart of Accounts. */}
      {(stage !== 1 || item.needs_affiliate_name) && cid && (
        <FreeTextAnswerBlock
          cid={cid}
          context={item.needs_affiliate_name ? {
            date:        (item.samples && item.samples[0]?.date) || null,
            amount:      -Math.abs(item.total_dollars || 0),
            description: (item.samples && item.samples[0]?.to) || item.question,
            merchant:    item.from,
            account:     item.source_account,
            affiliate:   affiliateName || "Related Party",
            hint:        `This is a transfer between ${item.source_account} and ${item.from}. The user has confirmed the counterparty is another business they own or work with (called "${affiliateName || 'Related Party'}"). Pick the best account from THIS company's chart of accounts — Due from/to a related party, Owner's Draw/Contribution, Consulting Expense/Revenue, or propose a new account whose name follows the company's naming style.`,
          } : proposalContext}
          initialText={item.needs_affiliate_name ? affiliateDescription : ""}
          direction={dir}
          onConfirm={(proposal) => {
            if (item.needs_affiliate_name) {
              // AI-book path: pass the full proposal via the parent's
              // answer() so it can POST proposed_account_code + reasoning.
              onAnswer(`ai_book_affiliate:${JSON.stringify({
                code:      proposal.account_code,
                name:      proposal.account_name,
                reason:    proposal.reason,
                affiliate: affiliateName,
                desc:      affiliateDescription,
              })}`);
            } else {
              onAnswer(`ai_confirm:${proposal.account_code}`);
            }
          }}
        />
      )}

      <div className="mt-5 flex items-center justify-between text-[12px]">
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            disabled={!canGoBack}
            className="text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline disabled:opacity-30 disabled:cursor-not-allowed"
            data-testid="reviewv2-back"
          >
            ← Back
          </button>
          <button onClick={onSkip} className="text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline" data-testid="reviewv2-skip">
            Skip for now
          </button>
        </div>
        <button onClick={onAskAccountant} className="text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline" data-testid="reviewv2-ask">
          Ask my accountant
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------ Stage 1 · account pair
function Stage1Body({ item }) {
  // Lab-v3 stage-1 cards are single-account questions, not transfer
  // pairs — render the reason-specific question + a small sample list.
  if (item._labV3) {
    return (
      <div className="mt-2">
        <h2 className="text-xl md:text-2xl font-heading font-semibold text-slate-100">
          {item.question}
        </h2>
        <div className="mt-1 text-[13px] text-slate-400">
          <b className="text-slate-200">{item.from}</b> · {item.count} lab-v3 row{item.count === 1 ? "" : "s"} pending
          <span className="ml-1">· ${item.total_dollars.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} total</span>
        </div>
        <div className="mt-4 space-y-1.5">
          {(item.samples || []).slice(0, 3).map((s, i) => (
            <div key={i} className="flex items-center justify-between text-[12px] text-slate-300 py-1 border-b border-slate-800/70">
              <div className="truncate mr-3">{s.date} · {s.to}</div>
              <div className="font-mono-num text-slate-100">${s.amount.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }  return (
    <div className="mt-2">
      <h2 className="text-xl md:text-2xl font-heading font-semibold text-slate-100">
        Are these both your business accounts?
      </h2>
      <div className="mt-1 text-[13px] text-slate-400">
        We found {item.transfer_count} matching transfer{item.transfer_count === 1 ? "" : "s"} between
        <span className="text-slate-200 mx-1"><b>{item.from || "—"}</b> ⇄ <b>{item.to || "—"}</b></span>,
        <span className="text-slate-200 ml-1">${item.total_dollars.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span> total.
      </div>
      <div className="mt-4 space-y-1.5">
        {item.samples.map((s, i) => (
          <div key={i} className="flex items-center justify-between text-[12px] text-slate-300 py-1 border-b border-slate-800/70">
            <div className="flex items-center gap-2">
              <ArrowLeftRight size={11} className="text-slate-500" />
              {s.date} · {s.from} → {s.to}
            </div>
            <div className="font-mono-num text-slate-100">${s.amount.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Relationship → per-direction account mapping ---------------------
// Deterministic (no LLM call) so the client sees an instant preview
// when they tap a pill. Codes are stubs — the real book-through path
// resolves them against the company's CoA + entity rules.
const _RELATIONSHIP_MAP = {
  customer: {
    label: "Customer",
    in:  { code: "4000", name: "Sales income",         note: "Payments for your work" },
    out: { code: "4900", name: "Refunds to customers", note: "Reduces income" },
  },
  contractor: {
    label: "Contractor",
    in:  { code: "6010", name: "Contract labor (credit)", note: "Refund or overpayment returned" },
    out: { code: "6010", name: "Contract labor",           note: "Counts toward 1099 reporting" },
  },
  owner: {
    label: "Owner or family",
    in:  { code: "3100", name: "Owner contribution", note: "Not income, not taxable" },
    out: { code: "3200", name: "Owner draw",          note: "Not an expense" },
  },
  lender: {
    label: "Lender",
    in:  { code: "2500", name: "Loan payable",           note: "Loan money received" },
    out: { code: "2500", name: "Loan payable + interest", note: "Split principal and interest, flagged for accountant", flag_cpa: true },
  },
  something: {
    label: "Something else",
    in:  { code: null,   name: "Ask separately", note: "We will ask what the received payments were", split: true },
    out: { code: null,   name: "Ask separately", note: "We will ask what the sent payments were",     split: true },
  },
};

function Stage2MixedCard({ item, onConfirm, cid }) {
  const [relationship, setRelationship] = useState(null);
  const [remember, setRemember]         = useState(true);
  const [excluded, setExcluded]         = useState(new Set());

  const map = relationship ? _RELATIONSHIP_MAP[relationship] : null;
  const affectedRows = item.items.length - excluded.size;

  const confirm = () => {
    if (!relationship) {
      toast.error("Pick a relationship first.");
      return;
    }
    onConfirm({
      relationship,
      map:        _RELATIONSHIP_MAP[relationship],
      remember,
      excluded:   Array.from(excluded),
    });
  };

  // Let the client say "confirm" (or "yes"/"book it") in the free-text
  // box to trigger the Confirm button — matches the "say confirm to
  // the AI in the chat" ask. The FreeTextAnswerBlock still exists for
  // richer answers; this handler runs first.
  const chatConfirm = (text) => {
    const t = (text || "").trim().toLowerCase();
    if (["confirm", "yes", "book it", "book", "go", "confirm it"].includes(t)) {
      confirm();
      return true;
    }
    return false;
  };

  const pill = (key) => {
    const active = relationship === key;
    return (
      <button
        key={key}
        onClick={() => setRelationship(key)}
        data-testid={`reviewv2-rel-${key}`}
        className={`px-3 py-1.5 rounded-full text-[13px] border transition ${
          active
            ? "bg-slate-100 text-slate-900 border-slate-100 font-medium"
            : "bg-slate-800/40 text-slate-200 border-slate-700 hover:border-slate-500"
        }`}
      >
        {_RELATIONSHIP_MAP[key].label}
      </button>
    );
  };

  return (
    <>
      <div className="mt-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xl md:text-2xl font-heading font-semibold text-slate-100">
            Who is <span className="text-blue-300">{item.label}</span> to your business?
          </h2>
          {item.is_example && (
            <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-purple-950/60 text-purple-300 border border-purple-800/60">
              Example
            </span>
          )}
        </div>
        <div className="mt-1 text-[13px] text-slate-400">
          {item.items.length} payments:{" "}
          <span className="text-emerald-300">{item.money_in_count} received</span>,{" "}
          <span className="text-rose-300">{item.money_out_count} sent</span>
        </div>
      </div>

      {/* Relationship pills — top-of-card, tap to PREVIEW, not commit. */}
      <div className="mt-4 flex flex-wrap gap-2">
        {Object.keys(_RELATIONSHIP_MAP).map(pill)}
      </div>

      {/* Live money-in / money-out preview based on the picked relationship. */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <MixedColumn side="in"  count={item.money_in_count}  total={item.money_in_total}
                     mapping={map?.in}  samples={item.samples_in}  onChange={() => toast.info("Per-side override coming next.")} />
        <MixedColumn side="out" count={item.money_out_count} total={item.money_out_total}
                     mapping={map?.out} samples={item.samples_out} onChange={() => toast.info("Per-side override coming next.")} />
      </div>

      {item.outliers.length > 0 && (
        <div className="mt-3 rounded-md border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-[12px] text-amber-200 flex items-start gap-2">
          <AlertTriangle size={12} className="mt-0.5" />
          <div className="flex-1">
            The <span className="font-mono-num">${item.outliers[0].amount.toFixed(2)}</span>{" "}
            payment on {item.outliers[0].date} looks like a {item.outliers[0].reason.replace("_", " ")}.{" "}
            <button
              className="underline hover:text-amber-100"
              onClick={() => setExcluded(s => new Set([...s, `${item.outliers[0].date}:${item.outliers[0].amount}`]))}
            >
              Exclude it
            </button>
          </div>
        </div>
      )}

      {/* Free-text / mic — same block as every other card. Chat-shortcut
          "confirm" triggers Confirm without an AI round-trip. */}
      {cid && (
        <FreeTextAnswerBlock
          cid={cid}
          context={{
            merchant:    item.label,
            description: item.samples_out[0]?.desc || item.samples_in[0]?.desc || item.label,
            amount:      item.money_in_total - item.money_out_total,
            date:        item.samples_in[0]?.date || item.samples_out[0]?.date,
          }}
          direction={null}
          chatShortcut={chatConfirm}
          onConfirm={() => confirm()}
        />
      )}

      <div className="mt-4 flex items-center justify-between gap-4">
        <label className="text-[12px] text-slate-300 inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            data-testid="reviewv2-remember-rule"
            className="rounded border-slate-600 bg-slate-800"
          />
          Remember for future {item.label} payments
        </label>
        <button
          onClick={confirm}
          disabled={!relationship}
          data-testid="reviewv2-mixed-confirm"
          className={`px-4 py-2 rounded-md text-sm font-medium inline-flex items-center gap-1.5 ${
            relationship
              ? "bg-blue-600 hover:bg-blue-500 text-white"
              : "bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed"
          }`}
        >
          <CheckCircle2 size={14} /> Confirm {affectedRows}
        </button>
      </div>
    </>
  );
}

function MixedColumn({ side, count, total, mapping, samples, onChange }) {
  const isIn = side === "in";
  return (
    <div className={`rounded-lg border p-3 ${isIn ? "border-emerald-800/50 bg-emerald-950/15" : "border-rose-800/50 bg-rose-950/15"}`}>
      <div className={`text-[11px] font-semibold flex items-center gap-1 ${isIn ? "text-emerald-300" : "text-rose-300"}`}>
        {isIn ? <ArrowDownRight size={11} /> : <ArrowUpRight size={11} />}
        Money {isIn ? "in" : "out"} · {count} payment{count === 1 ? "" : "s"}
      </div>
      {mapping ? (
        <>
          <div className="mt-2 text-[14px] text-slate-100 font-semibold">
            {mapping.code ? `${mapping.code} · ${mapping.name}` : mapping.name}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">{mapping.note}</div>
          {mapping.flag_cpa && (
            <div className="mt-1 inline-flex items-center gap-1 text-[10px] text-blue-300">
              <Info size={9} /> Flagged for accountant
            </div>
          )}
          <button onClick={onChange} className="mt-2 text-[11px] text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline">
            Change for this side
          </button>
        </>
      ) : (
        <>
          <div className="mt-1 text-[13px] text-slate-500 italic">
            Pick a relationship above to preview.
          </div>
          <div className="mt-2 space-y-0.5 text-[11px] text-slate-500">
            <div>Total <span className="font-mono-num text-slate-300">${total.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
            {samples.slice(0, 2).map((s, i) => (
              <div key={i} className="flex items-center justify-between">
                <span>{s.date}</span>
                <span className="font-mono-num">${s.amount.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------- Stage 2 · pattern group
function Stage2Body({ item }) {
  const relationshipQuestion = item.is_mixed || !item.ai_suggestion;
  // Lab v3 owner-comp / sensitive cards: use the server-supplied
  // question directly and skip the "who is X" framing.
  if (item._labV3) {
    return (
      <div className="mt-2">
        <h2 className="text-xl md:text-2xl font-heading font-semibold text-slate-100">
          {item.question}
        </h2>
        <div className="mt-1 text-[13px] text-slate-400">
          <b className="text-slate-200">{item.label}</b> · {item.items.length} transaction{item.items.length === 1 ? "" : "s"}
          {" · $"}{item.total_dollars.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} total
        </div>
        {item.ai_suggestion && (
          <div className="mt-3 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-blue-950/40 border border-blue-800/60 text-[11px] text-blue-200">
            <Info size={11} /> AI proposes <b>{item.ai_suggestion}</b>
          </div>
        )}
        {item.pfc_detailed && (
          <div className="mt-2 text-[10px] text-slate-500 font-mono-num">PFC: {item.pfc_detailed}</div>
        )}
        <div className="mt-4 space-y-1.5">
          {[...item.samples_in, ...item.samples_out].slice(0, 3).map((s, i) => (
            <div key={i} className="flex items-center justify-between text-[12px] text-slate-300 py-1 border-b border-slate-800/70">
              <div className="truncate mr-3">{s.date} · {s.desc || item.label}</div>
              <div className="font-mono-num text-slate-100">${s.amount.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <h2 className="text-xl md:text-2xl font-heading font-semibold text-slate-100">
          {relationshipQuestion
            ? <>Who is <span className="text-blue-300">{item.label}</span> to your business?</>
            : <>Categorize <span className="text-blue-300">{item.label}</span></>}
        </h2>
        {item.is_example && (
          <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-purple-950/60 text-purple-300 border border-purple-800/60">
            Example
          </span>
        )}
      </div>
      <div className="mt-1 text-[13px] text-slate-400">
        {item.items.length} transaction{item.items.length === 1 ? "" : "s"}
        {item.is_mixed && <>: <span className="text-emerald-300">{item.money_in_count} received</span>, <span className="text-rose-300">{item.money_out_count} sent</span></>}
        {" · $"}{item.total_dollars.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} total
      </div>

      {item.ai_suggestion && !item.is_mixed && (
        <div className="mt-3 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-blue-950/40 border border-blue-800/60 text-[11px] text-blue-200">
          <Info size={11} /> AI suggests <b>{item.ai_suggestion}</b>
        </div>
      )}

      {/* Two-column money in / money out preview for mixed contacts */}
      {item.is_mixed && (
        <div className="mt-4 grid grid-cols-2 gap-3">
          <DirectionColumn side="in"  count={item.money_in_count}  total={item.money_in_total}  samples={item.samples_in} />
          <DirectionColumn side="out" count={item.money_out_count} total={item.money_out_total} samples={item.samples_out} />
        </div>
      )}

      {/* Sample rows for single-direction groups */}
      {!item.is_mixed && (
        <div className="mt-4 space-y-1.5">
          {[...item.samples_in, ...item.samples_out].slice(0, 3).map((s, i) => (
            <div key={i} className="flex items-center justify-between text-[12px] text-slate-300 py-1 border-b border-slate-800/70">
              <div className="truncate mr-3">{s.date} · {s.desc || item.label}</div>
              <div className="font-mono-num text-slate-100">${s.amount.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
            </div>
          ))}
        </div>
      )}

      {item.outliers.length > 0 && (
        <div className="mt-3 rounded-md border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-[12px] text-amber-200 flex items-start gap-2">
          <AlertTriangle size={12} className="mt-0.5" />
          <div>
            The ${item.outliers[0].amount.toFixed(2)} payment on {item.outliers[0].date} looks like a test.{" "}
            <button className="underline hover:text-amber-100">Exclude it</button>
          </div>
        </div>
      )}
    </div>
  );
}

function DirectionColumn({ side, count, total, samples }) {
  const isIn = side === "in";
  return (
    <div className={`rounded-lg border p-3 ${isIn ? "border-emerald-800/50 bg-emerald-950/15" : "border-rose-800/50 bg-rose-950/15"}`}>
      <div className={`text-[11px] font-semibold flex items-center gap-1 ${isIn ? "text-emerald-300" : "text-rose-300"}`}>
        {isIn ? <ArrowDownRight size={11} /> : <ArrowUpRight size={11} />}
        Money {isIn ? "in" : "out"} · {count} payment{count === 1 ? "" : "s"}
      </div>
      <div className="mt-1 text-[13px] text-slate-100 font-semibold">
        ${total.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
      </div>
      <div className="mt-2 space-y-0.5 text-[11px] text-slate-400">
        {samples.slice(0, 2).map((s, i) => (
          <div key={i} className="flex items-center justify-between">
            <span>{s.date}</span>
            <span className="font-mono-num text-slate-300">${s.amount.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------- Stage 3 · one-offs
function Stage3Body({ item, onAnswer }) {
  if (item.kind === "check") {
    return <CheckPayeeCard item={item} onAnswer={onAnswer} />;
  }
  // Singleton promoted from stage 2 — ask "what was this for?" with
  // the cleaned merchant name in the headline and the raw bank
  // description underneath (so the client can spot bank-feed noise
  // if the cleaner miscategorized).
  if (item.kind === "singleton") {
    return (
      <div className="mt-2">
        <h2 className="text-xl md:text-2xl font-heading font-semibold text-slate-100">
          What was this <span className="text-blue-300">${(item.amount || 0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span> {item.direction === "in" ? "payment received" : "charge"} for?
        </h2>
        <div className="mt-1 text-[13px] text-slate-400">
          <b className="text-slate-200">{item.merchant}</b> · {item.date}
        </div>
        {item.description && item.description !== item.merchant && (
          <div className="mt-2 text-[11px] text-slate-500 font-mono-num truncate" title={item.description}>
            Bank description: {item.description}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="mt-2">
      <h2 className="text-xl md:text-2xl font-heading font-semibold text-slate-100">
        {item.prompt || item.description || "One-off review"}
      </h2>
      <div className="mt-1 text-[13px] text-slate-400">
        {item.date} · <span className="text-slate-200">${(item.amount || 0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
      </div>
    </div>
  );
}

function CheckPayeeCard({ item, onAnswer }) {
  const [payee, setPayee] = useState("");
  return (
    <div className="mt-2">
      <h2 className="text-xl md:text-2xl font-heading font-semibold text-slate-100">
        Who was check #{item.check_number || "—"} written to?
      </h2>
      <div className="mt-1 text-[13px] text-slate-400">
        {item.date} · <span className="text-slate-200">${(item.amount || 0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
      </div>
      <input
        value={payee}
        onChange={(e) => setPayee(e.target.value)}
        placeholder="Start typing a payee"
        data-testid="reviewv2-check-payee"
        className="mt-4 w-full bg-slate-800/60 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
      />
      {item.recent_payees?.length > 0 && (
        <div className="mt-2 text-[11px] text-slate-500">
          Recent payees: {item.recent_payees.join(", ")}
        </div>
      )}
      <button
        onClick={() => onAnswer(`payee:${payee || "unknown"}`)}
        disabled={!payee.trim()}
        data-testid="reviewv2-check-save"
        className="mt-3 px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium"
      >
        Save payee
      </button>
    </div>
  );
}
