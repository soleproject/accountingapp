import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Undo2, Loader2 } from "lucide-react";
import { api } from "@/lib/api";

/**
 * AI Auto-Cleanup tile — one card per applied pattern, mirroring the
 * client-facing Quick Check-in look:
 *   • Money in/out badge
 *   • "We updated N transactions from X → Y" headline
 *   • Scrollable table of the pattern's actual transactions with a
 *     select-all header, per-row checkboxes, per-row Edit
 *   • Bulk toolbar (Approve · Bulk update · Make these rules) when
 *     ≥1 row is selected — non-black soft slate
 *   • "Looks right" / "Undo" tile-level actions at the bottom
 *
 * Powered by `/companies/{cid}/reviewv2/cleanup-applied/…` endpoints —
 * samples GET, per-row row-reassign, bulk-approve/reassign/rule.
 */
export default function AiAutoCleanupTile({ companyId, patterns = [], onChanged, hideMakeRules = false }) {
  if (!patterns.length) {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-4 text-xs text-slate-500"
           data-testid="ai-auto-cleanup-empty">
        No pending AI cleanup patterns.
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="ai-auto-cleanup-tile">
      {patterns.map(p => (
        <PatternCard
          key={p.applied_id}
          companyId={companyId}
          pattern={p}
          onChanged={onChanged}
          hideMakeRules={hideMakeRules}
        />
      ))}
    </div>
  );
}

function PatternCard({ companyId, pattern, onChanged, hideMakeRules }) {
  const [samples, setSamples] = useState(null);       // null = loading
  const [totalDollars, setTotalDollars] = useState(0);
  const [txnIds, setTxnIds] = useState(pattern.txn_ids || []);
  const [hiddenIds, setHiddenIds] = useState(() => new Set());
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(null);              // "approve" | "undo" | "bulk-approve" | ...
  // Modal state — per-row or bulk reassign share the same picker shape.
  const [pickerFor, setPickerFor] = useState(null);    // {mode:"row"|"bulk", row?}
  const [contacts, setContacts] = useState([]);
  const [q, setQ] = useState("");
  const [confirming, setConfirming] = useState(null);  // {id?, name}
  const [autoClosed, setAutoClosed] = useState(false);

  // Lazy-hydrate the pattern's transactions the first time the card
  // renders. Cheap query (max 200 rows) — we scope by applied_id.
  useEffect(() => {
    let cancelled = false;
    api.get(`/companies/${companyId}/reviewv2/cleanup-applied/${pattern.applied_id}/samples`)
      .then(r => {
        if (cancelled) return;
        setSamples(r.data?.samples || []);
        setTotalDollars(Number(r.data?.total_dollars || 0));
        setTxnIds(r.data?.txn_ids || pattern.txn_ids || []);
      })
      .catch(() => !cancelled && setSamples([]));
    return () => { cancelled = true; };
  }, [companyId, pattern.applied_id]);

  const visible = useMemo(
    () => (samples || []).filter(s => !hiddenIds.has(s.id)),
    [samples, hiddenIds],
  );
  const remainingCount = Math.max(0, (pattern.count || txnIds.length) - hiddenIds.size);
  const isMoneyIn = Number(totalDollars || 0) >= 0;
  const fmt = (n) => Math.abs(Number(n || 0)).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const beforeStr = (pattern.before_labels || []).slice(0, 2).join(", ") || "the old label";

  // Selection
  const toggleOne = (id) => setSelected(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const toggleAll = () => setSelected(prev => {
    const allSel = visible.length > 0 && visible.every(s => prev.has(s.id));
    if (allSel) return new Set();
    const n = new Set(prev);
    for (const s of visible) n.add(s.id);
    return n;
  });
  const clearSel = () => setSelected(new Set());
  const popIds = (ids) => {
    setHiddenIds(prev => { const n = new Set(prev); for (const i of ids) n.add(i); return n; });
    setSelected(new Set());
  };

  // Contact directory — lazy load on first picker open.
  const ensureContacts = async () => {
    if (contacts.length) return;
    try {
      const r = await api.get(`/companies/${companyId}/contacts?limit=1000`);
      setContacts(r.data?.contacts || r.data || []);
    } catch { toast.error("Couldn't load contacts"); }
  };
  const searchHits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return contacts.slice(0, 100);
    return contacts.filter(c => (c.name || "").toLowerCase().includes(s)).slice(0, 100);
  }, [contacts, q]);
  const openRowEdit = async (row) => {
    setPickerFor({ mode: "row", row });
    setQ(""); setConfirming(null);
    await ensureContacts();
  };
  const openBulkEdit = async () => {
    if (selected.size === 0) return;
    setPickerFor({ mode: "bulk" });
    setQ(""); setConfirming(null);
    await ensureContacts();
  };

  // ── Write actions ───────────────────────────────────────────────
  const runRowReassign = async () => {
    if (!confirming || !pickerFor?.row) return;
    setBusy("row-reassign");
    try {
      const body = confirming.id
        ? { txn_id: pickerFor.row.id, contact_id: confirming.id }
        : { txn_id: pickerFor.row.id, contact_name: confirming.name };
      const r = await api.post(
        `/companies/${companyId}/reviewv2/cleanup-applied/${pattern.applied_id}/row-reassign`,
        body);
      toast.success(`Reassigned to '${r.data?.contact_name || confirming.name}'`);
      popIds([pickerFor.row.id]);
      setPickerFor(null); setConfirming(null);
    } catch (e) { toast.error(e?.response?.data?.detail || "Reassign failed"); }
    finally { setBusy(null); }
  };
  const runBulkReassign = async () => {
    if (!confirming) return;
    const ids = Array.from(selected);
    setBusy("bulk-reassign");
    try {
      const body = confirming.id
        ? { txn_ids: ids, contact_id: confirming.id }
        : { txn_ids: ids, contact_name: confirming.name };
      const r = await api.post(
        `/companies/${companyId}/reviewv2/cleanup-applied/${pattern.applied_id}/bulk-reassign`,
        body);
      toast.success(`Reassigned ${r.data?.reassigned ?? ids.length} rows to '${r.data?.contact_name}'`);
      popIds(ids); setPickerFor(null); setConfirming(null);
    } catch (e) { toast.error(e?.response?.data?.detail || "Bulk reassign failed"); }
    finally { setBusy(null); }
  };
  const runBulkApprove = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setBusy("bulk-approve");
    try {
      await api.post(
        `/companies/${companyId}/reviewv2/cleanup-applied/${pattern.applied_id}/bulk-approve`,
        { txn_ids: ids });
      toast.success(`Approved ${ids.length} rows`);
      popIds(ids);
    } catch (e) { toast.error(e?.response?.data?.detail || "Approve failed"); }
    finally { setBusy(null); }
  };
  const runBulkRule = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setBusy("bulk-rule");
    try {
      const r = await api.post(
        `/companies/${companyId}/reviewv2/cleanup-applied/${pattern.applied_id}/bulk-rule`,
        { txn_ids: ids });
      toast.success(`Learned ${r.data?.rules_learned ?? 0} descriptor rule${(r.data?.rules_learned ?? 0) === 1 ? "" : "s"}`);
      popIds(ids);
    } catch (e) { toast.error(e?.response?.data?.detail || "Make rules failed"); }
    finally { setBusy(null); }
  };
  // Tile-level "Looks right" — acknowledge the WHOLE pattern.
  const runAcknowledge = async () => {
    setBusy("ack");
    try {
      await api.post(
        `/companies/${companyId}/reviewv2/cleanup-applied/${pattern.applied_id}/acknowledge`,
        {});
      toast.success("Pattern acknowledged");
      onChanged && onChanged();
    } catch (e) { toast.error(e?.response?.data?.detail || "Couldn't acknowledge"); }
    finally { setBusy(null); }
  };
  const runUndo = async () => {
    setBusy("undo");
    try {
      const r = await api.post(
        `/companies/${companyId}/reviewv2/cleanup-applied/${pattern.applied_id}/undo`);
      toast.success(`Undone · ${r.data?.affected ?? pattern.count} rows restored`);
      onChanged && onChanged();
    } catch (e) { toast.error(e?.response?.data?.detail || "Undo failed"); }
    finally { setBusy(null); }
  };

  // Auto-close: when every row has been individually resolved, the
  // tile is effectively acknowledged. Fire once, then let onChanged
  // sweep it out of the list.
  useEffect(() => {
    if (autoClosed) return;
    if (samples === null) return;
    if (hiddenIds.size === 0) return;
    if (remainingCount > 0) return;
    setAutoClosed(true);
    (async () => {
      try {
        await api.post(
          `/companies/${companyId}/reviewv2/cleanup-applied/${pattern.applied_id}/acknowledge`,
          {});
      } catch { /* soft-fail — record may already be resolved */ }
      onChanged && onChanged();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remainingCount, hiddenIds.size, samples]);

  // Once auto-close fires we don't want to keep rendering the shell.
  if (autoClosed && remainingCount === 0) return null;

  return (
    <div
      className="rounded-2xl border border-slate-200 bg-white p-5"
      data-testid={`ai-auto-cleanup-card-${pattern.applied_id}`}
    >
      <span className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider rounded-full px-2 py-0.5 ${
        isMoneyIn ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                  : "bg-rose-50 text-rose-800 border border-rose-200"
      }`}>
        {isMoneyIn ? "↗ Money in" : "↘ Money out"}
      </span>
      <h3 className="mt-2 text-lg font-semibold text-slate-900">
        We updated {remainingCount} transaction{remainingCount === 1 ? "" : "s"} from{" "}
        <span className="text-slate-500">{beforeStr}</span> to{" "}
        <span className="text-emerald-800">{pattern.contact_name || "AI-picked"}</span>
      </h3>
      <div className="mt-1 text-sm text-slate-500">
        {remainingCount} transaction{remainingCount === 1 ? "" : "s"} · ${fmt(totalDollars)} total
      </div>

      {samples === null && (
        <div className="mt-3 text-xs text-slate-500 inline-flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Loading transactions…
        </div>
      )}

      {samples && visible.length > 0 && (
        <div className="mt-3">
          {selected.size > 0 && (
            <div
              className="mb-2 rounded-xl bg-slate-100 border border-slate-200 px-3 py-2 flex flex-wrap items-center gap-2"
              data-testid={`ai-auto-cleanup-bulk-toolbar-${pattern.applied_id}`}
            >
              <span className="text-xs font-semibold text-slate-800 mr-1"
                    data-testid={`ai-auto-cleanup-bulk-count-${pattern.applied_id}`}>
                {selected.size} selected
              </span>
              <button
                type="button"
                onClick={runBulkApprove}
                disabled={!!busy}
                className="inline-flex items-center gap-1 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-3 py-1.5 disabled:opacity-40"
                data-testid={`ai-auto-cleanup-bulk-approve-${pattern.applied_id}`}
              >
                <Check size={12} /> Approve
              </button>
              <button
                type="button"
                onClick={openBulkEdit}
                disabled={!!busy}
                className="inline-flex items-center gap-1 rounded-full bg-sky-600 hover:bg-sky-700 text-white text-xs px-3 py-1.5 disabled:opacity-40"
                data-testid={`ai-auto-cleanup-bulk-update-${pattern.applied_id}`}
              >
                Bulk update
              </button>
              {!hideMakeRules && (
                <button
                  type="button"
                  onClick={runBulkRule}
                  disabled={!!busy}
                  className="inline-flex items-center gap-1 rounded-full bg-violet-600 hover:bg-violet-700 text-white text-xs px-3 py-1.5 disabled:opacity-40"
                  data-testid={`ai-auto-cleanup-bulk-rules-${pattern.applied_id}`}
                >
                  Make these rules
                </button>
              )}
              <button
                type="button"
                onClick={clearSel}
                disabled={!!busy}
                className="ml-auto text-[11px] text-slate-500 hover:text-slate-900 underline"
                data-testid={`ai-auto-cleanup-bulk-clear-${pattern.applied_id}`}
              >
                Clear
              </button>
            </div>
          )}
          <div className="rounded-lg border border-slate-100 max-h-72 overflow-y-auto">
            <div className="sticky top-0 z-[1] bg-slate-50 border-b border-slate-100 px-3 py-1.5 flex items-center gap-3 text-[11px] uppercase tracking-wider text-slate-500">
              <input
                type="checkbox"
                onChange={toggleAll}
                checked={visible.length > 0 && visible.every(s => selected.has(s.id))}
                className="h-3.5 w-3.5 accent-slate-900"
                data-testid={`ai-auto-cleanup-select-all-${pattern.applied_id}`}
                aria-label="Select all visible transactions"
              />
              <span className="flex-1">Transaction</span>
            </div>
            <ul className="divide-y divide-slate-100">
              {visible.map((s) => {
                const checked = selected.has(s.id);
                return (
                  <li key={s.id}
                      className={`px-3 py-2 flex items-center gap-3 text-xs font-mono ${
                        checked ? "bg-sky-50/60" : ""
                      }`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleOne(s.id)}
                      className="h-3.5 w-3.5 accent-slate-900 shrink-0"
                      data-testid={`ai-auto-cleanup-row-checkbox-${s.id}`}
                      aria-label={`Select ${s.description}`}
                    />
                    <span className="text-slate-500 shrink-0 w-24">{s.date || ""}</span>
                    <span className={`shrink-0 w-24 text-right ${
                      Number(s.amount || 0) >= 0 ? "text-emerald-800" : "text-rose-800"
                    }`}>${fmt(s.amount)}</span>
                    <span className="text-slate-700 truncate flex-1">{s.description}</span>
                    <button
                      type="button"
                      onClick={() => openRowEdit(s)}
                      className="shrink-0 text-[11px] text-indigo-700 hover:text-indigo-900 underline font-sans"
                      data-testid={`ai-auto-cleanup-row-edit-${s.id}`}
                    >
                      Edit
                    </button>
                  </li>
                );
              })}
            </ul>
            {visible.length < (txnIds?.length || 0) - hiddenIds.size && (
              <div className="text-center text-[11px] text-slate-500 py-1.5 bg-slate-50">
                Showing {visible.length} of {txnIds?.length || pattern.count} · scroll to see more
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mt-4 text-sm text-slate-700">
        Is <b>{pattern.contact_name}</b> the right contact for these?
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={runAcknowledge}
          disabled={!!busy}
          className="rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-4 py-1.5 disabled:opacity-40 inline-flex items-center gap-1"
          data-testid={`ai-auto-cleanup-ack-${pattern.applied_id}`}
        >
          {busy === "ack" ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
          Yes, that's right
        </button>
        <button
          type="button"
          onClick={runUndo}
          disabled={!!busy}
          className="rounded-full border border-rose-300 bg-white text-rose-800 text-xs px-4 py-1.5 hover:bg-rose-50 disabled:opacity-40 inline-flex items-center gap-1"
          data-testid={`ai-auto-cleanup-undo-${pattern.applied_id}`}
        >
          {busy === "undo" ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />}
          No, that's wrong
        </button>
      </div>

      {/* Picker modal — shared between row and bulk reassign */}
      {pickerFor && !confirming && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
             onClick={() => setPickerFor(null)}
             data-testid={`ai-auto-cleanup-picker-${pattern.applied_id}`}>
          <div className="w-full max-w-md rounded-xl bg-white shadow-2xl p-4 max-h-[80vh] flex flex-col"
               onClick={e => e.stopPropagation()}>
            <div className="text-sm font-semibold text-slate-900">
              {pickerFor.mode === "row"
                ? "Reassign this one transaction"
                : `Reassign ${selected.size} transaction${selected.size === 1 ? "" : "s"}`}
            </div>
            {pickerFor.mode === "row" && pickerFor.row && (
              <div className="mt-1 text-[11px] text-slate-500 font-mono truncate">
                {pickerFor.row.date} · ${fmt(pickerFor.row.amount)} · {pickerFor.row.description}
              </div>
            )}
            <input
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search contacts or type a new name…"
              className="mt-3 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
              data-testid={`ai-auto-cleanup-picker-search-${pattern.applied_id}`}
            />
            <div className="mt-2 flex-1 overflow-y-auto rounded-lg border border-slate-100">
              {q && !searchHits.some(c => (c.name || "").toLowerCase() === q.toLowerCase()) && (
                <button
                  type="button"
                  onClick={() => setConfirming({ id: null, name: q.trim() })}
                  className="w-full text-left px-3 py-2 text-sm text-indigo-700 hover:bg-indigo-50 border-b border-slate-100"
                  data-testid={`ai-auto-cleanup-picker-add-new-${pattern.applied_id}`}
                >
                  + Add new contact "<b>{q.trim()}</b>"
                </button>
              )}
              {searchHits.map(c => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setConfirming({ id: c.id, name: c.name })}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 border-b border-slate-100 last:border-0"
                  data-testid={`ai-auto-cleanup-picker-hit-${c.id}`}
                >
                  {c.name}
                </button>
              ))}
              {!searchHits.length && !q && (
                <div className="p-3 text-xs text-slate-500">Loading contacts…</div>
              )}
            </div>
            <div className="mt-3 text-right">
              <button
                type="button"
                onClick={() => setPickerFor(null)}
                className="text-xs text-slate-500 hover:text-slate-700"
              >Cancel</button>
            </div>
          </div>
        </div>
      )}
      {pickerFor && confirming && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
             data-testid={`ai-auto-cleanup-picker-confirm-${pattern.applied_id}`}>
          <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl p-5">
            <div className="text-sm font-semibold text-slate-900">
              Apply <span className="text-emerald-800">{confirming.name}</span> to{" "}
              {pickerFor.mode === "row" ? "this 1 transaction" : `${selected.size} transaction${selected.size === 1 ? "" : "s"}`}?
            </div>
            <div className="mt-3 text-[11px] text-slate-500">
              {pickerFor.mode === "row"
                ? "This row will be pulled out of the bundle."
                : `These rows will be pulled out of the bundle and future imports matching them will auto-route to ${confirming.name}.`}
            </div>
            <div className="mt-4 flex items-center gap-2 justify-end">
              <button
                type="button"
                onClick={() => setConfirming(null)}
                disabled={!!busy}
                className="text-xs text-slate-500 hover:text-slate-700 disabled:opacity-40"
                data-testid={`ai-auto-cleanup-picker-confirm-cancel-${pattern.applied_id}`}
              >Cancel</button>
              <button
                type="button"
                onClick={pickerFor.mode === "row" ? runRowReassign : runBulkReassign}
                disabled={!!busy}
                className="rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-4 py-1.5 disabled:opacity-40"
                data-testid={`ai-auto-cleanup-picker-confirm-apply-${pattern.applied_id}`}
              >
                {busy ? "Applying…" : `Apply to ${pickerFor.mode === "row" ? "1 row" : `${selected.size} row${selected.size === 1 ? "" : "s"}`}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
