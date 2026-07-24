// Let's Review — dedicated stepper page that walks a CPA through one
// uncategorized-vendor group at a time. Mirrors the AI Cleanup Review
// page's shape, but the "Group X of Y" info box shows the CURRENT CONTACT
// (e.g. "Romeo Ugali") instead of a category. Powered by the same
// `/cleanup-suggestions` payload the Transactions Copilot chips use.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import AccountPicker from "@/components/AccountPicker";
import {
  Users, ArrowLeft, ArrowRight, Check, SkipForward, Sparkles,
} from "lucide-react";

export default function LetsReview() {
  const { currentId } = useCompany();
  const [groups, setGroups] = useState([]);
  const [idx, setIdx] = useState(0);
  const [rows, setRows] = useState([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [pickedAcctId, setPickedAcctId] = useState("");
  const [createRule, setCreateRule] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // On mount → load contact-grouped uncategorized buckets (Step 2 material)
  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/transactions/cleanup-suggestions`).then(r => {
      const gs = (r.data?.top_actions || []).filter(a => a.kind === "contact_in_uncat");
      setGroups(gs);
    });
    api.get(`/companies/${currentId}/accounts`).then(r => setAccounts(r.data?.accounts || r.data || []));
  }, [currentId]);

  const current = groups[idx];

  // Load the current contact's uncategorized rows
  useEffect(() => {
    if (!currentId || !current) { setRows([]); return; }
    setRowsLoading(true);
    setPickedAcctId("");
    api.get(`/companies/${currentId}/transactions`, {
      params: { contact_id: current.contact_id, status: "uncategorized", limit: 100 },
    })
      .then(r => setRows(r.data?.transactions || r.data?.items || []))
      .catch(() => setRows([]))
      .finally(() => setRowsLoading(false));
  }, [currentId, current?.contact_id]);

  const totalAmount = useMemo(
    () => rows.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0),
    [rows]
  );

  const approve = async () => {
    if (!pickedAcctId) { toast.error("Pick a category first."); return; }
    if (!current || rows.length === 0) return;
    setSubmitting(true);
    try {
      const res = await api.post(
        `/companies/${currentId}/transactions/apply-bulk-approve-rule`,
        {
          txn_ids: rows.map(r => r.id),
          category_account_id: pickedAcctId,
          contact_id: current.contact_id,
          contact_name: current.contact_name,
          create_rule: createRule,
        },
      );
      toast.success(`Approved ${res.data.updated} ${current.contact_name} transactions${res.data.rule_id ? " · rule saved" : ""}`);
      // Drop this group from the list and stay at the same index (next
      // group slides in). If we ran off the end, step back.
      setGroups(gs => gs.filter((_, i) => i !== idx));
      setIdx(i => Math.min(i, groups.length - 2));
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Approve failed");
    } finally {
      setSubmitting(false);
    }
  };

  const next = () => setIdx(i => Math.min(i + 1, groups.length - 1));
  const prev = () => setIdx(i => Math.max(i - 1, 0));

  return (
    <div className="p-6 max-w-6xl mx-auto" data-testid="lets-review-page">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900">
            Let's Review
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            One vendor at a time. Pick a category for the whole group and approve in one click.
          </p>
        </div>
        {current && (
          <div
            className="rounded-lg border-2 border-indigo-200 bg-indigo-50/50 px-4 py-2 text-right shrink-0"
            data-testid="lets-review-info-box"
          >
            <div className="text-[10px] uppercase tracking-wider text-indigo-700 font-semibold">
              Contact {idx + 1} of {groups.length}
            </div>
            <div className="font-heading text-lg font-bold text-slate-900 leading-tight">
              {current.contact_name}
            </div>
            <div className="text-[11px] text-slate-500">
              {current.count} txns · {fmtMoney(current.total_amount)}
            </div>
          </div>
        )}
      </div>

      {groups.length === 0 && (
        <div className="rounded-xl border bg-white p-8 text-center mt-6">
          <Sparkles className="mx-auto text-emerald-500 mb-2" size={28} />
          <div className="font-semibold text-slate-900">Nothing to review</div>
          <div className="text-sm text-slate-500">
            No uncategorized vendor groups. You're clean.
          </div>
        </div>
      )}

      {current && (
        <div className="rounded-xl border bg-white p-5 mt-4">
          {/* Chooser: one AccountPicker + Create rule toggle */}
          <div className="flex items-end gap-3 flex-wrap mb-4 pb-4 border-b">
            <div className="flex-1 min-w-[280px]">
              <label className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold block mb-1">
                Category for all {rows.length} transactions
              </label>
              <AccountPicker
                accounts={accounts}
                value={pickedAcctId}
                onChange={setPickedAcctId}
                placeholder="Pick a category…"
                data-testid="lets-review-account-picker"
              />
            </div>
            <label className="inline-flex items-center gap-2 text-xs text-slate-600 py-2">
              <input
                type="checkbox"
                checked={createRule}
                onChange={e => setCreateRule(e.target.checked)}
                data-testid="lets-review-create-rule"
              />
              Also save a rule so future {current.contact_name} rows auto-post here
            </label>
            <button
              onClick={approve}
              disabled={!pickedAcctId || submitting || rows.length === 0}
              data-testid="lets-review-approve"
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Check size={14} />
              {submitting ? "Approving…" : `Approve ${rows.length} →`}
            </button>
          </div>

          {/* Transactions preview */}
          {rowsLoading ? (
            <div className="text-sm text-slate-400 py-8 text-center">Loading rows…</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-slate-500 py-6 text-center">
              No uncategorized rows found for this contact. Skip to next.
            </div>
          ) : (
            <div className="divide-y divide-slate-100" data-testid="lets-review-rows">
              {rows.map(t => (
                <div key={t.id} className="grid grid-cols-[110px_auto_120px] gap-3 py-2 text-sm items-center">
                  <div className="text-slate-500 text-xs">{t.date}</div>
                  <div className="truncate">
                    <div className="font-medium text-slate-900 truncate">{t.description || t.merchant_name}</div>
                    <div className="text-[11px] text-slate-500">
                      {t.category_account_code || "—"} · {t.category_account_name || "Uncategorized"}
                    </div>
                  </div>
                  <div className={`font-mono-num text-right text-sm ${(t.amount || 0) < 0 ? "text-slate-900" : "text-emerald-600"}`}>
                    {fmtMoney(t.amount || 0)}
                  </div>
                </div>
              ))}
              <div className="pt-3 mt-3 flex justify-between text-xs text-slate-500">
                <span>{rows.length} transaction{rows.length === 1 ? "" : "s"}</span>
                <span className="font-mono-num">Total abs: {fmtMoney(totalAmount)}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {groups.length > 0 && (
        <div className="flex items-center justify-between mt-5">
          <button
            onClick={prev}
            disabled={idx === 0}
            data-testid="lets-review-prev"
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-sm px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ArrowLeft size={14} /> Previous
          </button>
          <div className="text-xs text-slate-500 inline-flex items-center gap-1">
            <Users size={12} /> {idx + 1} / {groups.length}
          </div>
          <div className="flex gap-2">
            <button
              onClick={next}
              disabled={idx >= groups.length - 1}
              data-testid="lets-review-skip"
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-sm px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <SkipForward size={14} /> Skip
            </button>
            <button
              onClick={next}
              disabled={idx >= groups.length - 1}
              data-testid="lets-review-next"
              className="inline-flex items-center gap-1 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-sm px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next <ArrowRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
