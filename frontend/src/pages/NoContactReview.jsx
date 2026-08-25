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
        groups={groups}
        setGroups={setGroups}
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

function ListModeView({ groups, setGroups, onExitToStepper }) {
  const { currentId } = useCompany();
  const [contacts, setContacts] = useState([]);
  const [accounts, setAccounts] = useState([]);
  // Per-group draft state — `{ contact_id, category_account_id, saving }`.
  const [drafts, setDrafts] = useState({});
  useEffect(() => {
    if (!currentId) return;
    Promise.all([
      api.get(`/companies/${currentId}/contacts`)
         .then(r => setContacts(r.data.contacts || r.data || [])),
      api.get(`/companies/${currentId}/accounts`)
         .then(r => setAccounts((r.data.accounts || []).filter(a => a.active !== false))),
    ]).catch(() => { /* ignore — pickers just render empty */ });
  }, [currentId]);
  const patch = (gk, k, v) => setDrafts(d => ({ ...d, [gk]: { ...(d[gk] || {}), [k]: v } }));

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

  const totalTxns = groups.reduce((s, g) => s + (g.count || 0), 0);
  const totalAmount = groups.reduce((s, g) => s + (g.total_amount || 0), 0);

  return (
    <div className="p-6 max-w-6xl mx-auto">
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
              return (
                <tr
                  key={g.group_key}
                  data-testid={`ncr-group-row-${g.group_key}`}
                  className="border-t border-slate-100 hover:bg-slate-50/60"
                >
                  <td className="px-4 py-2 text-slate-800 max-w-[260px]" title={g.label}>
                    <div className="truncate">{g.label}</div>
                    <div className="text-[10px] text-slate-400 font-mono">{g.group_key}</div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-slate-700">{g.count}</td>
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
// stepper Prev/Next controls when `noContactReview=1`. Sends the CPA
// to `/accounting/no-contact-review?view=list` which renders the
// full-groups table above.
export function NoContactReviewListToggle() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate("/accounting/no-contact-review?view=list")}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-white text-slate-700 text-xs hover:bg-slate-50"
      data-testid="ncr-open-list"
      title="Show every no-contact group in a single list you can edit at once"
    >
      <LayoutList size={13} /> List view
    </button>
  );
}
