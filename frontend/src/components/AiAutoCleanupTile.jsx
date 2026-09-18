import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Undo2, Loader2 } from "lucide-react";
import { api } from "@/lib/api";

/**
 * AI Auto-Cleanup tile — one card per **grouped** pattern.
 *
 * Patterns coming from the responsibilities endpoint are grouped by
 * (contact_id, primary before_label, direction) so multiple applied
 * records with the same "from → to" and same money direction collapse
 * into a single review card. Every row still ties back to its own
 * applied_id under the hood, so all row-level and bulk actions land
 * on the correct pattern.
 *
 * Card UX mirrors the Quick Check-in bundled card:
 *   • Money in/out badge
 *   • "We updated N transactions from X → Y" headline
 *   • Scrollable list of rows w/ select-all + per-row checkboxes + Edit
 *   • Bulk toolbar (Approve · Bulk update · Make these rules) when
 *     ≥1 row selected
 *   • Tile-level "Yes, that's right" / "No, that's wrong"
 */
export default function AiAutoCleanupTile({ companyId, patterns = [], onChanged, hideMakeRules = false }) {
  const groups = useMemo(() => groupPatterns(patterns), [patterns]);
  if (!groups.length) {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-4 text-xs text-slate-500"
           data-testid="ai-auto-cleanup-empty">
        No pending AI cleanup patterns.
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="ai-auto-cleanup-tile">
      {groups.map(g => (
        <GroupCard
          key={g.key}
          companyId={companyId}
          group={g}
          onChanged={onChanged}
          hideMakeRules={hideMakeRules}
        />
      ))}
    </div>
  );
}

/**
 * Merge patterns with the same (canonical contact_id, primary before-
 * label, direction) into one group. `before_labels` on each applied
 * record is a sorted set; we key on the first entry so cards with
 * matching primary source contact collapse regardless of tail entries.
 */
function groupPatterns(patterns) {
  const map = new Map();
  for (const p of patterns) {
    const primaryBefore = ((p.before_labels || [])[0] || "").toLowerCase().trim();
    const direction = p.direction || (Number(p.total_dollars || 0) >= 0 ? "in" : "out");
    const key = `${p.contact_id || ""}::${primaryBefore}::${direction}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        contact_id:      p.contact_id,
        contact_name:    p.contact_name,
        before_labels:   [...(p.before_labels || [])],
        direction,
        patterns:        [],
        total_dollars:   0,
        count:           0,
        txn_ids:         [],
      };
      map.set(key, g);
    }
    g.patterns.push(p);
    g.total_dollars += Number(p.total_dollars || 0);
    g.count         += Number(p.count || 0);
    g.txn_ids        = g.txn_ids.concat(p.txn_ids || []);
    // Merge before_labels across grouped patterns so the card can
    // display any additional tail labels ("Eimorlain Ugali, Foo") when
    // sibling patterns had slightly different before-sets.
    for (const bl of (p.before_labels || [])) {
      if (!g.before_labels.includes(bl)) g.before_labels.push(bl);
    }
  }
  return Array.from(map.values());
}

function GroupCard({ companyId, group, onChanged, hideMakeRules }) {
  const [samples, setSamples] = useState(null);        // null = loading
  const [txnToApplied, setTxnToApplied] = useState({}); // {txn_id: applied_id}
  const [hiddenIds, setHiddenIds] = useState(() => new Set());
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(null);
  const [pickerFor, setPickerFor] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [q, setQ] = useState("");
  const [confirming, setConfirming] = useState(null);
  const [autoClosed, setAutoClosed] = useState(false);

  // Hydrate every applied_id's samples in parallel, then flatten +
  // sort by date desc so the card feels like one continuous list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const results = await Promise.all(group.patterns.map(p =>
        api.get(`/companies/${companyId}/reviewv2/cleanup-applied/${p.applied_id}/samples`)
          .then(r => ({ applied_id: p.applied_id, samples: r.data?.samples || [] }))
          .catch(() => ({ applied_id: p.applied_id, samples: [] })),
      ));
      if (cancelled) return;
      const flat = [];
      const map = {};
      for (const { applied_id, samples: rows } of results) {
        for (const s of rows) {
          flat.push(s);
          map[s.id] = applied_id;
        }
      }
      flat.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      setSamples(flat);
      setTxnToApplied(map);
    })();
    return () => { cancelled = true; };
  }, [companyId, group.key]);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  const visible = useMemo(
    () => (samples || []).filter(s => !hiddenIds.has(s.id)),
    [samples, hiddenIds],
  );
  const remainingCount = Math.max(0, group.count - hiddenIds.size);
  const isMoneyIn = group.direction === "in";
  const fmt = (n) => Math.abs(Number(n || 0)).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const beforeStr = (group.before_labels || []).slice(0, 2).join(", ") || "the old label";

  // Selection helpers
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
  // Group a flat list of txn_ids by which applied_id owns them so we
  // can fan out the correct bulk call per pattern.
  const groupByApplied = (ids) => {
    const out = {};
    for (const id of ids) {
      const a = txnToApplied[id];
      if (!a) continue;
      (out[a] ||= []).push(id);
    }
    return out;
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

  // ── Write actions — every one fans out per applied_id ─────────────
  const runRowReassign = async () => {
    if (!confirming || !pickerFor?.row) return;
    const rowId = pickerFor.row.id;
    const appliedId = txnToApplied[rowId];
    if (!appliedId) return;
    setBusy("row-reassign");
    try {
      const body = confirming.id
        ? { txn_id: rowId, contact_id: confirming.id }
        : { txn_id: rowId, contact_name: confirming.name };
      const r = await api.post(
        `/companies/${companyId}/reviewv2/cleanup-applied/${appliedId}/row-reassign`,
        body);
      toast.success(`Reassigned to '${r.data?.contact_name || confirming.name}'`);
      popIds([rowId]);
      setPickerFor(null); setConfirming(null);
    } catch (e) { toast.error(e?.response?.data?.detail || "Reassign failed"); }
    finally { setBusy(null); }
  };
  const runBulkReassign = async () => {
    if (!confirming) return;
    const ids = Array.from(selected);
    const grouped = groupByApplied(ids);
    setBusy("bulk-reassign");
    try {
      const results = await Promise.all(
        Object.entries(grouped).map(([appliedId, tids]) => {
          const body = confirming.id
            ? { txn_ids: tids, contact_id: confirming.id }
            : { txn_ids: tids, contact_name: confirming.name };
          return api.post(
            `/companies/${companyId}/reviewv2/cleanup-applied/${appliedId}/bulk-reassign`,
            body);
        }));
      const applied = results.reduce((s, r) => s + Number(r.data?.reassigned || 0), 0);
      toast.success(`Reassigned ${applied} rows to '${confirming.name}'`);
      popIds(ids); setPickerFor(null); setConfirming(null);
    } catch (e) { toast.error(e?.response?.data?.detail || "Bulk reassign failed"); }
    finally { setBusy(null); }
  };
  const runBulkApprove = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const grouped = groupByApplied(ids);
    setBusy("bulk-approve");
    try {
      await Promise.all(Object.entries(grouped).map(([appliedId, tids]) =>
        api.post(
          `/companies/${companyId}/reviewv2/cleanup-applied/${appliedId}/bulk-approve`,
          { txn_ids: tids }),
      ));
      toast.success(`Approved ${ids.length} rows`);
      popIds(ids);
    } catch (e) { toast.error(e?.response?.data?.detail || "Approve failed"); }
    finally { setBusy(null); }
  };
  const runBulkRule = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const grouped = groupByApplied(ids);
    setBusy("bulk-rule");
    try {
      const results = await Promise.all(Object.entries(grouped).map(([appliedId, tids]) =>
        api.post(
          `/companies/${companyId}/reviewv2/cleanup-applied/${appliedId}/bulk-rule`,
          { txn_ids: tids }),
      ));
      const rules = results.reduce((s, r) => s + Number(r.data?.rules_learned || 0), 0);
      toast.success(`Learned ${rules} descriptor rule${rules === 1 ? "" : "s"}`);
      popIds(ids);
    } catch (e) { toast.error(e?.response?.data?.detail || "Make rules failed"); }
    finally { setBusy(null); }
  };
  // Tile-level acknowledge / undo fan out to every applied_id in the group.
  const runAcknowledge = async () => {
    setBusy("ack");
    try {
      await Promise.all(group.patterns.map(p =>
        api.post(
          `/companies/${companyId}/reviewv2/cleanup-applied/${p.applied_id}/acknowledge`,
          {}),
      ));
      toast.success("Pattern acknowledged");
      onChanged && onChanged();
    } catch (e) { toast.error(e?.response?.data?.detail || "Couldn't acknowledge"); }
    finally { setBusy(null); }
  };
  const runUndo = async () => {
    setBusy("undo");
    try {
      const results = await Promise.all(group.patterns.map(p =>
        api.post(
          `/companies/${companyId}/reviewv2/cleanup-applied/${p.applied_id}/undo`),
      ));
      const rows = results.reduce((s, r) => s + Number(r.data?.affected || 0), 0);
      toast.success(`Undone · ${rows} rows restored`);
      onChanged && onChanged();
    } catch (e) { toast.error(e?.response?.data?.detail || "Undo failed"); }
    finally { setBusy(null); }
  };

  // Auto-ack the entire group when every row has been individually
  // resolved by row/bulk actions.
  useEffect(() => {
    if (autoClosed) return;
    if (samples === null) return;
    if (hiddenIds.size === 0) return;
    if (remainingCount > 0) return;
    setAutoClosed(true);
    (async () => {
      try {
        await Promise.all(group.patterns.map(p =>
          api.post(
            `/companies/${companyId}/reviewv2/cleanup-applied/${p.applied_id}/acknowledge`,
            {}),
        ));
      } catch { /* soft-fail — records may already be resolved */ }
      onChanged && onChanged();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remainingCount, hiddenIds.size, samples]);
  if (autoClosed && remainingCount === 0) return null;

  return (
    <div
      className="rounded-2xl border border-slate-200 bg-white p-5"
      data-testid={`ai-auto-cleanup-card-${group.key}`}
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
        <span className="text-emerald-800">{group.contact_name || "AI-picked"}</span>
      </h3>
      <div className="mt-1 text-sm text-slate-500">
        {remainingCount} transaction{remainingCount === 1 ? "" : "s"} · ${fmt(group.total_dollars)} total
        {group.patterns.length > 1 && (
          <span className="ml-1 text-slate-400">
            · {group.patterns.length} descriptor pattern{group.patterns.length === 1 ? "" : "s"}
          </span>
        )}
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
              data-testid={`ai-auto-cleanup-bulk-toolbar-${group.key}`}
            >
              <span className="text-xs font-semibold text-slate-800 mr-1"
                    data-testid={`ai-auto-cleanup-bulk-count-${group.key}`}>
                {selected.size} selected
              </span>
              <button
                type="button"
                onClick={runBulkApprove}
                disabled={!!busy}
                className="inline-flex items-center gap-1 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-3 py-1.5 disabled:opacity-40"
                data-testid={`ai-auto-cleanup-bulk-approve-${group.key}`}
              >
                <Check size={12} /> Approve
              </button>
              <button
                type="button"
                onClick={openBulkEdit}
                disabled={!!busy}
                className="inline-flex items-center gap-1 rounded-full bg-sky-600 hover:bg-sky-700 text-white text-xs px-3 py-1.5 disabled:opacity-40"
                data-testid={`ai-auto-cleanup-bulk-update-${group.key}`}
              >
                Bulk update
              </button>
              {!hideMakeRules && (
                <button
                  type="button"
                  onClick={runBulkRule}
                  disabled={!!busy}
                  className="inline-flex items-center gap-1 rounded-full bg-violet-600 hover:bg-violet-700 text-white text-xs px-3 py-1.5 disabled:opacity-40"
                  data-testid={`ai-auto-cleanup-bulk-rules-${group.key}`}
                >
                  Make these rules
                </button>
              )}
              <button
                type="button"
                onClick={clearSel}
                disabled={!!busy}
                className="ml-auto text-[11px] text-slate-500 hover:text-slate-900 underline"
                data-testid={`ai-auto-cleanup-bulk-clear-${group.key}`}
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
                data-testid={`ai-auto-cleanup-select-all-${group.key}`}
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
          </div>
        </div>
      )}

      <div className="mt-4 text-sm text-slate-700">
        Is <b>{group.contact_name}</b> the right contact for these?
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={runAcknowledge}
          disabled={!!busy}
          className="rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-4 py-1.5 disabled:opacity-40 inline-flex items-center gap-1"
          data-testid={`ai-auto-cleanup-ack-${group.key}`}
        >
          {busy === "ack" ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
          Yes, that's right
        </button>
        <button
          type="button"
          onClick={runUndo}
          disabled={!!busy}
          className="rounded-full border border-rose-300 bg-white text-rose-800 text-xs px-4 py-1.5 hover:bg-rose-50 disabled:opacity-40 inline-flex items-center gap-1"
          data-testid={`ai-auto-cleanup-undo-${group.key}`}
        >
          {busy === "undo" ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />}
          No, that's wrong
        </button>
      </div>

      {/* Picker modal — shared between row and bulk reassign */}
      {pickerFor && !confirming && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
             onClick={() => setPickerFor(null)}
             data-testid={`ai-auto-cleanup-picker-${group.key}`}>
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
              data-testid={`ai-auto-cleanup-picker-search-${group.key}`}
            />
            <div className="mt-2 flex-1 overflow-y-auto rounded-lg border border-slate-100">
              {q && !searchHits.some(c => (c.name || "").toLowerCase() === q.toLowerCase()) && (
                <button
                  type="button"
                  onClick={() => setConfirming({ id: null, name: q.trim() })}
                  className="w-full text-left px-3 py-2 text-sm text-indigo-700 hover:bg-indigo-50 border-b border-slate-100"
                  data-testid={`ai-auto-cleanup-picker-add-new-${group.key}`}
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
             data-testid={`ai-auto-cleanup-picker-confirm-${group.key}`}>
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
                data-testid={`ai-auto-cleanup-picker-confirm-cancel-${group.key}`}
              >Cancel</button>
              <button
                type="button"
                onClick={pickerFor.mode === "row" ? runRowReassign : runBulkReassign}
                disabled={!!busy}
                className="rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-4 py-1.5 disabled:opacity-40"
                data-testid={`ai-auto-cleanup-picker-confirm-apply-${group.key}`}
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
