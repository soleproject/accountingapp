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
import { useEffect, useMemo, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { transformBatchToV2 } from "@/lib/reviewV2Transform";
import { toast } from "sonner";
import {
  CheckCircle2, Circle, AlertTriangle, ArrowLeftRight,
  Loader2, HelpCircle, ExternalLink, Info, Keyboard,
  ArrowDownRight, ArrowUpRight, ChevronRight,
} from "lucide-react";

// ---------------------------------------------------------------- Page

export default function ReviewV2Lab() {
  const { currentId, current } = useCompany();
  const [batch, setBatch]         = useState(null);
  const [loading, setLoading]     = useState(true);
  const [previewMode, setPreview] = useState(false);
  const [stage, setStage]         = useState(1);
  const [cursor, setCursor]       = useState(0);
  const [answers, setAnswers]     = useState({});   // item_id → answer_key

  useEffect(() => {
    if (!currentId) return;
    let ok = true;
    setLoading(true);
    api.get(`/client-review/latest-for-company/${currentId}`)
      .then(async (r) => {
        if (!ok) return;
        if (!r.data?.has_pending) { setBatch(null); return; }
        // Fetch the full batch (items[]) via the client-review pending
        // endpoint — pro-scoped alt for previews.
        const full = await api.get(`/client-review/by-id/${r.data.batch_id}`)
                              .catch(() => ({ data: null }));
        setBatch(full.data || null);
      })
      .catch(() => setBatch(null))
      .finally(() => { if (ok) setLoading(false); });
    return () => { ok = false; };
  }, [currentId]);

  const model = useMemo(() => transformBatchToV2(batch), [batch]);

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

  // Auto-advance across stages: when a stage has no items OR the
  // cursor runs past the end, jump to the next non-empty stage.
  useEffect(() => {
    if (!activeItem && currentList.length === 0 && stage < 3) {
      setStage(stage + 1); setCursor(0);
    }
  }, [activeItem, currentList.length, stage]);

  const answer = useCallback((itemId, key) => {
    setAnswers(a => ({ ...a, [itemId]: key }));
    if (previewMode) return;  // preview never mutates the real batch
    // Real answer wiring lands with the magic-link route. For lab
    // testing we just stash locally + toast so we can walk the flow.
    toast.success("Recorded (lab preview — nothing was posted)");
  }, [previewMode]);

  const advance = useCallback(() => {
    if (cursor + 1 < currentList.length) {
      setCursor(cursor + 1);
    } else if (stage < 3) {
      setStage(stage + 1); setCursor(0);
    } else {
      toast.success("Review complete (lab preview)");
    }
  }, [cursor, currentList.length, stage]);

  // Keyboard shortcuts — 1-9 trigger the Nth answer option on the
  // active card, S skips, A asks accountant.
  useEffect(() => {
    if (!activeItem) return;
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key, 10) - 1;
        const opts = _optionsFor(stage, activeItem);
        if (opts[idx]) { answer(activeItem.pair_id || activeItem.group_id || activeItem.one_off_id, opts[idx].key); advance(); }
      } else if (e.key === "s" || e.key === "S") {
        advance();
      } else if (e.key === "a" || e.key === "A") {
        answer(activeItem.pair_id || activeItem.group_id || activeItem.one_off_id, "ask_accountant");
        advance();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeItem, stage, answer, advance]);

  if (loading) {
    return <PageShell><div className="text-slate-400 text-sm flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading batch for {current?.name}…</div></PageShell>;
  }
  if (!batch) {
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
      {/* Lab-only banner — never shown to the client */}
      {!previewMode && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-800/40 bg-amber-950/30 px-3 py-2 text-[12px] text-amber-200">
          <Info size={14} className="mt-0.5 shrink-0" />
          <div className="flex-1">
            <b>Lab preview</b> — this route reshapes the live batch through
            the v2 transform. Answers are not posted. Toggle "Preview as
            client" to hide these CPA affordances.
            {model.unsupported_flags.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-amber-300/80 list-disc pl-4">
                {model.unsupported_flags.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            )}
          </div>
          <button
            onClick={() => setPreview(true)}
            className="shrink-0 px-2 py-1 rounded bg-amber-800/40 hover:bg-amber-800/60 text-amber-100 text-[11px]"
            data-testid="reviewv2-preview-toggle"
          >
            Preview as client →
          </button>
        </div>
      )}
      {previewMode && (
        <button onClick={() => setPreview(false)}
                className="mb-3 text-[11px] text-slate-400 hover:text-slate-200"
                data-testid="reviewv2-exit-preview">
          ← Exit preview mode
        </button>
      )}

      <ProgressBar model={model} />

      <div className="mt-6 grid grid-cols-[220px_1fr] gap-6">
        <StageSidebar
          stages={stageList}
          activeStage={stage}
          onPick={(n) => { setStage(n); setCursor(0); }}
          hideKeys={previewMode}
        />

        <div>
          {activeItem ? (
            <CardRenderer
              stage={stage}
              item={activeItem}
              stageIdx={cursor + 1}
              stageTotal={currentList.length}
              onAnswer={(key) => {
                answer(activeItem.pair_id || activeItem.group_id || activeItem.one_off_id, key);
                advance();
              }}
              onSkip={advance}
              onAskAccountant={() => {
                answer(activeItem.pair_id || activeItem.group_id || activeItem.one_off_id, "ask_accountant");
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
        <h1 className="text-lg font-heading font-semibold text-slate-100 mb-1">
          Review v2 · Lab
        </h1>
        <p className="text-[12px] text-slate-500 mb-6">
          Parallel 3-stage flow — proposal in <code className="text-slate-300">Pics.zip</code>.
          Live at <code className="text-slate-300">/accounting/lab/review-v2</code>.
        </p>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Bits

function ProgressBar({ model }) {
  const pct = model.progress.pct_confirmed;
  const left = model.progress.questions_left;
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
      <div className="mt-1.5 text-[11px] text-slate-500 flex items-center gap-1.5">
        AI already handled {model.ai_handled_rows.toLocaleString()} high-confidence rows.{" "}
        <button className="text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline inline-flex items-center gap-0.5">
          View log to undo any of them <ExternalLink size={10} />
        </button>
      </div>
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

// ---------------------------------------------------------- Card Renderer

function CardRenderer({ stage, item, stageIdx, stageTotal, onAnswer, onSkip, onAskAccountant }) {
  const stageLabel =
      stage === 1 ? "Your accounts"
    : stage === 2 ? "Confirm patterns"
    :               "A few one-offs";
  const opts = _optionsFor(stage, item);

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 md:p-6"
         data-testid={`reviewv2-card-stage-${stage}`}>
      <div className="flex items-baseline justify-between text-[11px] text-slate-500">
        <div>{stageLabel} · {stageIdx} of {stageTotal}</div>
        {stage === 2 && <div>Sorted by dollars</div>}
      </div>

      {stage === 1 && <Stage1Body item={item} />}
      {stage === 2 && <Stage2Body item={item} />}
      {stage === 3 && <Stage3Body item={item} onAnswer={onAnswer} />}

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

      <div className="mt-5 flex items-center justify-between text-[12px]">
        <button onClick={onSkip} className="text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline" data-testid="reviewv2-skip">
          Skip for now
        </button>
        <button onClick={onAskAccountant} className="text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline" data-testid="reviewv2-ask">
          Ask my accountant
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------ Stage 1 · account pair
function Stage1Body({ item }) {
  return (
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

// ------------------------------------------------- Stage 2 · pattern group
function Stage2Body({ item }) {
  const relationshipQuestion = item.is_mixed || !item.ai_suggestion;
  return (
    <div className="mt-2">
      <h2 className="text-xl md:text-2xl font-heading font-semibold text-slate-100">
        {relationshipQuestion
          ? <>Who is <span className="text-blue-300">{item.label}</span> to your business?</>
          : <>Categorize <span className="text-blue-300">{item.label}</span></>}
      </h2>
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
