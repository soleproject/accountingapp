import { useEffect, useState, useRef } from "react";
import { api } from "@/lib/api";
import { useActionListener } from "@/lib/createBus";
import { Sparkles, PlayCircle, ArrowRight, Loader2 } from "lucide-react";
import { AccountInfoTooltip } from "@/components/AccountInfoTooltip";

// Compact SVG donut: reviewed (emerald), ai (indigo), uncategorized (rose),
// flagged (amber), rest of total (slate). All slice sizes are proportional
// to their share of the total transaction count.
function Donut({ progress, size = 88 }) {
  const { total, reviewed = 0, ai_categorized = 0, uncategorized = 0, flagged = 0 } = progress || {};
  const rest = Math.max(0, total - reviewed - ai_categorized - uncategorized - flagged);
  const segments = [
    { v: reviewed,      c: "#10b981" },  // emerald
    { v: ai_categorized,c: "#6366f1" },  // indigo
    { v: uncategorized, c: "#f43f5e" },  // rose
    { v: flagged,       c: "#f59e0b" },  // amber
    { v: rest,          c: "#e2e8f0" },  // slate-200
  ];
  const r = 36, cx = size / 2, cy = size / 2, circ = 2 * Math.PI * r;
  let acc = 0;
  const arcs = segments.map((s, i) => {
    const frac = total ? s.v / total : 0;
    const dash = frac * circ;
    const gap = circ - dash;
    const offset = -acc * circ;
    acc += frac;
    return (
      <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={s.c}
              strokeWidth={12} strokeDasharray={`${dash} ${gap}`} strokeDashoffset={offset}
              transform={`rotate(-90 ${cx} ${cy})`} />
    );
  });
  const pct = progress?.pct_reviewed ?? 0;
  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size}>{arcs}</svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-lg font-bold text-slate-900 leading-none">{pct}%</div>
        <div className="text-[9px] uppercase tracking-widest text-slate-500 mt-0.5">reviewed</div>
      </div>
    </div>
  );
}

const KIND_STYLES = {
  contact_in_uncat:  { chipCls: "bg-rose-50 border-rose-200 text-rose-800 hover:bg-rose-100", dot: "🔥" },
  contact_split:     { chipCls: "bg-amber-50 border-amber-200 text-amber-900 hover:bg-amber-100", dot: "🔀" },
  contact_ai_ready:  { chipCls: "bg-emerald-50 border-emerald-200 text-emerald-800 hover:bg-emerald-100", dot: "✓" },
  flagged_batch:     { chipCls: "bg-indigo-50 border-indigo-200 text-indigo-800 hover:bg-indigo-100", dot: "⚡" },
};

// Compose a friendly one-liner the AI would say if it were a bookkeeper
// standing over your shoulder.
function pitchFor(action, progress) {
  // When there are AI-categorized rows the CPA can sign off in one tap,
  // that's the biggest single-move win — pitch that ahead of any per-
  // contact cleanup. Matches the shimmering "Approve all AI-ready" button.
  const megaReady = progress?.mega_ready_rows || 0;
  if (megaReady > 0 && progress?.total) {
    const afterPct = Math.min(
      100,
      Math.round(1000 * (progress.reviewed + megaReady) / progress.total) / 10,
    );
    return `Verifying the AI categorizations for ${megaReady} transaction${megaReady === 1 ? "" : "s"} will put you at ${afterPct}% of completing the review.`;
  }
  if (!action) {
    if (!progress?.total) return "No transactions yet — connect a bank feed or drop in a statement.";
    return "Looking clean — nothing urgent flagged.";
  }
  if (action.kind === "contact_in_uncat")
    return `${action.count} ${action.contact_name} transactions are sitting in Uncategorized — knock them out in one go?`;
  if (action.kind === "contact_split")
    return `${action.contact_name} is spread across ${action.count} accounts. Want me to help consolidate?`;
  if (action.kind === "contact_ai_ready")
    return `${action.count} ${action.contact_name} transactions were AI-categorized as ${action.account?.code} ${action.account?.name} — approve them all in one tap?`;
  if (action.kind === "flagged_batch")
    return `${action.count} transactions were flagged by the AI for a human eye. Fast-review them together?`;
  if (action.kind === "filter_uncat")
    return `${action.count} rows are still uncategorized — click Fix now to focus the table on them.`;
  if (action.kind === "filter_flagged")
    return `${action.count} rows are still flagged for review — click Fix now to focus the table on them (or Start 5-min session for a guided walkthrough).`;
  return action.why || action.label;
}

export default function CleanupCopilot({ currentId, onApplyAction, onStartSession }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  // Permanent dismissal (contact was actually handled, not just skipped).
  const [dismissed, setDismissed] = useState(new Set());
  // Ordered skip queue: contact_ids skipped in FIFO order. Skipped items are
  // moved to the BACK of the queue instead of vanishing so they come back
  // after every other contact has been seen or skipped. Reset on company
  // switch so opening another client starts with a fresh queue.
  const [skippedOrder, setSkippedOrder] = useState([]);
  // Refs mirror the two above so the async cleanup-completed handler always
  // sees the LATEST values — otherwise stale-closure reads cause the queue
  // to loop back to the just-skipped contact instead of advancing.
  const skippedOrderRef = useRef([]);
  const dismissedRef = useRef(new Set());
  useEffect(() => { skippedOrderRef.current = skippedOrder; }, [skippedOrder]);
  useEffect(() => { dismissedRef.current = dismissed; }, [dismissed]);
  useEffect(() => {
    setDismissed(new Set());
    setSkippedOrder([]);
    dismissedRef.current = new Set();
    skippedOrderRef.current = [];
  }, [currentId]);
  const [megaPreview, setMegaPreview] = useState(null);
  const [megaBusy, setMegaBusy] = useState(false);
  const [megaSelected, setMegaSelected] = useState(new Set());
  const [megaSearch, setMegaSearch] = useState("");
  const [megaUndo, setMegaUndo] = useState(null);  // {batch_id, count, rules_created, expires}
  // Per-vendor category overrides: Map<contact_id, account_id>. When present,
  // the mega-approve call sends `overrides` and the vendor's row gets
  // recategorized to the target account (and snapshotted for Undo).
  const [megaOverrides, setMegaOverrides] = useState({});
  // Full CoA for the current company, loaded once when the modal opens. Used
  // for the category dropdown and the info-icon tooltip.
  const [accounts, setAccounts] = useState([]);
  // Auto-create rules on approval? User-controllable, persisted per-browser.
  const [autoCreateRules, setAutoCreateRules] = useState(() => {
    if (typeof window === "undefined") return true;
    const v = window.localStorage.getItem("axiom.mega.autoCreateRules");
    return v === null ? true : v === "1";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("axiom.mega.autoCreateRules", autoCreateRules ? "1" : "0");
    }
  }, [autoCreateRules]);
  useEffect(() => {
    // Auto-dismiss the Undo toast after 60s.
    if (!megaUndo) return;
    const t = setTimeout(() => setMegaUndo(null), 60_000);
    return () => clearTimeout(t);
  }, [megaUndo]);
  const openMega = async () => {
    if (megaBusy || !currentId) return;
    setMegaBusy(true);
    try {
      const [r, ar] = await Promise.all([
        api.post(
          `/companies/${currentId}/transactions/bulk-approve-ai-ready`,
          { dry_run: true }
        ),
        api.get(`/companies/${currentId}/accounts`),
      ]);
      // Filter out uncategorized sinks so they never appear in the override
      // dropdown — the whole point of the modal is to *get out* of them.
      const allAccounts = (ar.data?.accounts || []).filter(
        a => !["9999", "6999", "4999"].includes(String(a.code))
      );
      setAccounts(allAccounts);
      setMegaOverrides({});
      if (!r.data?.total_rows) {
        setMegaPreview({ total_rows: 0, vendors: [] });
        setMegaSelected(new Set());
      } else {
        setMegaPreview(r.data);
        // Everyone selected by default — CPA can uncheck the risky ones.
        // Selection key is the bucket key ("<contact_id>::<account_id>").
        setMegaSelected(new Set((r.data.vendors || []).map(v => v.key)));
      }
      setMegaSearch("");
    } catch (e) {
      window.dispatchEvent(new CustomEvent("axiom:toast",
        { detail: { message: "Couldn't scan AI-ready rows. Try again in a moment.", type: "error" } }));
    } finally { setMegaBusy(false); }
  };
  const applyMega = async () => {
    if (megaBusy || !currentId || megaSelected.size === 0) return;
    setMegaBusy(true);
    try {
      // Only send overrides for buckets actually being approved this round.
      const overrides = {};
      for (const k of megaSelected) {
        if (megaOverrides[k]) overrides[k] = megaOverrides[k];
      }
      const r = await api.post(
        `/companies/${currentId}/transactions/bulk-approve-ai-ready`,
        {
          dry_run: false,
          keys: Array.from(megaSelected),
          auto_create_rules: autoCreateRules,
          ...(Object.keys(overrides).length ? { overrides } : {}),
        }
      );
      setMegaPreview(null);
      setMegaSelected(new Set());
      load();
      window.dispatchEvent(new CustomEvent("axiom:action",
        { detail: { kind: "txns:changed", at: Date.now() } }));
      // Set the Undo toast — visible for 60s.
      if (r.data?.batch_id && r.data?.updated) {
        setMegaUndo({
          batch_id: r.data.batch_id,
          count: r.data.updated,
          rules_created: (r.data.rules_created || []).length,
          expires: Date.now() + 60_000,
        });
      }
    } catch (e) {
      window.dispatchEvent(new CustomEvent("axiom:toast",
        { detail: { message: "Bulk-approve failed. No rows were changed.", type: "error" } }));
    } finally { setMegaBusy(false); }
  };
  const undoMega = async () => {
    if (!megaUndo || !currentId) return;
    const snapshot = megaUndo;
    setMegaUndo(null);
    try {
      const r = await api.post(
        `/companies/${currentId}/transactions/undo-mega-batch/${snapshot.batch_id}`, {}
      );
      load();
      window.dispatchEvent(new CustomEvent("axiom:action",
        { detail: { kind: "txns:changed", at: Date.now() } }));
      window.dispatchEvent(new CustomEvent("axiom:toast",
        { detail: { message: `Reverted ${r.data?.reverted || 0} rows.` } }));
    } catch (e) {
      // Restore the toast so the user can retry Undo instead of being locked out.
      setMegaUndo(snapshot);
      window.dispatchEvent(new CustomEvent("axiom:toast",
        { detail: { message: "Undo failed — try again.", type: "error" } }));
    }
  };
  const approveOne = async (vendor) => {
    if (!currentId) return;
    // Optimistic remove so the CPA can fly through the list.
    setMegaPreview(mp => mp ? {
      ...mp,
      vendors: mp.vendors.filter(v => v.key !== vendor.key),
      total_rows: mp.total_rows - vendor.count,
      total_buckets: (mp.total_buckets || 0) - 1,
      total_amount: mp.total_amount - vendor.amount,
    } : mp);
    setMegaSelected(prev => {
      const n = new Set(prev); n.delete(vendor.key); return n;
    });
    try {
      const overrideId = megaOverrides[vendor.key];
      const r = await api.post(
        `/companies/${currentId}/transactions/bulk-approve-ai-ready`,
        {
          dry_run: false,
          keys: [vendor.key],
          auto_create_rules: autoCreateRules,
          ...(overrideId ? { overrides: { [vendor.key]: overrideId } } : {}),
        }
      );
      window.dispatchEvent(new CustomEvent("axiom:action",
        { detail: { kind: "txns:changed", at: Date.now() } }));
      if (r.data?.batch_id && r.data?.updated) {
        setMegaUndo({
          batch_id: r.data.batch_id,
          count: r.data.updated,
          rules_created: (r.data.rules_created || []).length,
          expires: Date.now() + 60_000,
        });
      }
    } catch (e) {
      // Roll back the optimistic remove on failure.
      setMegaPreview(mp => mp ? {
        ...mp,
        vendors: [vendor, ...mp.vendors],
        total_rows: mp.total_rows + vendor.count,
        total_buckets: (mp.total_buckets || 0) + 1,
        total_amount: mp.total_amount + vendor.amount,
      } : mp);
      window.dispatchEvent(new CustomEvent("axiom:toast",
        { detail: { message: `Couldn't approve ${vendor.contact_name}. Try again.`, type: "error" } }));
    }
  };
  const toggleVendor = (key) => {
    setMegaSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const load = async () => {
    if (!currentId) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${currentId}/transactions/cleanup-suggestions`);
      setData(r.data);
    } finally { setBusy(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId]);

  // Auto-advance: when the AiPanel confirms a cleanup batch is done, dismiss
  // that contact from our queue, reload the actions list, and — if there's
  // another Fix Now candidate — automatically kick it off so the user rolls
  // through the queue without touching the copilot again.
  const onApplyRef = useRef(onApplyAction);
  useEffect(() => { onApplyRef.current = onApplyAction; });
  useActionListener("cleanup-completed", async (payload) => {
    const cid = payload?.contact_id;
    const wasSkip = !!payload?.skipped;
    // Compute the next skip queue + dismissed set BEFORE reading state, using
    // refs so we always see the freshest values (React state updates are
    // async — the closure could otherwise read stale data and loop back to
    // the just-skipped contact).
    let nextSkipOrder = skippedOrderRef.current.slice();
    const nextDismissed = new Set(dismissedRef.current);
    if (cid) {
      if (wasSkip) {
        nextSkipOrder = nextSkipOrder.filter(x => x !== cid);
        nextSkipOrder.push(cid);
      } else {
        nextDismissed.add(`contact_in_uncat-${cid}`);
        nextDismissed.add(`contact_split-${cid}`);
        nextDismissed.add(`contact_ai_ready-${cid}`);
        nextSkipOrder = nextSkipOrder.filter(x => x !== cid);
      }
      // Commit to state + refs. Refs first so any *synchronous* re-entry
      // during the same tick sees the new values.
      skippedOrderRef.current = nextSkipOrder;
      dismissedRef.current = nextDismissed;
      setSkippedOrder(nextSkipOrder);
      setDismissed(nextDismissed);
    }
    // Reload the actions list so recently-cleared contacts drop off.
    setBusy(true);
    let latest = null;
    try {
      const r = await api.get(`/companies/${currentId}/transactions/cleanup-suggestions`);
      latest = r.data;
      setData(latest);
    } finally { setBusy(false); }

    // Reorder: unseen contacts first, then skipped contacts in FIFO skip
    // order at the back. Only auto-advance if there's a NEW (never-skipped)
    // contact — never bounce straight back into the skip ring, otherwise a
    // 2-item queue re-serves the just-skipped item immediately.
    const eligible = (latest?.top_actions || []).filter(a => {
      if (a.kind === "flagged_batch") return false;
      const key = `${a.kind}-${a.contact_id || a.count}`;
      return !nextDismissed.has(key);
    });
    const unseen = eligible.filter(
      a => !a.contact_id || !nextSkipOrder.includes(a.contact_id)
    );
    const skippedRing = nextSkipOrder
      .map(scid => eligible.find(a => a.contact_id === scid))
      .filter(Boolean);
    const ordered = [...unseen, ...skippedRing];
    // Pick the first UNSEEN action first. Only fall back to a resurfaced-
    // skipped one when there are no unseen contacts left. Also guard against
    // instantly picking the just-skipped contact.
    let next = unseen[0];
    if (!next) {
      next = skippedRing.find(a => a.contact_id !== cid) || skippedRing[0];
    }
    if (next && next.contact_id === cid) {
      // Absolute safety net: don't re-serve the same contact we just skipped
      // on this turn. Take the next one in the ring instead.
      next = ordered.find(a => a.contact_id !== cid) || null;
    }
    if (next) {
      setTimeout(() => { onApplyRef.current?.(next); }, 1200);
    }
  });

  // Reorder actions so skipped contacts fall to the BACK (in FIFO skip
  // order). Permanent dismissals are filtered out first. `flagged_batch`
  // is deliberately excluded from the primary/rest queue — it powers the
  // one-at-a-time review, which is the "Start 5-min session" button, not
  // "Fix now" (Fix now is contact-scoped bulk cleanup only).
  const eligibleActions = (data?.top_actions || []).filter(a =>
    a.kind !== "flagged_batch"
    && !dismissed.has(`${a.kind}-${a.contact_id || a.count}`)
  );
  const unseenActions = eligibleActions.filter(
    a => !a.contact_id || !skippedOrder.includes(a.contact_id)
  );
  const skippedActions = skippedOrder
    .map(scid => eligibleActions.find(a => a.contact_id === scid))
    .filter(Boolean);
  const actions = [...unseenActions, ...skippedActions];
  // Fallback synthetic primary when no contact-scoped cleanup exists but
  // there IS still work to do — filters the transactions table to the
  // right tab so the CPA can dig in manually. This is what keeps Fix now
  // visible on companies like Bright Beans where the queue is drained of
  // per-contact clusters but flagged / uncategorized rows still linger.
  const synthPrimary = (() => {
    if (actions.length > 0) return null;
    const p = data?.progress;
    if (!p) return null;
    if (p.uncategorized > 0) {
      return {
        kind: "filter_uncat",
        count: p.uncategorized,
        label: `${p.uncategorized} uncategorized rows`,
      };
    }
    if (p.flagged > 0) {
      return {
        kind: "filter_flagged",
        count: p.flagged,
        label: `${p.flagged} flagged rows`,
      };
    }
    return null;
  })();
  const primary = actions[0] || synthPrimary;
  const rest = actions.slice(1, 6);
  const total = data?.progress?.total || 0;
  // Derived state for the mega-approve modal (kept out of state so it stays
  // in sync with megaSelected + megaSearch without an effect).
  const megaVendors = megaPreview?.vendors || [];
  const filteredVendors = megaSearch.trim()
    ? megaVendors.filter(v => (v.contact_name || "").toLowerCase().includes(megaSearch.trim().toLowerCase()))
    : megaVendors;
  const selectedRows = megaVendors.reduce(
    (s, v) => s + (megaSelected.has(v.key) ? v.count : 0), 0
  );
  const selectedAmount = megaVendors.reduce(
    (s, v) => s + (megaSelected.has(v.key) ? v.amount : 0), 0
  );
  const selectedBuckets = megaVendors.reduce(
    (s, v) => s + (megaSelected.has(v.key) ? 1 : 0), 0
  );

  return (
    <div data-testid="cleanup-copilot" className="rounded-xl border border-slate-200 bg-gradient-to-br from-indigo-50/40 via-white to-fuchsia-50/40 shadow-sm p-4">
      <div className="flex items-center gap-4 flex-wrap">
        <Donut progress={data?.progress} />
        <div className="flex-1 min-w-[280px]">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
            <Sparkles size={12} className="text-fuchsia-500" /> AI Cleanup Copilot
          </div>
          <div className="mt-1 text-sm text-slate-800 leading-snug">
            {busy && !data ? (
              <span className="inline-flex items-center gap-2 text-slate-500">
                <Loader2 size={13} className="animate-spin" /> Scanning your books…
              </span>
            ) : (
              pitchFor(primary, data?.progress)
            )}
          </div>
          {data?.progress?.total ? (
            <div className="mt-1 text-[11px] text-slate-500">
              {data.progress.reviewed} reviewed · {data.progress.ai_categorized} AI-categorized · {data.progress.uncategorized} uncategorized · {data.progress.flagged} flagged
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {(() => {
            const aiReadyCount = data?.progress?.mega_ready_rows || 0;
            const hasApprove = aiReadyCount > 0;
            const hasFixNow = !!primary;
            const shimmerApprove = hasApprove;
            const shimmerFixNow = !hasApprove && hasFixNow;

            // Build both buttons as JSX and then order them so the
            // shimmering one comes FIRST. The Sparkles/AI icon rides with
            // the shimmering CTA — the other one is plain.
            const approveBtn = (
              <button
                key="approve"
                data-testid="cleanup-mega-approve"
                onClick={openMega}
                disabled={megaBusy}
                className={
                  shimmerApprove
                    ? "ai-shimmer-btn inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md disabled:opacity-50"
                    : "inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                }
                title={
                  hasApprove
                    ? `${aiReadyCount} AI-categorized rows waiting for sign-off`
                    : "Approve every vendor whose AI opinion is unanimous"
                }
              >
                {shimmerApprove && <Sparkles size={13} className="text-fuchsia-500" />}
                {megaBusy ? "Scanning…" : "Approve all AI-ready"}
              </button>
            );
            const fixNowBtn = primary ? (
              <button
                key="fixnow"
                data-testid="cleanup-primary-cta"
                onClick={() => onApplyAction?.(primary)}
                className={
                  shimmerFixNow
                    ? "ai-shimmer-btn inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md"
                    : "inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md bg-slate-900 text-white hover:bg-slate-800"
                }
              >
                {shimmerFixNow && <Sparkles size={13} className="text-fuchsia-500" />}
                Fix now <ArrowRight size={13} />
              </button>
            ) : null;

            // Shimmering CTA goes first; the other one (if it exists) trails.
            const buttons = shimmerApprove
              ? [approveBtn, fixNowBtn]
              : [fixNowBtn, approveBtn];
            return buttons.filter(Boolean);
          })()}
          <button
            data-testid="cleanup-start-session"
            onClick={() => onStartSession?.(data?.progress?.flagged || 0)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
          >
            <PlayCircle size={13} /> Start 5-min session
          </button>
        </div>
      </div>

      {rest.length > 0 && (
        <div className="mt-3 flex items-center gap-1.5 flex-wrap">
          {rest.map((a, i) => {
            const style = KIND_STYLES[a.kind] || KIND_STYLES.flagged_batch;
            return (
              <button
                key={i}
                data-testid={`cleanup-chip-${a.kind}-${a.contact_id || i}`}
                onClick={() => onApplyAction?.(a)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-full border ${style.chipCls}`}
                title={a.why}
              >
                <span>{style.dot}</span>
                <span>{a.label}</span>
                {"count" in a && (
                  <span className="ml-0.5 px-1 rounded bg-white/60 font-mono-num">{a.count}</span>
                )}
              </button>
            );
          })}
          {total > 0 && actions.length < 3 && (
            <span className="text-[11px] text-slate-500">Nothing else urgent — you're in good shape.</span>
          )}
        </div>
      )}
      {megaPreview && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[2px] flex items-center justify-center p-4"
             data-testid="mega-approve-modal"
             onClick={() => !megaBusy && setMegaPreview(null)}>
          <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[92vh] flex flex-col p-5"
               onClick={(e) => e.stopPropagation()}>
            {megaPreview.total_rows === 0 ? (
              <>
                <div className="text-base font-semibold text-slate-900 mb-1">Nothing to approve</div>
                <div className="text-sm text-slate-600 mb-4">No AI-categorized-unreviewed rows found for vendors with a unanimous AI opinion. You're clean.</div>
                <button onClick={() => setMegaPreview(null)}
                        className="w-full py-2 rounded-md bg-slate-900 text-white text-sm font-medium">Close</button>
              </>
            ) : (
              <>
                <div className="text-base font-semibold text-slate-900 mb-1">
                  Approve <span data-testid="mega-selected-rows">{selectedRows.toLocaleString()}</span> rows across <span data-testid="mega-selected-vendors">{selectedBuckets}</span> {selectedBuckets === 1 ? "bucket" : "buckets"}?
                </div>
                <div className="text-xs text-slate-500 mb-2">
                  Total volume: ${selectedAmount.toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2})}. Each row is one <span className="font-medium">vendor × category</span> bucket — vendors split across multiple accounts appear here as separate rows so you can approve, exclude, or override each independently.
                </div>
                <div className="mb-2">
                  <input
                    data-testid="mega-vendor-search"
                    type="text"
                    value={megaSearch}
                    onChange={(e) => setMegaSearch(e.target.value)}
                    placeholder={`Filter ${megaPreview.vendors.length} buckets…`}
                    className="w-full px-2.5 py-1.5 rounded border border-slate-300 text-xs"
                  />
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1.5">
                  <span>Click a row to include/exclude · change the category pill to override</span>
                  <div className="flex gap-2">
                    <button data-testid="mega-select-all"
                            className="text-emerald-700 hover:underline"
                            onClick={() => setMegaSelected(new Set(megaPreview.vendors.map(v => v.key)))}>
                      Select all
                    </button>
                    <button data-testid="mega-select-none"
                            className="text-slate-600 hover:underline"
                            onClick={() => setMegaSelected(new Set())}>
                      None
                    </button>
                  </div>
                </div>
                <div className="space-y-1 mb-3 flex-1 min-h-[240px] overflow-y-auto pr-1" data-testid="mega-vendor-list">
                  {filteredVendors.map((c) => {
                    const on = megaSelected.has(c.key);
                    // Effective account = user override (if any) else AI's pick.
                    const overrideId = megaOverrides[c.key];
                    const effAccount = overrideId
                      ? accounts.find(a => a.id === overrideId)
                      : accounts.find(a => a.id === c.account?.id)
                        || accounts.find(a => String(a.code) === String(c.account?.code))
                        || c.account;
                    const isOverridden = !!overrideId;
                    return (
                      <div
                        key={c.key}
                        data-testid={`mega-vendor-${c.key}`}
                        className={`w-full flex items-center gap-2 rounded border px-2.5 py-1.5 text-xs transition-colors ${
                          on
                            ? "border-emerald-300 bg-emerald-50 hover:bg-emerald-100"
                            : "border-slate-200 bg-slate-50 opacity-60 hover:opacity-100 hover:bg-slate-100"
                        }`}
                      >
                        <button
                          onClick={() => toggleVendor(c.key)}
                          className={`w-4 h-4 rounded flex items-center justify-center text-white text-[10px] shrink-0 ${on ? "bg-emerald-600" : "bg-slate-300"}`}
                          title={on ? "Exclude from batch" : "Include in batch"}
                        >
                          {on ? "✓" : ""}
                        </button>
                        <button
                          onClick={() => toggleVendor(c.key)}
                          className="min-w-0 shrink-0 text-left"
                          title={c.contact_name}
                        >
                          <span className="font-medium truncate max-w-[180px] inline-block align-middle">{c.contact_name}</span>
                        </button>
                        <div className="min-w-0 flex-1 flex items-center gap-1">
                          <select
                            data-testid={`mega-vendor-cat-${c.key}`}
                            value={effAccount?.id || ""}
                            onChange={(e) => {
                              const newId = e.target.value;
                              setMegaOverrides(prev => {
                                const next = { ...prev };
                                // If user reverts to the AI's original account (by id), clear the override.
                                if (newId === c.account?.id) {
                                  delete next[c.key];
                                } else if (newId) {
                                  next[c.key] = newId;
                                }
                                return next;
                              });
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className={`min-w-0 flex-1 max-w-[280px] px-1.5 py-0.5 rounded-full border text-[10px] font-mono-num truncate ${
                              isOverridden
                                ? "bg-amber-50 border-amber-300 text-amber-900"
                                : "bg-white border-slate-200 text-slate-700"
                            }`}
                          >
                            {/* Grouped options by type for readability. */}
                            {["expense", "cogs", "revenue", "asset", "liability", "equity"].map(kind => {
                              const opts = accounts.filter(a => (a.type || "").toLowerCase() === kind);
                              if (opts.length === 0) return null;
                              return (
                                <optgroup key={kind} label={kind.toUpperCase()}>
                                  {opts.map(a => (
                                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                                  ))}
                                </optgroup>
                              );
                            })}
                          </select>
                          <span data-testid={`mega-vendor-info-${c.key}`}>
                            <AccountInfoTooltip account={effAccount} />
                          </span>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-mono-num text-slate-900">{c.count} rows</div>
                          <div className="font-mono-num text-slate-500">${c.amount.toLocaleString("en-US", {maximumFractionDigits: 0})}</div>
                        </div>
                        <button
                          data-testid={`mega-vendor-approve-${c.key}`}
                          onClick={() => approveOne(c)}
                          className="ml-2 shrink-0 text-emerald-700 hover:text-emerald-900 text-xs font-semibold hover:underline"
                          title={`Approve ${c.count} rows now${isOverridden ? " (with override)" : ""}`}
                        >
                          Approve →
                        </button>
                      </div>
                    );
                  })}
                  {filteredVendors.length === 0 && (
                    <div className="text-[11px] text-slate-500 text-center py-4">No vendors match &quot;{megaSearch}&quot;</div>
                  )}
                </div>
                <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mb-3">
                  ⚠ You&apos;ll have 60 seconds to Undo after applying. Undo restores each row&apos;s original category too.
                </div>
                <label className="flex items-center gap-2 mb-3 text-[11px] text-slate-600 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    data-testid="mega-auto-create-rules"
                    checked={autoCreateRules}
                    onChange={(e) => setAutoCreateRules(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  <span>
                    <span className="font-medium">Auto-create rules from approved buckets</span>
                    <span className="text-slate-500"> — so future {`{merchant}`} imports land on the same account automatically. Skips payment apps (Venmo / Zelle / Cash App) and ambiguous vendors. Undo removes any created rules too.</span>
                  </span>
                </label>
                <div className="flex gap-2">
                  <button
                    data-testid="mega-approve-cancel"
                    onClick={() => setMegaPreview(null)}
                    disabled={megaBusy}
                    className="flex-1 py-2 rounded-md border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    data-testid="mega-approve-confirm"
                    onClick={applyMega}
                    disabled={megaBusy || megaSelected.size === 0}
                    className="flex-1 py-2 rounded-md bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {megaBusy ? "Approving…" : `Approve ${selectedRows.toLocaleString()} rows`}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {megaUndo && (
        <div className="fixed bottom-6 right-6 z-[70] max-w-sm bg-slate-900 text-white rounded-lg shadow-2xl px-4 py-3 flex items-center gap-3"
             data-testid="mega-undo-toast">
          <div className="text-sm">
            <div className="font-semibold">
              Approved {megaUndo.count.toLocaleString()} rows
              {megaUndo.rules_created > 0 && (
                <span> · created {megaUndo.rules_created} rule{megaUndo.rules_created === 1 ? "" : "s"}</span>
              )}
            </div>
            <div className="text-slate-300 text-xs">You have 60 seconds to undo (rows + rules).</div>
          </div>
          <button
            data-testid="mega-undo-btn"
            onClick={undoMega}
            className="px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-900 text-xs font-semibold"
          >
            Undo
          </button>
          <button
            onClick={() => setMegaUndo(null)}
            className="text-slate-400 hover:text-white text-lg leading-none"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
