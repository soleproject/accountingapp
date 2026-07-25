// Step 3a — Transfer Review. Scans the company's unreviewed txns for
// intercompany transfer pairs (same amount, opposite sign, different bank
// account, ±3 days) and lets the CPA approve pairs one-at-a-time (via
// "Inspect") or in batches (via checkboxes + "Book selected"). Nothing books
// until the user approves — this replaces the old one-click "Detect
// transfers" auto-book path.
//
// Layout template mirrors LetsReview / NoContactReview: full-width shell
// on /accounting/transfer-review. Confidence-sorted (same-day = 1.0, then
// decays linearly to 0.5 at 3-day delta).
import { useEffect, useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { ArrowLeftRight, Check, X, Info, Sparkles } from "lucide-react";
import { api, fmtMoney, fmtDate } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";

function ConfBadge({ conf, delta }) {
  const tone =
    conf >= 0.95 ? "bg-emerald-100 text-emerald-800 border-emerald-300"
    : conf >= 0.8 ? "bg-cyan-100 text-cyan-800 border-cyan-300"
    : conf >= 0.65 ? "bg-amber-100 text-amber-800 border-amber-300"
    : "bg-slate-100 text-slate-700 border-slate-300";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${tone}`}
      data-testid="transfer-conf-badge"
      title={`Date delta: ${delta} day${delta === 1 ? "" : "s"}`}
    >
      {Math.round(conf * 100)}%
      <span className="text-[9px] opacity-70">· ±{delta}d</span>
    </span>
  );
}

function InspectCard({ pair, onApprove, onReject, busy }) {
  const d = pair.debit_leg;
  const c = pair.credit_leg;
  return (
    <div
      className="rounded-xl bg-white border-2 border-cyan-400 ring-2 ring-cyan-100 shadow-lg p-5"
      data-testid="transfer-inspect-card"
    >
      <div className="flex items-baseline justify-between mb-4">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="text-cyan-600" size={18} />
          <div className="font-heading font-semibold text-lg">Intercompany transfer</div>
        </div>
        <ConfBadge conf={pair.confidence} delta={pair.date_delta_days} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-md bg-rose-50 border border-rose-200 p-3">
          <div className="text-[10px] uppercase tracking-wider text-rose-700 font-semibold mb-1">
            Debit (source) — money left
          </div>
          <div className="text-sm font-semibold text-slate-900 truncate" title={d.bank_account_name}>
            {d.bank_account_name || "Unnamed bank"}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">{fmtDate(d.date)}</div>
          <div className="text-lg font-mono-num font-semibold text-rose-800 mt-1">
            {fmtMoney(d.amount)}
          </div>
          <div className="text-xs text-slate-600 mt-1 truncate" title={d.description}>
            {d.description}
          </div>
        </div>
        <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3">
          <div className="text-[10px] uppercase tracking-wider text-emerald-700 font-semibold mb-1">
            Credit (destination) — money arrived
          </div>
          <div className="text-sm font-semibold text-slate-900 truncate" title={c.bank_account_name}>
            {c.bank_account_name || "Unnamed bank"}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">{fmtDate(c.date)}</div>
          <div className="text-lg font-mono-num font-semibold text-emerald-800 mt-1">
            {fmtMoney(c.amount)}
          </div>
          <div className="text-xs text-slate-600 mt-1 truncate" title={c.description}>
            {c.description}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-4 justify-end">
        <button
          onClick={onReject}
          disabled={busy}
          data-testid="transfer-inspect-reject"
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-sm text-slate-700 disabled:opacity-50"
        >
          <X size={14} /> Not a transfer
        </button>
        <button
          onClick={onApprove}
          disabled={busy}
          data-testid="transfer-inspect-approve"
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-50"
        >
          <Check size={14} /> {busy ? "Booking…" : "Approve — book to Inter-Account Transfer"}
        </button>
      </div>
    </div>
  );
}

function TransferReviewDoneRedirect() {
  // Every pending transfer pair has been reviewed — auto-continue to the
  // second phase of Step 3 (No-Contact Review). Matches the LetsReview /
  // NoContactReview redirect pattern so the CPA never hits a dead-end
  // empty state between sub-steps.
  const navigate = useNavigate();
  useEffect(() => {
    navigate("/accounting/no-contact-review", { replace: true });
  }, [navigate]);
  return (
    <div className="p-6 text-sm text-slate-500" data-testid="transfer-review-continuing">
      Nice — all transfer pairs reviewed. Continuing to No-Contact Review…
    </div>
  );
}


export default function TransferReview() {
  const { currentId } = useCompany();
  const navigate = useNavigate();
  const [pairs, setPairs] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [inspectPairId, setInspectPairId] = useState(null);
  const [busy, setBusy] = useState(false);
  // Locally-rejected pair ids — user said "not a transfer" so we hide them
  // from this session without needing a server round-trip. They'll show up
  // again on next visit (a real reject/mark-not-a-transfer flow can come
  // later; for now hiding is enough to keep the queue moving).
  const [rejected, setRejected] = useState(() => new Set());

  const load = async () => {
    if (!currentId) return;
    setPairs(null);
    try {
      const r = await api.get(`/companies/${currentId}/transactions/transfer-pairs`);
      setPairs(r.data?.pairs || []);
    } catch (e) {
      toast.error("Could not scan for transfer pairs");
      setPairs([]);
    }
  };
  useEffect(() => {
    load(); /* eslint-disable-next-line */
  }, [currentId]);

  const visible = useMemo(
    () => (pairs || []).filter((p) => !rejected.has(p.pair_id)),
    [pairs, rejected]
  );
  const inspecting = useMemo(
    () => visible.find((p) => p.pair_id === inspectPairId) || null,
    [visible, inspectPairId]
  );

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (selected.size === visible.length && visible.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(visible.map((p) => p.pair_id)));
    }
  };

  const book = async (pairIds) => {
    const targets = visible.filter((p) => pairIds.includes(p.pair_id));
    if (!targets.length) return;
    setBusy(true);
    try {
      const res = await api.post(
        `/companies/${currentId}/transactions/transfer-pairs/book`,
        {
          pairs: targets.map((p) => ({
            debit_id: p.debit_leg.id,
            credit_id: p.credit_leg.id,
          })),
        }
      );
      const updated = res.data?.updated || 0;
      const skipped = (res.data?.skipped || []).length;
      toast.success(
        `Booked ${updated} leg${updated === 1 ? "" : "s"} across ${targets.length} pair${targets.length === 1 ? "" : "s"}.` +
        (skipped ? ` ${skipped} skipped.` : "")
      );
      // Optimistically remove booked pairs from the queue.
      setPairs((prev) => (prev || []).filter((p) => !pairIds.includes(p.pair_id)));
      setSelected(new Set());
      setInspectPairId(null);
    } catch (e) {
      toast.error("Failed to book — try again?");
    } finally {
      setBusy(false);
    }
  };

  if (!currentId) return null;
  if (pairs === null) {
    return (
      <div className="p-6 text-sm text-slate-500" data-testid="transfer-review-loading">
        Scanning for intercompany transfers…
      </div>
    );
  }
  if (visible.length === 0) {
    return <TransferReviewDoneRedirect />;
  }

  return (
    <div className="p-6 space-y-4" data-testid="transfer-review-page">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="font-heading text-3xl font-bold tracking-tight">Transfer Review</h1>
          <p className="text-slate-500 text-sm mt-1">
            Intercompany moves between company-owned accounts. Nothing books until you approve.
          </p>
        </div>
        <div className="w-[420px] shrink-0 rounded-lg bg-white border border-cyan-400 ring-1 ring-cyan-100 shadow-sm px-4 py-3" data-testid="transfer-review-info-box">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
              {visible.length} pending pair{visible.length === 1 ? "" : "s"}
            </span>
            <span className="text-[10px] text-slate-500 tabular-nums">
              {selected.size} selected
            </span>
          </div>
          <div className="mt-0.5 font-heading font-semibold text-base text-slate-900">
            Step 3a — Intercompany Transfers
          </div>
          <div className="mt-2 flex items-center gap-2 justify-end">
            <button
              onClick={() => book(Array.from(selected))}
              disabled={busy || selected.size === 0}
              data-testid="transfer-book-selected"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Check size={12} /> Book selected ({selected.size})
            </button>
          </div>
        </div>
      </div>

      {inspecting && (
        <InspectCard
          pair={inspecting}
          busy={busy}
          onApprove={() => book([inspecting.pair_id])}
          onReject={() => {
            setRejected((r) => new Set([...r, inspecting.pair_id]));
            setInspectPairId(null);
          }}
        />
      )}

      <div className="rounded-xl border bg-white overflow-hidden" data-testid="transfer-review-table">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
            <tr>
              <th className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  checked={selected.size === visible.length && visible.length > 0}
                  onChange={toggleAll}
                  data-testid="transfer-toggle-all"
                  className="rounded"
                />
              </th>
              <th className="px-3 py-2 text-left">Conf</th>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-left">Debit (from)</th>
              <th className="px-3 py-2 text-left">Credit (to)</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => {
              const dim = p.confidence < 0.75;
              const isSel = selected.has(p.pair_id);
              return (
                <tr
                  key={p.pair_id}
                  className={`border-t border-slate-100 ${dim ? "opacity-70" : ""} ${isSel ? "bg-cyan-50/40" : "hover:bg-slate-50"}`}
                  data-testid={`transfer-row-${p.pair_id}`}
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => toggle(p.pair_id)}
                      data-testid={`transfer-select-${p.pair_id}`}
                      className="rounded"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <ConfBadge conf={p.confidence} delta={p.date_delta_days} />
                  </td>
                  <td className="px-3 py-2 text-slate-600 whitespace-nowrap">
                    {fmtDate(p.debit_leg.date)}
                  </td>
                  <td className="px-3 py-2 text-slate-800 truncate max-w-[200px]" title={p.debit_leg.bank_account_name}>
                    {p.debit_leg.bank_account_name || "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-800 truncate max-w-[200px]" title={p.credit_leg.bank_account_name}>
                    {p.credit_leg.bank_account_name || "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono-num font-semibold whitespace-nowrap">
                    {fmtMoney(Math.abs(parseFloat(p.debit_leg.amount) || 0))}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => setInspectPairId(p.pair_id === inspectPairId ? null : p.pair_id)}
                      data-testid={`transfer-inspect-${p.pair_id}`}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-xs text-slate-700"
                    >
                      <Info size={11} />
                      {p.pair_id === inspectPairId ? "Hide" : "Inspect"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 justify-end text-xs text-slate-500">
        <Link to="/dashboard" className="hover:text-slate-700" data-testid="transfer-review-exit">
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
