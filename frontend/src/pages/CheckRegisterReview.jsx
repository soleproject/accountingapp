import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, Plus, X, AlertTriangle, Check as CheckIcon, Split, Info } from "lucide-react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";
import CleanupCopilot from "@/components/CleanupCopilot";

// ---------------------------------------------------------------------------
// Step 4: Check Register Review
// Assign payee + line-item splits to Plaid-imported checks that arrived
// with no counterparty. Design spec: /app/memory/CHECK_REGISTER_ROADMAP.md
// ---------------------------------------------------------------------------

const MONEY = (n) => `$${Number(n || 0).toFixed(2)}`;

export default function CheckRegisterReview() {
  const nav = useNavigate();
  const { currentId } = useCompany();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalAmount, setTotalAmount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [contacts, setContacts] = useState([]);
  // Row-level edit state, keyed by txn id
  const [edits, setEdits] = useState({}); // { [id]: {payeeQuery, contact_id, lines: [{category_account_id, amount}], saveAsRule} }

  const load = async () => {
    if (!currentId) return;
    setBusy(true);
    try {
      const [checksR, actsR, contactsR] = await Promise.all([
        api.get(`/companies/${currentId}/check-review/unassigned`, { params: { limit: 100 } }),
        api.get(`/companies/${currentId}/accounts`),
        api.get(`/companies/${currentId}/contacts`, { params: { type: "vendor", limit: 200 } }),
      ]);
      setRows(checksR.data.checks || []);
      setTotal(checksR.data.total || 0);
      setTotalAmount(checksR.data.total_amount || 0);
      // Filter accounts to expense/asset/cogs (checks pay for those)
      const acctFilter = (a) =>
        !a.retired_at && !["9999", "6999", "4999"].includes(String(a.code));
      setAccounts((actsR.data?.accounts || []).filter(acctFilter));
      setContacts(contactsR.data?.contacts || []);
    } catch (e) {
      toast.error(`Failed to load: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId]);

  const getEdit = (row) => edits[row.id] || {
    payeeQuery: "",
    contact_id: null,
    lines: [{ category_account_id: "", amount: Math.abs(row.amount || 0) }],
    saveAsRule: false,
  };
  const setEdit = (id, patch) => setEdits((e) => ({ ...e, [id]: { ...getEditById(id, e), ...patch } }));
  const getEditById = (id, source = edits) =>
    source[id] || {
      payeeQuery: "",
      contact_id: null,
      lines: [{ category_account_id: "", amount: 0 }],
      saveAsRule: false,
    };

  // ---- Row actions ----

  const applySameAsAbove = (row, prevRow) => {
    if (!prevRow) return;
    const prevEdit = getEdit(prevRow);
    setEdit(row.id, {
      payeeQuery: prevRow.contact_name || prevEdit.payeeQuery,
      contact_id: prevRow.contact_id || prevEdit.contact_id,
      lines: prevEdit.lines.length > 0
        ? [{ ...prevEdit.lines[0], amount: Math.abs(row.amount || 0) }]
        : [{ category_account_id: "", amount: Math.abs(row.amount || 0) }],
      saveAsRule: false,
    });
  };

  const addLine = (row) => {
    const cur = getEdit(row);
    setEdit(row.id, { lines: [...cur.lines, { category_account_id: "", amount: 0 }] });
  };
  const removeLine = (row, idx) => {
    const cur = getEdit(row);
    if (cur.lines.length <= 1) return;
    setEdit(row.id, { lines: cur.lines.filter((_, i) => i !== idx) });
  };
  const updateLine = (row, idx, patch) => {
    const cur = getEdit(row);
    setEdit(row.id, {
      lines: cur.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
    });
  };

  const notACheck = async (row) => {
    try {
      await api.post(`/companies/${currentId}/check-review/${row.id}/not-a-check`);
      setRows((rs) => rs.filter((r) => r.id !== row.id));
      setTotal((t) => Math.max(0, t - 1));
      toast.success(`Marked check #${row.number || row.id.slice(0,8)} as not a check.`);
    } catch (e) {
      toast.error(`Failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const save = async (row) => {
    const cur = getEdit(row);
    // Validate
    if (!cur.contact_id && !cur.payeeQuery.trim()) {
      toast.error("Enter or select a payee first.");
      return;
    }
    const expected = Number(Math.abs(row.amount || 0).toFixed(2));
    const got = cur.lines.reduce((s, l) => s + Number(l.amount || 0), 0);
    if (Math.abs(got - expected) > 0.005) {
      toast.error(`Line total ${MONEY(got)} doesn't match check ${MONEY(expected)}.`);
      return;
    }
    if (cur.lines.some((l) => !l.category_account_id)) {
      toast.error("Every line needs a category.");
      return;
    }
    try {
      const body = {
        contact_id: cur.contact_id || null,
        create_contact_name: cur.contact_id ? null : cur.payeeQuery.trim(),
        line_items: cur.lines.map((l) => ({
          category_account_id: l.category_account_id,
          amount: Number(l.amount),
          description: l.description || "",
        })),
        save_as_rule: !!cur.saveAsRule,
        mark_reviewed: true,
      };
      await api.post(`/companies/${currentId}/check-review/${row.id}/assign`, body);
      // Remove the row from view (idempotent — it now has a contact)
      setRows((rs) => rs.filter((r) => r.id !== row.id));
      setTotal((t) => Math.max(0, t - 1));
      setEdits((e) => { const c = { ...e }; delete c[row.id]; return c; });
      toast.success(`Assigned check #${row.number || row.id.slice(0,8)}${body.save_as_rule ? " + saved rule" : ""}.`);
    } catch (e) {
      toast.error(`Save failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6" data-testid="check-review-page">
      <div className="max-w-[1400px] mx-auto">
        <button
          onClick={() => nav("/accounting/ai-cleanup-review")}
          className="text-sm text-slate-600 hover:text-slate-900 flex items-center gap-1 mb-3"
          data-testid="check-review-back"
        >
          <ChevronLeft size={16} /> Back to cleanup review
        </button>

        {/* AI Cleanup Copilot header panel — same donut + step badge that
            appears on Step 3B (No-Contact Review). Forces sub-label "3C"
            so the badge reads "Step 3C: No Contact" with the check count
            and unit even if 3A/3B still have open work. */}
        <div className="mb-4">
          <CleanupCopilot
            currentId={currentId}
            hideChips={true}
            headerOnly={true}
            forceStep={3}
            forceSubLabel="3C"
          />
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-5 mb-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2">
                <span className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-sm font-semibold">4</span>
                <h1 className="text-2xl font-semibold text-slate-900">Check Register Review</h1>
              </div>
              <p className="text-sm text-slate-600 mt-2 max-w-2xl">
                Assign the payee and category to each check your bank feed
                couldn't identify. You can split a single check across
                multiple categories, save the payee → category pair as a
                rule for next time, or flag a row as not-actually-a-check.
              </p>
            </div>
            <div className="text-right shrink-0">
              <div className="text-3xl font-bold text-slate-900" data-testid="check-review-total-count">{total}</div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Checks</div>
              <div className="text-sm text-slate-700 mt-1">{MONEY(Math.abs(totalAmount))}</div>
            </div>
          </div>
        </div>

        {busy && rows.length === 0 && (
          <div className="text-center text-slate-500 py-8">Loading checks…</div>
        )}
        {!busy && rows.length === 0 && (
          <div className="bg-white rounded-lg border border-slate-200 p-10 text-center">
            <CheckIcon className="mx-auto text-emerald-500 mb-3" size={40} />
            <div className="text-lg font-semibold text-slate-900">No checks to review</div>
            <div className="text-sm text-slate-600 mt-1">Every imported check has a payee assigned.</div>
          </div>
        )}

        {rows.length > 0 && (
          <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr className="text-left text-xs uppercase tracking-wide text-slate-600">
                  <th className="px-3 py-2 w-24">Check #</th>
                  <th className="px-3 py-2 w-28">Date</th>
                  <th className="px-3 py-2 w-28">Amount</th>
                  <th className="px-3 py-2 w-60">Payee</th>
                  <th className="px-3 py-2">Categories &amp; Amounts</th>
                  <th className="px-3 py-2 w-40 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <CheckRow
                    key={row.id}
                    row={row}
                    prevRow={i > 0 ? rows[i - 1] : null}
                    edit={getEdit(row)}
                    accounts={accounts}
                    contacts={contacts}
                    onUpdateLine={(idx, patch) => updateLine(row, idx, patch)}
                    onAddLine={() => addLine(row)}
                    onRemoveLine={(idx) => removeLine(row, idx)}
                    onSetEdit={(patch) => setEdit(row.id, patch)}
                    onSameAsAbove={() => applySameAsAbove(row, i > 0 ? rows[i - 1] : null)}
                    onSave={() => save(row)}
                    onNotACheck={() => notACheck(row)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One row = one check
// ---------------------------------------------------------------------------

function CheckRow({ row, prevRow, edit, accounts, contacts, onUpdateLine, onAddLine, onRemoveLine, onSetEdit, onSameAsAbove, onSave, onNotACheck }) {
  const expected = Number(Math.abs(row.amount || 0).toFixed(2));
  const got = edit.lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const balanced = Math.abs(got - expected) < 0.005;
  const isSplit = edit.lines.length > 1;

  // Payee typeahead — most-frequent in-list contacts filtered by query
  const payeeMatches = useMemo(() => {
    const q = (edit.payeeQuery || "").toLowerCase().trim();
    if (!q) return [];
    return contacts
      .filter((c) => (c.name || "").toLowerCase().includes(q))
      .slice(0, 8);
  }, [edit.payeeQuery, contacts]);
  const [showPayeeMenu, setShowPayeeMenu] = useState(false);

  return (
    <tr className="border-b border-slate-100 align-top hover:bg-slate-50/50" data-testid={`check-row-${row.id}`}>
      <td className="px-3 py-3 font-mono text-sm text-slate-800">
        {row.number || <span className="text-slate-400">—</span>}
      </td>
      <td className="px-3 py-3 text-slate-700 whitespace-nowrap">{row.date}</td>
      <td className="px-3 py-3 font-semibold text-slate-900">{MONEY(Math.abs(row.amount))}</td>

      {/* Payee typeahead */}
      <td className="px-3 py-3">
        <div className="relative">
          <input
            type="text"
            className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
            placeholder="Type payee name..."
            value={edit.payeeQuery}
            onFocus={() => setShowPayeeMenu(true)}
            onBlur={() => setTimeout(() => setShowPayeeMenu(false), 150)}
            onChange={(e) => onSetEdit({ payeeQuery: e.target.value, contact_id: null })}
            data-testid={`check-payee-input-${row.id}`}
          />
          {showPayeeMenu && payeeMatches.length > 0 && (
            <div className="absolute z-20 left-0 right-0 top-full mt-0.5 bg-white border border-slate-200 rounded shadow-lg max-h-48 overflow-auto">
              {payeeMatches.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => { onSetEdit({ payeeQuery: c.name, contact_id: c.id }); setShowPayeeMenu(false); }}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-indigo-50 border-b border-slate-100 last:border-0"
                  data-testid={`check-payee-option-${c.id}`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {showPayeeMenu && edit.payeeQuery && !edit.contact_id && payeeMatches.length === 0 && (
            <div className="absolute z-20 left-0 right-0 top-full mt-0.5 bg-white border border-indigo-200 rounded shadow-lg">
              <div className="px-3 py-2 text-sm text-indigo-700 flex items-center gap-1.5">
                <Plus size={14} /> Will create <b>{edit.payeeQuery.trim()}</b> as a new payee
              </div>
            </div>
          )}
          {prevRow && (prevRow.contact_id || prevRow.contact_name) && (
            <button
              type="button"
              onClick={onSameAsAbove}
              className="mt-1 text-xs text-slate-500 hover:text-indigo-700 flex items-center gap-1"
              title="Copy payee + category from the check above"
              data-testid={`check-same-as-above-${row.id}`}
            >
              ↑ Same as above
            </button>
          )}
        </div>
      </td>

      {/* Categories & Amounts */}
      <td className="px-3 py-3">
        <div className="space-y-1.5">
          {edit.lines.map((line, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <select
                className="flex-1 px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                value={line.category_account_id}
                onChange={(e) => onUpdateLine(idx, { category_account_id: e.target.value })}
                data-testid={`check-category-${row.id}-${idx}`}
              >
                <option value="">Select category…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                ))}
              </select>
              <input
                type="number"
                step="0.01"
                className="w-24 px-2 py-1.5 border border-slate-300 rounded text-sm text-right focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                value={line.amount}
                onChange={(e) => onUpdateLine(idx, { amount: e.target.value })}
                data-testid={`check-amount-${row.id}-${idx}`}
              />
              {isSplit && (
                <button
                  type="button"
                  onClick={() => onRemoveLine(idx)}
                  className="p-1 text-slate-400 hover:text-red-600"
                  title="Remove line"
                  data-testid={`check-remove-line-${row.id}-${idx}`}
                >
                  <X size={16} />
                </button>
              )}
            </div>
          ))}
          <div className="flex items-center gap-3 pt-1 flex-wrap">
            <button
              type="button"
              onClick={onAddLine}
              className="text-xs text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
              data-testid={`check-add-line-${row.id}`}
            >
              <Split size={12} /> {isSplit ? "Add another line" : "Split"}
            </button>
            {isSplit && (
              <div className={`text-xs flex items-center gap-1 ${balanced ? "text-emerald-600" : "text-red-600"}`}>
                {balanced ? <CheckIcon size={12} /> : <AlertTriangle size={12} />}
                Total {MONEY(got)} {balanced ? "✓" : `(need ${MONEY(expected)})`}
              </div>
            )}
            <label className="text-xs text-slate-600 flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={!!edit.saveAsRule}
                onChange={(e) => onSetEdit({ saveAsRule: e.target.checked })}
                data-testid={`check-save-rule-${row.id}`}
              />
              Save as rule
            </label>
          </div>
          {(row.memo || row.description) && (
            <div className="text-xs text-slate-500 flex items-start gap-1 pt-1">
              <Info size={11} className="mt-0.5 shrink-0" />
              <span className="line-clamp-2">{row.memo || row.description}</span>
            </div>
          )}
        </div>
      </td>

      {/* Actions */}
      <td className="px-3 py-3">
        <div className="flex flex-col gap-1.5 items-end">
          <button
            type="button"
            onClick={onSave}
            className="w-full px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm font-medium"
            data-testid={`check-save-${row.id}`}
          >
            Save
          </button>
          <button
            type="button"
            onClick={onNotACheck}
            className="text-xs text-slate-500 hover:text-red-600"
            data-testid={`check-not-a-check-${row.id}`}
          >
            Not a check
          </button>
        </div>
      </td>
    </tr>
  );
}
