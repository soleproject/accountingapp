import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useActionListener, emitAction } from "@/lib/createBus";
import { useAiFocus } from "@/lib/aiFocus";
import { stripMarkdownForSpeech } from "@/lib/speechText";
import { Sparkles, PlayCircle, ArrowRight, Loader2, ListOrdered, LayoutList, Focus } from "lucide-react";
import { AccountInfoTooltip } from "@/components/AccountInfoTooltip";
import { accountDefinition } from "@/lib/accountDefinitions";

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
    return `${action.count} rows are still uncategorized — click Let's review to focus the table on them.`;
  if (action.kind === "filter_flagged")
    return `${action.count} rows are still flagged for review — click Let's review to focus the table on them (or Individual Review for a guided walkthrough).`;
  return action.why || action.label;
}

export default function CleanupCopilot({ currentId, onApplyAction, onStartSession, autoTrigger, inline = false, reportHeader = null, inlineTitle = null, inlineSubtitle = null, initialViewMode = null }) {
  const navigate = useNavigate();
  const { focus } = useAiFocus();
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
  // Bucket list view mode:
  //   "rows"     → flat list ordered by row count desc (the AI's original order)
  //   "category" → grouped by effective account code so all buckets going
  //                to e.g. "6800 · Supplies & Materials" cluster together
  const [megaViewMode, setMegaViewMode] = useState(initialViewMode || (inline ? "category" : "rows"));
  // Stepper mode: which group index is currently focused. Only used when
  // megaViewMode === "stepper". Reset to 0 whenever the mode is entered
  // or the underlying group list is refreshed.
  const [focusedGroupIdx, setFocusedGroupIdx] = useState(0);
  const [megaUndo, setMegaUndo] = useState(null);  // {batch_id, count, rules_created, expires}
  // Per-vendor category overrides: Map<contact_id, account_id>. When present,
  // the mega-approve call sends `overrides` and the vendor's row gets
  // recategorized to the target account (and snapshotted for Undo).
  const [megaOverrides, setMegaOverrides] = useState({});
  // Guided-tour ("How To") state — non-null means a walkthrough is running
  // and this step's UI element gets the rainbow highlight. `howToTargetKey`
  // holds the vendor row we're using as the demo subject (the first bucket
  // in the preview) so we can highlight sub-elements of that specific row.
  const [howToStep, setHowToStep] = useState(null);
  const [howToRunning, setHowToRunning] = useState(false);
  const [howToTargetKey, setHowToTargetKey] = useState(null);
  const howToAbortRef = useRef(false);
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

  // Approve every bucket in a category group in one request. Same
  // optimistic-then-rollback pattern as `approveOne` — we build the
  // keys array + overrides map from the group's vendors, remove them
  // from the modal state up-front, and roll back on failure.
  const approveGroup = async (group) => {
    if (!currentId || !group?.vendors?.length) return;
    const vendors = group.vendors;
    const keySet = new Set(vendors.map(v => v.key));
    const overrides = {};
    for (const v of vendors) {
      const o = megaOverrides[v.key];
      if (o) overrides[v.key] = o;
    }
    // Optimistic pop.
    const removedTotals = vendors.reduce(
      (acc, v) => {
        acc.rows += v.count;
        acc.amt += v.amount;
        return acc;
      },
      { rows: 0, amt: 0 },
    );
    setMegaPreview(mp => mp ? {
      ...mp,
      vendors: mp.vendors.filter(v => !keySet.has(v.key)),
      total_rows: mp.total_rows - removedTotals.rows,
      total_buckets: (mp.total_buckets || 0) - vendors.length,
      total_amount: mp.total_amount - removedTotals.amt,
    } : mp);
    setMegaSelected(prev => {
      const n = new Set(prev);
      for (const k of keySet) n.delete(k);
      return n;
    });
    try {
      const r = await api.post(
        `/companies/${currentId}/transactions/bulk-approve-ai-ready`,
        {
          dry_run: false,
          keys: Array.from(keySet),
          auto_create_rules: autoCreateRules,
          ...(Object.keys(overrides).length ? { overrides } : {}),
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
      // Stepper: the approved group is filtered out — the same index
      // now points at the next group. Clamp so we don't overshoot the end.
      if (megaViewMode === "stepper") {
        setFocusedGroupIdx(idx => Math.max(0, Math.min(idx, (megaGroups?.length || 1) - 2)));
      }
    } catch (e) {
      // Roll back — put vendors back at the top and re-select them.
      setMegaPreview(mp => mp ? {
        ...mp,
        vendors: [...vendors, ...mp.vendors],
        total_rows: mp.total_rows + removedTotals.rows,
        total_buckets: (mp.total_buckets || 0) + vendors.length,
        total_amount: mp.total_amount + removedTotals.amt,
      } : mp);
      window.dispatchEvent(new CustomEvent("axiom:toast",
        { detail: { message: `Couldn't approve group. Try again.`, type: "error" } }));
    }
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

  // Refs for the mega-approve listener below — allows the AI voice
  // command "approve this" (with a bucket focus) to fire this same
  // function without stale-closure issues from the empty-deps listener.
  const approveOneRef = useRef(() => {});
  const megaPreviewRef = useRef(null);
  useEffect(() => { approveOneRef.current = approveOne; });
  useEffect(() => { megaPreviewRef.current = megaPreview; });
  useActionListener("mega-approve-bucket", (payload) => {
    const key = payload?.key;
    if (!key) return;
    const preview = megaPreviewRef.current;
    if (!preview) return;
    const vendor = (preview.vendors || []).find(v => v.key === key);
    if (vendor) approveOneRef.current(vendor);
  });

  // ---- Guided "How To" tour ----------------------------------------
  // The user hits "How To" at the top of the mega-approve modal and the
  // AI narrates through the screen, highlighting each element as it goes.
  // We use browser TTS directly so we can await utterance-end and step
  // forward at natural pauses.
  const HOWTO_STEPS = [
    { text: "These are all the transactions the AI has already categorized for you, grouped by vendor. Let's walk through what you can do here." },
    { text: "The green checkbox on the left means this vendor's transactions are included in the batch approval. Uncheck any vendor you want to exclude." },
    { text: "Next to the vendor name is the category the AI picked. If you disagree, click the dropdown to change how this vendor's transactions will be booked." },
    { text: "The small info icon opens a tooltip explaining what that category means in plain English — handy when you're not sure whether something belongs in Supplies or Cost of Goods." },
    { text: "To the right you can see how many transactions this vendor covers, along with the total dollar amount they represent." },
    { text: "Click the sparkle icon if you want to ask the AI a question about this vendor's categorization or the transactions themselves. It focuses the AI on that bucket so you can just start talking." },
    { text: "You can also approve any individual bucket right here without waiting to reach the bottom — just click the Approve arrow next to the row." },
    { text: "When you're ready, hit the big green Approve button at the bottom. That'll approve every checked vendor at once, and if the auto-create rules toggle is on, it also builds rules so future transactions from these vendors land in the right place automatically. That's usually 80% or more of your cleanup, done in one click." },
  ];
  const cancelHowTo = () => {
    howToAbortRef.current = true;
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    setHowToStep(null);
    setHowToRunning(false);
    setHowToTargetKey(null);
  };
  const speakAsync = (text) => new Promise(resolve => {
    if (typeof window === "undefined" || !window.speechSynthesis) return resolve();
    const clean = stripMarkdownForSpeech(text);
    if (!clean) return resolve();
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.02; u.pitch = 1.0;
    // Prefer the "Google UK English Female (en-GB)" voice — warm, friendly
    // narration for the tour. Fall back gracefully to en-GB female /
    // en-US female / default if that specific voice isn't loaded.
    const voices = window.speechSynthesis.getVoices() || [];
    const pick =
      voices.find(v => v.name === "Google UK English Female") ||
      voices.find(v => v.name.toLowerCase().includes("uk english female")) ||
      voices.find(v => v.lang === "en-GB" && /female/i.test(v.name)) ||
      voices.find(v => v.lang === "en-GB") ||
      voices.find(v => v.lang?.startsWith("en") && /female/i.test(v.name)) ||
      null;
    if (pick) u.voice = pick;
    u.onend = resolve; u.onerror = resolve;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
  const runHowTo = async () => {
    if (howToRunning) return;
    const preview = megaPreviewRef.current;
    if (!preview || !preview.vendors?.length) return;
    // Preload voices — some browsers return an empty array on the first
    // getVoices() call and only populate after `voiceschanged` fires. Warm
    // it up here so the very first utterance already has the right voice.
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.getVoices();
      if (window.speechSynthesis.getVoices().length === 0) {
        await new Promise(r => {
          const t = setTimeout(r, 400);
          window.speechSynthesis.addEventListener("voiceschanged", () => {
            clearTimeout(t); r();
          }, { once: true });
        });
      }
    }
    // Anchor the highlight to the FIRST vendor row — simple + visually
    // consistent walkthrough.
    setHowToTargetKey(preview.vendors[0].key);
    setHowToRunning(true);
    howToAbortRef.current = false;
    // Make sure the AI panel is visible so the narration lands somewhere.
    emitAction("ai-open");
    for (let i = 0; i < HOWTO_STEPS.length; i++) {
      if (howToAbortRef.current) break;
      setHowToStep(i);
      // Post the narration into the AI chat as an assistant bubble too so
      // there's a written trail after the tour ends.
      emitAction("ai-chat-say", { message: HOWTO_STEPS[i].text });
      await speakAsync(HOWTO_STEPS[i].text);
      if (howToAbortRef.current) break;
      // Brief beat between steps so the highlight doesn't snap instantly.
      await new Promise(r => setTimeout(r, 400));
    }
    setHowToStep(null);
    setHowToRunning(false);
    setHowToTargetKey(null);
  };
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

  // Auto-trigger: when the user lands here via the Dashboard's "Flagged for
  // review" card (which adds `?auto=1`), pick the SAME action the shimmering
  // CTA would run:
  //   1. If there are AI-categorized rows queued for sign-off → open the
  //      mega-approve modal (skips the intermediate table view entirely).
  //   2. Else if there's a "Let's review" primary action → run it (filters
  //      the table to flagged rows + kicks off the inquiry chat).
  // Fires ONCE per component mount so re-renders don't re-open the modal.
  const autoFiredRef = useRef(false);
  useEffect(() => {
    if (!autoTrigger || autoFiredRef.current || !data) return;
    const aiReady = data?.progress?.mega_ready_rows || 0;
    if (aiReady > 0) {
      autoFiredRef.current = true;
      openMega();
    } else if (primary) {
      autoFiredRef.current = true;
      onApplyAction?.(primary);
    }
  }, [autoTrigger, data, primary, onApplyAction]);

  // Inline mode (dedicated /accounting/review-report page): auto-open the
  // bucket report as soon as the copilot has scanned the books, and
  // re-open whenever the book changes (unlike the modal, we don't want
  // the report to close permanently after one dry-run).
  const inlineOpenRef = useRef(false);
  useEffect(() => {
    if (!inline || !data) return;
    if (megaPreview) return;      // already open
    if (inlineOpenRef.current) return;
    inlineOpenRef.current = true;
    openMega();
  }, [inline, data, megaPreview]);
  useEffect(() => {
    // Reset the guard when the current company changes so re-selecting a
    // company on the report page re-fires the dry-run.
    inlineOpenRef.current = false;
  }, [currentId]);
  // Derived state for the mega-approve modal (kept out of state so it stays
  // in sync with megaSelected + megaSearch without an effect).
  const megaVendors = megaPreview?.vendors || [];
  const filteredVendors = megaSearch.trim()
    ? megaVendors.filter(v => (v.contact_name || "").toLowerCase().includes(megaSearch.trim().toLowerCase()))
    : megaVendors;

  // When view mode = "category", cluster filteredVendors into groups keyed by
  // their effective account (user override wins over AI pick). Each group
  // header shows the account name + how many buckets/rows sit under it, so
  // the user can eyeball outliers ("why does Owner's Draw have 3 vendors?").
  // We do it here — not in a memo — because filteredVendors is already
  // recomputed on every render (cheap enough at ~200 vendors max).
  const megaGroups = (() => {
    if (megaViewMode !== "category" && megaViewMode !== "stepper") return null;
    const map = new Map();
    for (const v of filteredVendors) {
      const overrideId = megaOverrides[v.key];
      const acct = overrideId
        ? accounts.find(a => a.id === overrideId)
        : accounts.find(a => a.id === v.account?.id)
          || accounts.find(a => String(a.code) === String(v.account?.code))
          || v.account;
      const gkey = acct?.id || acct?.code || "__none__";
      if (!map.has(gkey)) {
        map.set(gkey, { account: acct, vendors: [], totalRows: 0, totalAmount: 0 });
      }
      const g = map.get(gkey);
      g.vendors.push(v);
      g.totalRows += v.count;
      g.totalAmount += v.amount;
    }
    // Sort groups by total rows desc (biggest categories first).
    return Array.from(map.values()).sort((a, b) => b.totalRows - a.totalRows);
  })();
  const selectedRows = megaVendors.reduce(
    (s, v) => s + (megaSelected.has(v.key) ? v.count : 0), 0
  );
  const selectedAmount = megaVendors.reduce(
    (s, v) => s + (megaSelected.has(v.key) ? v.amount : 0), 0
  );
  const selectedBuckets = megaVendors.reduce(
    (s, v) => s + (megaSelected.has(v.key) ? 1 : 0), 0
  );

  // Extracted so the mega-approve UI can render either as a fixed-
  // position modal (default) or inline as a page section (when the
  // parent passes `inline`).
  const renderMegaBody = () => (
    <>
            {megaPreview.total_rows === 0 ? (
              <>
                <div className="text-base font-semibold text-slate-900 mb-1">Nothing to approve</div>
                <div className="text-sm text-slate-600 mb-4">No AI-categorized-unreviewed rows found for vendors with a unanimous AI opinion. You're clean.</div>
                {!inline && (
                  <button onClick={() => setMegaPreview(null)}
                          className="w-full py-2 rounded-md bg-slate-900 text-white text-sm font-medium">Close</button>
                )}
              </>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3 mb-1">
                  <div className="text-base font-semibold text-slate-900">
                    Approve <span data-testid="mega-selected-rows">{selectedRows.toLocaleString()}</span> rows across <span data-testid="mega-selected-vendors">{selectedBuckets}</span> {selectedBuckets === 1 ? "bucket" : "buckets"}?
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {/* View-mode toggle: order-by-rows vs. group-by-category.
                        Tiny paired icon-buttons that visually echo the
                        "How To" button on the right so the header row
                        doesn't feel unbalanced. */}
                    <div className="inline-flex rounded-md border border-slate-200 bg-white overflow-hidden">
                      <button
                        data-testid="mega-view-rows"
                        onClick={() => setMegaViewMode("rows")}
                        title="Sort by row count (most rows first)"
                        className={`p-1.5 transition ${
                          megaViewMode === "rows"
                            ? "bg-slate-900 text-white"
                            : "text-slate-500 hover:bg-slate-50"
                        }`}
                      >
                        <ListOrdered size={14} />
                      </button>
                      <button
                        data-testid="mega-view-category"
                        onClick={() => setMegaViewMode("category")}
                        title="Group buckets by category"
                        className={`p-1.5 transition border-l border-slate-200 ${
                          megaViewMode === "category"
                            ? "bg-slate-900 text-white"
                            : "text-slate-500 hover:bg-slate-50"
                        }`}
                      >
                        <LayoutList size={14} />
                      </button>
                      <button
                        data-testid="mega-view-stepper"
                        onClick={() => { setMegaViewMode("stepper"); setFocusedGroupIdx(0); }}
                        title="Review one category at a time (stepper)"
                        className={`p-1.5 transition border-l border-slate-200 ${
                          megaViewMode === "stepper"
                            ? "bg-slate-900 text-white"
                            : "text-slate-500 hover:bg-slate-50"
                        }`}
                      >
                        <Focus size={14} />
                      </button>
                    </div>
                    {howToRunning ? (
                      <button
                        data-testid="mega-howto-cancel"
                        onClick={cancelHowTo}
                        className="text-xs px-2 py-1 rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                      >
                        Stop tour
                      </button>
                    ) : (
                      <button
                        data-testid="mega-howto"
                        onClick={runHowTo}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-fuchsia-300 bg-fuchsia-50 text-fuchsia-700 hover:bg-fuchsia-100"
                        title="Have the AI walk you through this screen"
                      >
                        <Sparkles size={12} /> How To
                      </button>
                    )}
                  </div>
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
                  {(() => {
                    // Row renderer — closes over accounts, megaSelected, etc.
                    // Same JSX regardless of view mode, just interpose group
                    // headers when megaViewMode === "category".
                    const renderRow = (c) => {
                    const on = megaSelected.has(c.key);
                    // Effective account = user override (if any) else AI's pick.
                    const overrideId = megaOverrides[c.key];
                    const effAccount = overrideId
                      ? accounts.find(a => a.id === overrideId)
                      : accounts.find(a => a.id === c.account?.id)
                        || accounts.find(a => String(a.code) === String(c.account?.code))
                        || c.account;
                    const isOverridden = !!overrideId;
                    // How-To tour: apply the rainbow-shimmer highlight to
                    // the specific sub-element being described. `hi(step)`
                    // returns the shimmer class ONLY when we're on that
                    // step AND this row is the demo-target. The row itself
                    // stays visually white for the entire tour so the
                    // sub-element highlight pops without competing green.
                    const isTourRow = howToTargetKey === c.key;
                    const isTourActive = isTourRow && howToStep !== null && howToStep < 7;
                    const hi = (step) => (isTourRow && howToStep === step ? "ai-shimmer-btn bg-white" : "");
                    return (
                      <div
                        key={c.key}
                        data-testid={`mega-vendor-${c.key}`}
                        className={`w-full flex items-center gap-2.5 rounded border px-3 py-2 text-sm transition-colors ${
                          isTourRow && howToStep === 0
                            ? "ai-shimmer-btn"
                            : isTourActive
                              ? "bg-white border-slate-200"
                              : focus?.bucket && focus.key === c.key
                                ? "ai-shimmer-btn"
                                : on
                                  ? "border-emerald-300 bg-emerald-50 hover:bg-emerald-100"
                                  : "border-slate-200 bg-slate-50 opacity-60 hover:opacity-100 hover:bg-slate-100"
                        }`}
                      >
                        <button
                          onClick={() => toggleVendor(c.key)}
                          className={`w-4 h-4 rounded flex items-center justify-center text-white text-[10px] shrink-0 ${on ? "bg-emerald-600" : "bg-slate-300"} ${hi(1)}`}
                          title={on ? "Exclude from batch" : "Include in batch"}
                        >
                          {on ? "✓" : ""}
                        </button>
                        <button
                          onClick={() => toggleVendor(c.key)}
                          className="min-w-0 shrink-0 text-left"
                          title={c.contact_name}
                        >
                          <span className="font-semibold text-slate-900 truncate max-w-[220px] inline-block align-middle">{c.contact_name}</span>
                        </button>
                        <div className={`min-w-0 flex-1 flex items-center gap-1 rounded ${hi(2)}`}>
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
                            className={`min-w-0 flex-1 max-w-[340px] px-2.5 py-1 rounded-md border text-[13px] font-medium truncate ${
                              isOverridden
                                ? "bg-amber-50 border-amber-300 text-amber-900"
                                : "bg-white border-slate-300 text-slate-800"
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
                          <span data-testid={`mega-vendor-info-${c.key}`} className={`rounded ${hi(3)}`}>
                            <AccountInfoTooltip account={effAccount} />
                          </span>
                        </div>
                        <div className={`text-right shrink-0 rounded px-1 ${hi(4)}`}>
                          <div className="font-mono-num text-slate-900 text-sm">{c.count} rows</div>
                          <div className="font-mono-num text-slate-500 text-xs">${c.amount.toLocaleString("en-US", {maximumFractionDigits: 0})}</div>
                        </div>
                        <button
                          data-testid={`mega-vendor-ai-${c.key}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            emitAction("ai-open");
                            emitAction("ai-tell-me-about-bucket", {
                              bucket: {
                                key: c.key,
                                contact_name: c.contact_name,
                                count: c.count,
                                amount: c.amount,
                                account_code: effAccount?.code,
                                account_name: effAccount?.name,
                                account_type: effAccount?.type,
                                is_overridden: isOverridden,
                                ai_original_code: c.account?.code,
                                ai_original_name: c.account?.name,
                              },
                            });
                          }}
                          className={`ml-1 p-1 rounded hover:bg-fuchsia-100 text-fuchsia-600 shrink-0 ${hi(5)}`}
                          title={`Ask AI about the ${c.contact_name} bucket`}
                        >
                          <Sparkles size={14} />
                        </button>
                        <button
                          data-testid={`mega-vendor-approve-${c.key}`}
                          onClick={() => approveOne(c)}
                          className={`ml-1 shrink-0 text-emerald-700 hover:text-emerald-900 text-sm font-semibold hover:underline rounded px-1 ${hi(6)}`}
                          title={`Approve ${c.count} rows now${isOverridden ? " (with override)" : ""}`}
                        >
                          Approve →
                        </button>
                      </div>
                    );
                    };
                    if (filteredVendors.length === 0) {
                      return (
                        <div className="text-[11px] text-slate-500 text-center py-4">
                          No vendors match &quot;{megaSearch}&quot;
                        </div>
                      );
                    }
                    if (megaViewMode === "stepper" && megaGroups) {
                      // Stepper: show ONE group + info card + prev/next nav.
                      // Clamp the index in case the list shrank underneath us.
                      const idx = Math.min(focusedGroupIdx, megaGroups.length - 1);
                      const g = megaGroups[idx];
                      if (!g) {
                        return (
                          <div className="text-center py-10 text-slate-500 text-sm" data-testid="stepper-done">
                            <div className="text-emerald-700 font-semibold text-base mb-1">All groups reviewed 🎉</div>
                            Nothing left to approve in this cycle.
                          </div>
                        );
                      }
                      return (
                        <div data-testid={`mega-stepper-${g.account?.code || "none"}`}>
                          {/* Info card was moved to the page header (top-right,
                              next to the "AI Cleanup Review" title). Only the
                              navigation and rows render here. */}
                          <div className="flex items-center gap-2 mb-3">
                            <button
                              data-testid={`stepper-prev`}
                              onClick={() => setFocusedGroupIdx(i => Math.max(0, i - 1))}
                              disabled={idx === 0}
                              className="text-xs px-3 py-1.5 rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                            >
                              ← Previous
                            </button>
                            <button
                              data-testid={`stepper-next`}
                              onClick={() => setFocusedGroupIdx(i => Math.min(megaGroups.length - 1, i + 1))}
                              disabled={idx >= megaGroups.length - 1}
                              className="text-xs px-3 py-1.5 rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                            >
                              Skip to next →
                            </button>
                            <button
                              data-testid={`stepper-approve-group`}
                              onClick={() => approveGroup(g)}
                              className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 text-xs font-semibold"
                            >
                              Approve group ({g.vendors.length}) →
                            </button>
                          </div>
                          <div className="space-y-1">
                            {g.vendors.map(renderRow)}
                          </div>
                          {/* Duplicate the nav at the bottom so the CPA
                              doesn't have to scroll back up after
                              inspecting a long bucket list. */}
                          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-100">
                            <button
                              data-testid="stepper-prev-bottom"
                              onClick={() => setFocusedGroupIdx(i => Math.max(0, i - 1))}
                              disabled={idx === 0}
                              className="text-xs px-3 py-1.5 rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                            >
                              ← Previous
                            </button>
                            <button
                              data-testid="stepper-next-bottom"
                              onClick={() => setFocusedGroupIdx(i => Math.min(megaGroups.length - 1, i + 1))}
                              disabled={idx >= megaGroups.length - 1}
                              className="text-xs px-3 py-1.5 rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                            >
                              Skip to next →
                            </button>
                            <button
                              data-testid="stepper-approve-group-bottom"
                              onClick={() => approveGroup(g)}
                              className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 text-xs font-semibold"
                            >
                              Approve group ({g.vendors.length}) →
                            </button>
                          </div>
                        </div>
                      );
                    }
                    if (megaViewMode === "category" && megaGroups) {
                      return megaGroups.map(g => (
                        <div key={g.account?.id || g.account?.code || "__none__"} className="mb-2">
                          <div
                            className="sticky top-0 z-10 bg-slate-100 border border-slate-200 rounded-t px-3 py-1.5 flex items-center gap-2 text-[11px]"
                            data-testid={`mega-group-${g.account?.code || "none"}`}
                          >
                            <span className="font-semibold text-slate-800">
                              {g.account?.code ? `${g.account.code} · ` : ""}{g.account?.name || "Uncategorized"}
                            </span>
                            <span className="text-slate-500 tabular-nums">
                              {g.totalRows.toLocaleString()} rows · {g.vendors.length} {g.vendors.length === 1 ? "bucket" : "buckets"} · ${Math.round(g.totalAmount).toLocaleString()}
                            </span>
                            <button
                              data-testid={`mega-group-approve-${g.account?.code || "none"}`}
                              onClick={() => approveGroup(g)}
                              className="ml-auto shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 text-[11px] font-semibold transition"
                              title={`Approve all ${g.vendors.length} ${g.vendors.length === 1 ? "bucket" : "buckets"} (${g.totalRows} rows) under ${g.account?.name || "this category"}`}
                            >
                              Approve group →
                            </button>
                          </div>
                          <div className="space-y-1">
                            {g.vendors.map(renderRow)}
                          </div>
                        </div>
                      ));
                    }
                    return filteredVendors.map(renderRow);
                  })()}
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
                  {!inline && (
                    <button
                      data-testid="mega-approve-cancel"
                      onClick={() => setMegaPreview(null)}
                      disabled={megaBusy}
                      className="flex-1 py-2 rounded-md border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    data-testid="mega-approve-confirm"
                    onClick={applyMega}
                    disabled={megaBusy || megaSelected.size === 0}
                    className={`flex-1 py-2 rounded-md bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50 ${howToStep === 7 ? "ai-shimmer-btn" : ""}`}
                  >
                    {megaBusy ? "Approving…" : `Approve ${selectedRows.toLocaleString()} rows`}
                  </button>
                </div>
              </>
            )}
    </>
  );

  return (
    <>
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
                onClick={() => {
                  // On the Transactions page (`!inline`) route to the
                  // dedicated review page instead of opening the modal
                  // in place — the modal is now the AI Cleanup Review
                  // report living at its own URL.
                  if (!inline) {
                    navigate("/accounting/ai-cleanup-review");
                  } else {
                    openMega();
                  }
                }}
                disabled={megaBusy}
                className={
                  shimmerApprove
                    ? "ai-shimmer-btn inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md disabled:opacity-50"
                    : "inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                }
                title={
                  hasApprove
                    ? `${aiReadyCount} AI-categorized rows waiting for sign-off`
                    : "Approve every vendor whose AI opinion is unanimous"
                }
              >
                {shimmerApprove && <Sparkles size={13} className="text-fuchsia-500" />}
                {megaBusy ? "Scanning…" : "Approve AI Categorized"}
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
                    : "inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }
              >
                {shimmerFixNow && <Sparkles size={13} className="text-fuchsia-500" />}
                Let's review <ArrowRight size={13} />
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
            <PlayCircle size={13} /> Individual Review
          </button>
        </div>
      </div>

      {rest.length > 0 && !inline && (
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
    </div>
    {megaPreview && (
      inline ? (
        // Inline rendering: two-column header (title left, group info
        // card right) followed by the report body. The group info card
        // is only meaningful in stepper mode — otherwise it's suppressed
        // so the header collapses to a single-column title.
        (() => {
          let currentGroup = null;
          if (megaViewMode === "stepper" && megaGroups && megaGroups.length > 0) {
            const idx = Math.min(focusedGroupIdx, megaGroups.length - 1);
            currentGroup = megaGroups[idx];
          }
          return (
            <>
              {(inlineTitle || currentGroup) && (
                <div className="mt-6 mb-3 flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    {inlineTitle && (
                      <h1 className="text-3xl font-heading font-bold text-slate-900 leading-tight">
                        {inlineTitle}
                      </h1>
                    )}
                    {inlineSubtitle && (
                      <div className="text-sm text-slate-500 mt-1">
                        {inlineSubtitle}
                      </div>
                    )}
                  </div>
                  {currentGroup && (
                    <div
                      className="w-[420px] shrink-0 rounded-lg bg-white border border-cyan-400 ring-1 ring-cyan-100 shadow-sm px-4 py-3"
                      data-testid="stepper-info-card"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                          Group {Math.min(focusedGroupIdx, megaGroups.length - 1) + 1} of {megaGroups.length}
                        </span>
                        <span className="text-[10px] text-slate-500 tabular-nums">
                          {currentGroup.totalRows.toLocaleString()} rows · {currentGroup.vendors.length} {currentGroup.vendors.length === 1 ? "bucket" : "buckets"} · ${Math.round(currentGroup.totalAmount).toLocaleString()}
                        </span>
                      </div>
                      <div className="mt-0.5 font-heading font-semibold text-base text-slate-900 truncate">
                        {currentGroup.account?.code ? `${currentGroup.account.code} · ` : ""}{currentGroup.account?.name || "Uncategorized"}
                      </div>
                      {(() => {
                        const def = currentGroup.account ? accountDefinition(currentGroup.account) : null;
                        return def ? (
                          <div className="text-[11px] text-slate-600 mt-1 leading-snug line-clamp-3">
                            {def}
                          </div>
                        ) : null;
                      })()}
                    </div>
                  )}
                </div>
              )}
              {reportHeader}
              <div className="mt-4" data-testid="mega-approve-inline">
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col p-5">
                  {renderMegaBody()}
                </div>
              </div>
            </>
          );
        })()
      ) : (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[2px] flex items-center justify-center p-4"
             data-testid="mega-approve-modal"
             onClick={() => !megaBusy && setMegaPreview(null)}>
          <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[92vh] flex flex-col p-5"
               onClick={(e) => e.stopPropagation()}>
            {renderMegaBody()}
          </div>
        </div>
      )
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
    </>
  );
}
