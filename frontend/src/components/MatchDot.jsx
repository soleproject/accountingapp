import { CheckCircle2, Clock, Unlink } from "lucide-react";

/**
 * Derive an editor-authored transaction's bank-match state from its
 * persisted fields. Used to render a consistent visual indicator
 * across the app (Sales Receipts list, Transactions ledger row when
 * showing an editor-authored row, and — in the future — anywhere
 * else a CPA needs to see reconciliation state at a glance).
 *
 * Returns { key, label, tone } where `tone` is one of:
 *   confirmed → green solid — CPA has reviewed and locked in the pair
 *   matched   → amber solid — silent matcher paired it, awaiting review
 *   unlinked  → slate slash — CPA broke a prior match, tombstoned
 *   awaiting  → amber outline — no matching bank row seen yet
 */
export function deriveMatchStatus(row) {
  if (!row) return { key: "awaiting", label: "Awaiting bank feed", tone: "awaiting" };
  if (row.match_confirmed) {
    return { key: "confirmed", label: "Reconciled", tone: "confirmed" };
  }
  if (row.matched_bank_txn_id) {
    return { key: "matched", label: "Matched · pending review", tone: "matched" };
  }
  if (row.match_unlinked_at) {
    return { key: "unlinked", label: "Manually unlinked", tone: "unlinked" };
  }
  return { key: "awaiting", label: "Awaiting bank feed", tone: "awaiting" };
}

const TONE_STYLES = {
  confirmed: { icon: CheckCircle2, cls: "text-emerald-600" },
  matched:   { icon: CheckCircle2, cls: "text-amber-500" },
  unlinked:  { icon: Unlink,       cls: "text-slate-400" },
  awaiting:  { icon: Clock,        cls: "text-amber-400" },
};

/**
 * Standalone match indicator. Two variants:
 *   `mode="full"` (default) — icon + label, used on dedicated lists.
 *   `mode="compact"` — icon only, used on dense transaction rows.
 */
export function MatchDot({ row, mode = "full", className = "" }) {
  const s = deriveMatchStatus(row);
  const style = TONE_STYLES[s.tone];
  const Ico = style.icon;
  const size = mode === "compact" ? 11 : 13;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] text-slate-600 ${className}`}
      title={s.label}
      data-testid={`match-dot-${s.key}`}
    >
      <Ico size={size} className={style.cls} />
      {mode === "full" && <span className="hidden md:inline">{s.label}</span>}
    </span>
  );
}
