import { useEffect, useState, useRef } from "react";
import { api } from "@/lib/api";
import { useActionListener } from "@/lib/createBus";
import { Sparkles, PlayCircle, ArrowRight, Loader2 } from "lucide-react";

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
  return action.why || action.label;
}

export default function CleanupCopilot({ currentId, onApplyAction, onStartSession }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(new Set());
  const [megaPreview, setMegaPreview] = useState(null);
  const [megaBusy, setMegaBusy] = useState(false);
  const openMega = async () => {
    if (megaBusy || !currentId) return;
    setMegaBusy(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/transactions/bulk-approve-ai-ready`,
        { dry_run: true }
      );
      if (!r.data?.total_rows) {
        // Nothing AI-ready → sentinel so the button hides after click.
        setMegaPreview({ total_rows: 0 });
      } else {
        setMegaPreview(r.data);
      }
    } catch (e) { /* silent */ } finally { setMegaBusy(false); }
  };
  const applyMega = async () => {
    if (megaBusy || !currentId) return;
    setMegaBusy(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/transactions/bulk-approve-ai-ready`,
        { dry_run: false }
      );
      setMegaPreview(null);
      load(); // reload the copilot band
      // Broadcast so the Transactions page + AI panel refresh their grids.
      window.dispatchEvent(new CustomEvent("axiom:action",
        { detail: { kind: "txns:changed", at: Date.now() } }));
      // Toast-style banner via existing bus.
      window.dispatchEvent(new CustomEvent("axiom:toast",
        { detail: { message: `Approved ${r.data?.updated || 0} rows across ${r.data?.total_contacts || 0} vendors.` } }));
    } catch (e) { /* silent */ } finally { setMegaBusy(false); }
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
    if (cid) {
      // Match the same dismissal key format used below when filtering
      // the top_actions list.
      setDismissed(prev => {
        const next = new Set(prev);
        next.add(`contact_in_uncat-${cid}`);
        next.add(`contact_split-${cid}`);
        next.add(`contact_ai_ready-${cid}`);
        return next;
      });
    }
    // Reload the actions list so recently-cleared contacts drop off.
    setBusy(true);
    let latest = null;
    try {
      const r = await api.get(`/companies/${currentId}/transactions/cleanup-suggestions`);
      latest = r.data;
      setData(latest);
    } finally { setBusy(false); }

    // Then serve up the next action after a short beat so the user sees
    // the "Done — recategorized N" message before the next inquiry lands.
    const nextActions = (latest?.top_actions || []).filter(a => {
      // Skip the just-completed contact.
      if (cid && a.contact_id === cid) return false;
      // Auto-advance only through contact-scoped actions. flagged_batch is
      // a different workflow (one-at-a-time review) and repeats forever
      // when picked automatically, so leave it as a manual "Fix now" click.
      if (a.kind === "flagged_batch") return false;
      const key = `${a.kind}-${a.contact_id || a.count}`;
      return !dismissed.has(key);
    });
    const next = nextActions[0];
    if (next) {
      setTimeout(() => { onApplyRef.current?.(next); }, 1200);
    }
  });

  const actions = (data?.top_actions || []).filter(a =>
    !dismissed.has(`${a.kind}-${a.contact_id || a.count}`)
  );
  const primary = actions[0];
  const rest = actions.slice(1, 6);
  const total = data?.progress?.total || 0;

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
          {primary && (
            <button
              data-testid="cleanup-primary-cta"
              onClick={() => onApplyAction?.(primary)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md bg-slate-900 text-white hover:bg-slate-800"
            >
              Fix now <ArrowRight size={13} />
            </button>
          )}
          <button
            data-testid="cleanup-mega-approve"
            onClick={openMega}
            disabled={megaBusy}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
            title="Approve every vendor whose AI opinion is unanimous"
          >
            <Sparkles size={13} /> {megaBusy ? "Scanning…" : "Approve all AI-ready"}
          </button>
          <button
            data-testid="cleanup-start-session"
            onClick={() => onStartSession?.()}
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
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-5"
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
                  Approve {megaPreview.total_rows.toLocaleString()} rows across {megaPreview.total_contacts} vendors?
                </div>
                <div className="text-xs text-slate-500 mb-3">
                  Total volume: ${megaPreview.total_amount.toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2})}. Only vendors where the AI picked ONE consistent account are eligible — mixed-opinion vendors need manual review.
                </div>
                <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Top 5 vendors</div>
                <div className="space-y-1.5 mb-3 max-h-48 overflow-y-auto">
                  {megaPreview.top_contacts.map((c, i) => (
                    <div key={i} className="flex items-center justify-between rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium truncate">{c.contact_name}</div>
                        <div className="text-slate-500 truncate">→ {c.account?.code} {c.account?.name}</div>
                      </div>
                      <div className="text-right ml-2 shrink-0">
                        <div className="font-mono-num text-slate-900">{c.count} rows</div>
                        <div className="font-mono-num text-slate-500">${c.amount.toLocaleString("en-US", {maximumFractionDigits: 0})}</div>
                      </div>
                    </div>
                  ))}
                  {megaPreview.total_contacts > 5 && (
                    <div className="text-[11px] text-slate-500 text-center">… + {megaPreview.total_contacts - 5} more vendors</div>
                  )}
                </div>
                <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mb-3">
                  ⚠ This marks every row human-reviewed with the AI's suggested category. Review carefully — undoing individual rows afterward requires opening each one.
                </div>
                <div className="flex gap-2">
                  <button
                    data-testid="mega-approve-cancel"
                    onClick={() => setMegaPreview(null)}
                    disabled={megaBusy}
                    className="flex-1 py-2 rounded-md border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Cancel — review first
                  </button>
                  <button
                    data-testid="mega-approve-confirm"
                    onClick={applyMega}
                    disabled={megaBusy}
                    className="flex-1 py-2 rounded-md bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {megaBusy ? "Approving…" : `Approve all ${megaPreview.total_rows.toLocaleString()} rows`}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
