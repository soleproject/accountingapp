// No-Contact Review (Step 3) — thin router with a mode toggle:
//
//   Stepper mode (default): fetch all groups, redirect into Transactions.jsx
//     with `noContactReview=1&group_key=...` so the CPA walks groups one at
//     a time. Same UX as before.
//
//   List mode (`?view=list`): stay on this page and render EVERY group as a
//     row with per-group Contact + Category pickers. Clicking Apply bulk-
//     updates every transaction in that group in one shot via the new
//     `/no-contact-group/apply` endpoint. Powers rapid triage of
//     uncategorized rows across the whole book without stepping.
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { emitAction } from "@/lib/createBus";
import { toast } from "sonner";
import { Sparkles, LayoutList, ListOrdered, Loader2 } from "lucide-react";
import { NextStepCard } from "@/components/CleanupCopilot";

export default function NoContactReview() {
  const { currentId } = useCompany();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [groups, setGroups] = useState(null);
  const viewMode = params.get("view") === "list" ? "list" : "stepper";
  useEffect(() => {
    if (!currentId) return;
    api
      .get(`/companies/${currentId}/transactions/no-contact-groups`)
      .then((r) => setGroups(r.data?.groups || []));
  }, [currentId]);

  const currentIdx = useMemo(() => {
    if (!groups) return -1;
    const gk = params.get("group_key");
    if (!gk) return 0;
    const i = groups.findIndex((g) => g.group_key === gk);
    return i >= 0 ? i : 0;
  }, [groups, params]);

  useEffect(() => {
    if (viewMode !== "stepper") return;   // list mode stays on this page
    if (!groups || groups.length === 0 || currentIdx < 0) return;
    const g = groups[currentIdx];
    if (!g) return;
    const qs = new URLSearchParams({
      noContactReview: "1",
      group_key: g.group_key,
      label: g.label,
      idx: String(currentIdx + 1),
      total: String(groups.length),
      count: String(g.count ?? 0),
      total_amount: String(g.total_amount ?? 0),
    });
    if (params.get("tour") === "1") qs.set("tour", "1");
    if (params.get("replay") === "1") qs.set("replay", "1");
    setTimeout(() => {
      emitAction("cleanup-inquiry", {
        action: {
          kind: "no_contact_group",
          group_key: g.group_key,
          count: g.count,
          total_amount: g.total_amount,
          label: g.label,
        },
      });
    }, 400);
    navigate(`/accounting/transactions?${qs.toString()}`, { replace: true });
  }, [viewMode, groups, currentIdx, navigate, params]);

  if (!groups) {
    return (
      <div className="p-6 text-sm text-slate-500">
        Loading no-contact groups…
      </div>
    );
  }
  if (groups.length === 0) {
    return <NoContactReviewDoneRedirect />;
  }
  if (viewMode === "list") {
    return (
      <ListModeView
        initialGroups={groups}
        onExitToStepper={() => {
          const next = new URLSearchParams(params);
          next.delete("view");
          setParams(next, { replace: true });
        }}
      />
    );
  }
  return null;
}

// -------------------------- LIST MODE VIEW --------------------------

export function ListModeView({ groups: initialGroups, embedded = false, onExitToStepper }) {
  const { currentId } = useCompany();
  const [contacts, setContacts] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [groups, setGroups] = useState(initialGroups || null);
  const [drafts, setDrafts] = useState({});
  const [expanded, setExpanded] = useState(null);
  const [expandedRows, setExpandedRows] = useState({});
  // In embedded mode we fetch our own groups list because Transactions.jsx
  // doesn't know about them — the parent just toggles the URL flag.
  useEffect(() => {
    if (!currentId) return;
    Promise.all([
      api.get(`/companies/${currentId}/contacts`)
         .then(r => setContacts(r.data.contacts || r.data || [])),
      api.get(`/companies/${currentId}/accounts`)
         .then(r => setAccounts((r.data.accounts || []).filter(a => a.active !== false))),
    ]).catch(() => {});
  }, [currentId]);
  useEffect(() => {
    if (initialGroups) { setGroups(initialGroups); return; }
    if (!currentId) return;
    api.get(`/companies/${currentId}/transactions/no-contact-groups`)
       .then(r => setGroups(r.data?.groups || []))
       .catch(() => setGroups([]));
  }, [currentId, initialGroups]);
  const patch = (gk, k, v) => setDrafts(d => ({ ...d, [gk]: { ...(d[gk] || {}), [k]: v } }));

  const toggleExpand = async (g) => {
    if (expanded === g.group_key) { setExpanded(null); return; }
    setExpanded(g.group_key);
    if (expandedRows[g.group_key]?.rows) return;   // already fetched
    setExpandedRows(prev => ({ ...prev, [g.group_key]: { loading: true } }));
    try {
      const r = await api.get(
        `/companies/${currentId}/transactions/no-contact-group-transactions`,
        { params: { group_key: g.group_key } },
      );
      setExpandedRows(prev => ({
        ...prev, [g.group_key]: { loading: false, rows: r.data.rows || [] },
      }));
    } catch (e) {
      setExpandedRows(prev => ({
        ...prev, [g.group_key]: { loading: false, err: e.response?.data?.detail || e.message },
      }));
    }
  };
  const updateExpandedRow = async (groupKey, txnId, rowPatch) => {
    // Optimistic patch, revert on error by refetching the group.
    setExpandedRows(prev => {
      const b = prev[groupKey]; if (!b?.rows) return prev;
      return { ...prev, [groupKey]: {
        ...b, rows: b.rows.map(r => r.id === txnId ? { ...r, ...rowPatch } : r),
      }};
    });
    try {
      await api.patch(`/companies/${currentId}/transactions/${txnId}`, rowPatch);
    } catch (e) {
      toast.error(`Update failed: ${e.response?.data?.detail || e.message}`);
    }
  };
  const bulkUpdateExpandedRows = async (groupKey, txnIds, bulk) => {
    // Reuses the same bulk-set-contact / bulk-reclassify endpoints
    // powering the Step-1 bucket expansion. Optimistic in-memory patch.
    setExpandedRows(prev => {
      const b = prev[groupKey]; if (!b?.rows) return prev;
      const idSet = new Set(txnIds);
      const rp = { ...bulk }; delete rp.kind;
      return { ...prev, [groupKey]: {
        ...b, rows: b.rows.map(r => idSet.has(r.id) ? { ...r, ...rp } : r),
      }};
    });
    try {
      if (bulk.kind === "contact") {
        await api.post(`/companies/${currentId}/transactions/bulk-set-contact`, {
          transaction_ids: txnIds, contact_id: bulk.contact_id,
        });
      } else if (bulk.kind === "category") {
        await api.post(`/companies/${currentId}/transactions/bulk-reclassify`, {
          transaction_ids: txnIds, category_account_id: bulk.category_account_id,
        });
      }
      toast.success(`Updated ${txnIds.length} rows`);
    } catch (e) {
      toast.error(`Bulk update failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const applyGroup = async (g) => {
    const draft = drafts[g.group_key] || {};
    const contactId = draft.contact_id;
    const catId = draft.category_account_id;
    if (!contactId && !catId) {
      toast.error("Pick a contact and/or a category first.");
      return;
    }
    patch(g.group_key, "saving", true);
    try {
      const body = { group_key: g.group_key };
      if (contactId !== undefined) {
        body.contact_id = contactId === "__clear__" ? null : contactId || undefined;
      }
      if (catId) body.category_account_id = catId;
      const r = await api.post(
        `/companies/${currentId}/transactions/no-contact-group/apply`, body,
      );
      const upd = r.data?.updated || 0;
      const skipped = (r.data?.skipped_closed || []).length;
      toast.success(
        `Updated ${upd} of ${g.count} rows in "${g.label}"` +
        (skipped ? ` (${skipped} skipped: closed period)` : ""),
      );
      // Refresh the groups list — the just-updated group will drop out
      // when it was categorized (rows flip to human_reviewed=true).
      const rr = await api.get(`/companies/${currentId}/transactions/no-contact-groups`);
      setGroups(rr.data?.groups || []);
      // Clear this group's draft to avoid confusion.
      setDrafts(d => { const n = { ...d }; delete n[g.group_key]; return n; });
    } catch (e) {
      toast.error(`Apply failed: ${e.response?.data?.detail || e.message}`);
      patch(g.group_key, "saving", false);
    }
  };

  if (!groups) {
    return <div className={embedded ? "p-4 text-sm text-slate-500" : "p-6 text-sm text-slate-500"}>Loading no-contact groups…</div>;
  }
  if (groups.length === 0) {
    return <div className={embedded ? "p-4 text-sm text-slate-500" : "p-6 text-sm text-slate-500"}>No no-contact groups remain — every bank-feed row now has a contact.</div>;
  }
  const totalTxns = groups.reduce((s, g) => s + (g.count || 0), 0);
  const totalAmount = groups.reduce((s, g) => s + (g.total_amount || 0), 0);

  return (
    <div className={embedded ? "" : "p-6 max-w-6xl mx-auto"}>
      {!embedded && (
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900 flex items-center gap-2">
              <Sparkles className="text-indigo-600" size={22} /> No-Contact Review · All Groups
            </h1>
            <div className="text-sm text-slate-500 mt-1">
              {groups.length} groups · {totalTxns} transactions · $
              {totalAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onExitToStepper}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border bg-white text-slate-700 text-xs hover:bg-slate-50"
              data-testid="ncr-mode-stepper"
            >
              <ListOrdered size={13} /> Switch to stepper
            </button>
            <Link
              to="/dashboard"
              className="px-3 py-1.5 rounded-md border bg-white text-slate-700 text-xs hover:bg-slate-50"
            >
              Back to dashboard
            </Link>
          </div>
        </div>
      )}

      <div className="rounded-lg border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="text-left px-4 py-2 font-normal">Group</th>
              <th className="text-right px-2 py-2 font-normal w-[70px]">Txns</th>
              <th className="text-right px-2 py-2 font-normal w-[120px]">Total</th>
              <th className="px-2 py-2 font-normal w-[220px]">Assign contact</th>
              <th className="px-2 py-2 font-normal w-[260px]">Assign category</th>
              <th className="px-2 py-2 font-normal w-[100px]"></th>
            </tr>
          </thead>
          <tbody>
            {groups.map(g => {
              const d = drafts[g.group_key] || {};
              const disabled = !d.contact_id && !d.category_account_id;
              const isExpanded = expanded === g.group_key;
              return (
                <React.Fragment key={g.group_key}>
                <tr
                  data-testid={`ncr-group-row-${g.group_key}`}
                  className={`border-t border-slate-100 hover:bg-slate-50/60 ${isExpanded ? "bg-indigo-50/30" : ""}`}
                >
                  <td className="px-4 py-2 text-slate-800 max-w-[260px]" title={g.label}>
                    <div className="truncate">{g.label}</div>
                    <div className="text-[10px] text-slate-400 font-mono">{g.group_key}</div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    <button
                      type="button"
                      onClick={() => toggleExpand(g)}
                      className="text-slate-700 underline decoration-dotted decoration-slate-400 hover:decoration-slate-800 hover:text-indigo-700"
                      title="Show these transactions below to edit contact / category per-row"
                      data-testid={`ncr-group-expand-${g.group_key}`}
                    >
                      {g.count}
                    </button>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-slate-700">
                    ${g.total_amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td className="px-2 py-2">
                    <select
                      value={d.contact_id || ""}
                      onChange={(e) => patch(g.group_key, "contact_id", e.target.value || undefined)}
                      className="w-full text-xs border border-slate-300 rounded px-1.5 py-1 bg-white"
                      data-testid={`ncr-group-contact-${g.group_key}`}
                    >
                      <option value="">— pick contact —</option>
                      <option value="__clear__">— clear contact —</option>
                      {contacts.map(ct => (
                        <option key={ct.id} value={ct.id}>{ct.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <select
                      value={d.category_account_id || ""}
                      onChange={(e) => patch(g.group_key, "category_account_id", e.target.value || undefined)}
                      className="w-full text-xs border border-slate-300 rounded px-1.5 py-1 bg-white"
                      data-testid={`ncr-group-category-${g.group_key}`}
                    >
                      <option value="">— pick category —</option>
                      {accounts.map(a => (
                        <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      type="button"
                      disabled={disabled || d.saving}
                      onClick={() => applyGroup(g)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-indigo-700 text-white text-xs hover:bg-indigo-800 disabled:opacity-40 disabled:cursor-not-allowed"
                      data-testid={`ncr-group-apply-${g.group_key}`}
                    >
                      {d.saving && <Loader2 size={11} className="animate-spin" />}
                      Apply
                    </button>
                  </td>
                </tr>
                {isExpanded && (
                  <tr data-testid={`ncr-group-expansion-tr-${g.group_key}`}>
                    <td colSpan={6} className="p-0">
                      <NCRGroupExpansion
                        groupKey={g.group_key}
                        data={expandedRows[g.group_key]}
                        accounts={accounts}
                        contacts={contacts}
                        onUpdate={(txnId, p) => updateExpandedRow(g.group_key, txnId, p)}
                        onBulkUpdate={bulkUpdateExpandedRows}
                      />
                    </td>
                  </tr>
                )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NoContactReviewDoneRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate("/accounting/transactions?noContactReview=1&done=1", { replace: true });
  }, [navigate]);
  return null;
}

// Prev/Next helpers exported for the Transactions page toolbar so we can
// stitch a stepper onto the "No-Contact Review" header — same shape as
// `useLetsReviewNav` in LetsReview.jsx.
export function useNoContactReviewNav() {
  const [groups, setGroups] = useState([]);
  const [params] = useSearchParams();
  const { currentId } = useCompany();
  const navigate = useNavigate();
  const active = params.get("noContactReview") === "1";
  const groupKey = params.get("group_key");

  useEffect(() => {
    if (!active || !currentId) return;
    api
      .get(`/companies/${currentId}/transactions/no-contact-groups`)
      .then((r) => setGroups(r.data?.groups || []));
  }, [active, currentId]);

  const idx = groups.findIndex((g) => g.group_key === groupKey);
  const jumpTo = (i) => {
    const g = groups[i];
    if (!g) return;
    navigate(`/accounting/no-contact-review?group_key=${encodeURIComponent(g.group_key)}`);
  };
  return {
    active,
    idx,
    total: groups.length,
    prev: idx > 0 ? () => jumpTo(idx - 1) : null,
    next: idx >= 0 && idx < groups.length - 1 ? () => jumpTo(idx + 1) : null,
    exit: () => navigate("/dashboard"),
  };
}

// Toggle-to-list button — mounted in Transactions.jsx alongside the
// stepper Prev/Next controls when `noContactReview=1`. Toggles the
// `view=list` URL param IN PLACE (no navigation) so the CPA stays on
// the same page. Transactions.jsx renders <ListModeView embedded /> in
// place of the transactions table when the flag is set.
export function NoContactReviewListToggle() {
  const [params, setParams] = useSearchParams();
  const isList = params.get("view") === "list";
  const toggle = () => {
    const next = new URLSearchParams(params);
    if (isList) next.delete("view");
    else next.set("view", "list");
    setParams(next, { replace: true });
  };
  return (
    <button
      type="button"
      onClick={toggle}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-white text-slate-700 text-xs hover:bg-slate-50"
      data-testid={isList ? "ncr-back-to-stepper" : "ncr-open-list"}
      title={isList
        ? "Back to walking one group at a time"
        : "Show every no-contact group in a single list you can edit at once"}
    >
      {isList
        ? (<><ListOrdered size={13} /> Stepper view</>)
        : (<><LayoutList  size={13} /> List view</>)}
    </button>
  );
}


// Per-group expansion: nested table with row checkboxes, per-row Contact
// + Category pickers, and a bulk-action bar. Same interaction model as
// the Step-1 bucket expansion — feels consistent for the CPA.
function NCRGroupExpansion({ groupKey, data, accounts, contacts, onUpdate, onBulkUpdate }) {
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkContactId, setBulkContactId] = useState("");
  const [bulkCategoryId, setBulkCategoryId] = useState("");
  const [applying, setApplying] = useState(false);
  const rowIdsKey = (data?.rows || []).map(r => r.id).join(",");
  useEffect(() => { setSelectedIds(new Set()); setBulkContactId(""); setBulkCategoryId(""); }, [rowIdsKey]);
  if (!data) return null;
  if (data.loading) {
    return <div className="pl-6 pr-3 py-2 text-xs text-slate-500 bg-slate-50/50 border-t border-slate-200">Loading transactions…</div>;
  }
  if (data.err) {
    return <div className="pl-6 pr-3 py-2 text-xs text-red-600 bg-red-50 border-t border-red-200">{data.err}</div>;
  }
  const rows = data.rows || [];
  if (!rows.length) {
    return <div className="pl-6 pr-3 py-2 text-xs text-slate-500 bg-slate-50/50 border-t border-slate-200">No matching transactions remain in this group.</div>;
  }
  const allSelected = selectedIds.size > 0 && selectedIds.size === rows.length;
  const toggleAll = () => setSelectedIds(prev => prev.size === rows.length ? new Set() : new Set(rows.map(r => r.id)));
  const toggleOne = (id) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const applyBulk = async (field) => {
    if (!selectedIds.size) return;
    const ids = Array.from(selectedIds);
    setApplying(true);
    try {
      if (field === "contact") {
        const contact = contacts.find(c => c.id === bulkContactId);
        await onBulkUpdate(groupKey, ids, {
          kind: "contact",
          contact_id: bulkContactId === "__clear__" ? null : (bulkContactId || null),
          contact_name: bulkContactId === "__clear__" ? null : (contact?.name || null),
        });
      } else {
        const acct = accounts.find(a => a.id === bulkCategoryId);
        if (!acct) return;
        await onBulkUpdate(groupKey, ids, {
          kind: "category",
          category_account_id: bulkCategoryId,
          category_account_code: acct.code || null,
          category_account_name: acct.name || null,
        });
      }
    } finally { setApplying(false); }
  };
  return (
    <div
      data-testid={`ncr-group-expansion-${groupKey}`}
      className="bg-slate-50/60 border-t border-slate-200"
    >
      {selectedIds.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 px-4 py-2 bg-indigo-50 border-b border-indigo-200 text-xs"
          data-testid={`ncr-bulk-bar-${groupKey}`}
        >
          <span className="font-semibold text-indigo-900">{selectedIds.size} selected</span>
          <span className="text-indigo-800">·</span>
          <select
            value={bulkContactId}
            onChange={(e) => setBulkContactId(e.target.value)}
            className="text-xs border border-indigo-300 rounded px-1.5 py-1 bg-white min-w-[160px]"
            data-testid={`ncr-bulk-contact-${groupKey}`}
          >
            <option value="">Change contact to…</option>
            <option value="__clear__">— clear contact —</option>
            {contacts.map(ct => <option key={ct.id} value={ct.id}>{ct.name}</option>)}
          </select>
          <button
            type="button"
            disabled={!bulkContactId || applying}
            onClick={() => applyBulk("contact")}
            className="px-2 py-1 rounded bg-indigo-700 hover:bg-indigo-800 text-white text-xs disabled:opacity-50"
            data-testid={`ncr-bulk-contact-apply-${groupKey}`}
          >
            Apply
          </button>
          <span className="text-indigo-800">·</span>
          <select
            value={bulkCategoryId}
            onChange={(e) => setBulkCategoryId(e.target.value)}
            className="text-xs border border-indigo-300 rounded px-1.5 py-1 bg-white min-w-[200px]"
            data-testid={`ncr-bulk-category-${groupKey}`}
          >
            <option value="">Change category to…</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </select>
          <button
            type="button"
            disabled={!bulkCategoryId || applying}
            onClick={() => applyBulk("category")}
            className="px-2 py-1 rounded bg-indigo-700 hover:bg-indigo-800 text-white text-xs disabled:opacity-50"
            data-testid={`ncr-bulk-category-apply-${groupKey}`}
          >
            Apply
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="text-indigo-700 hover:text-indigo-900 text-xs underline"
          >
            Clear selection
          </button>
        </div>
      )}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200">
            <th className="pl-4 pr-1 py-1.5 font-normal w-6">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                data-testid={`ncr-select-all-${groupKey}`}
                title={allSelected ? "Clear selection" : "Select all rows in this group"}
              />
            </th>
            <th className="pr-2 py-1.5 font-normal w-[86px]">Date</th>
            <th className="px-2 py-1.5 font-normal">Description</th>
            <th className="px-2 py-1.5 font-normal w-[190px]">Contact</th>
            <th className="px-2 py-1.5 font-normal w-[240px]">Category</th>
            <th className="px-2 py-1.5 font-normal w-[100px] text-right pr-4">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr
              key={r.id}
              data-testid={`ncr-txn-${r.id}`}
              className={`border-b border-slate-100 last:border-b-0 hover:bg-white ${selectedIds.has(r.id) ? "bg-indigo-50/40" : ""}`}
            >
              <td className="pl-4 pr-1 py-1.5">
                <input
                  type="checkbox"
                  checked={selectedIds.has(r.id)}
                  onChange={() => toggleOne(r.id)}
                  data-testid={`ncr-select-${r.id}`}
                />
              </td>
              <td className="pr-2 py-1.5 tabular-nums text-slate-600">{r.date || "—"}</td>
              <td className="px-2 py-1.5 text-slate-800 truncate max-w-[280px]" title={r.description}>
                {r.description || r.merchant || "—"}
              </td>
              <td className="px-2 py-1.5">
                <select
                  value={r.contact_id || ""}
                  onChange={(e) => {
                    const cid = e.target.value || null;
                    const contact = contacts.find(x => x.id === cid);
                    onUpdate(r.id, {
                      contact_id: cid,
                      contact_name: contact?.name || null,
                    });
                  }}
                  className="w-full text-xs border border-slate-300 rounded px-1.5 py-1 bg-white"
                  data-testid={`ncr-row-contact-${r.id}`}
                >
                  <option value="">— none —</option>
                  {contacts.map(ct => <option key={ct.id} value={ct.id}>{ct.name}</option>)}
                </select>
              </td>
              <td className="px-2 py-1.5">
                <select
                  value={r.category_account_id || ""}
                  onChange={(e) => {
                    const aid = e.target.value || null;
                    const acct = accounts.find(x => x.id === aid);
                    onUpdate(r.id, {
                      category_account_id: aid,
                      category_account_code: acct?.code || null,
                      category_account_name: acct?.name || null,
                    });
                  }}
                  className="w-full text-xs border border-slate-300 rounded px-1.5 py-1 bg-white"
                  data-testid={`ncr-row-category-${r.id}`}
                >
                  <option value="">— uncategorized —</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                </select>
              </td>
              <td className={`px-2 py-1.5 text-right pr-4 tabular-nums ${(r.amount || 0) < 0 ? "text-slate-800" : "text-emerald-700"}`}>
                {r.amount != null ? `$${Math.abs(r.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
