/**
 * ChecksAllocatorInline — full multi-line check allocator that expands
 * inside a Checks (missing payee) row on the Responsibilities panel.
 * Mirrors the `ChecksAssignTable` structure from the Quick Check-in
 * (`ClientReviewPage.jsx`) but drives the firm-authenticated endpoints
 * so the CPA doesn't leave the To Do / Client Cockpit page.
 *
 * Per check card:
 *   • Header: #Number · Date · $Amount · Save button
 *   • PAYEE dropdown (existing contacts) with "+ create new" inline
 *   • CATEGORIES & AMOUNTS: N line rows, each with a category-or-bill
 *     dropdown + amount input. "+ Add another line" appends.
 *   • Live total-vs-check validation, green ✓ or red mismatch chip.
 */
import React, { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { useMoneyFmt } from "@/lib/company";
import { Loader2, Save, Plus, X, Check } from "lucide-react";

const _fmtDate = (iso) => {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric", month: "2-digit", day: "2-digit",
    });
  } catch { return iso; }
};

// Blank line factory — new allocation lines start empty; the caller
// pre-populates the first line with the check amount so 1-line
// allocations save with a single click.
const _emptyLine = () => ({ pick: "", amount: "", description: "" });

export default function ChecksAllocatorInline({ companyId, item, onAllDone }) {
  const fmtMoney = useMoneyFmt();
  const checks = item.checks || [];
  const [contacts, setContacts] = useState([]);
  const [pickable, setPickable] = useState({ accounts: [], bills: [] });
  const [loading,  setLoading]  = useState(true);
  // Per-check draft state, keyed by txn id.
  const [drafts,   setDrafts]   = useState({});
  const [savingId, setSavingId] = useState(null);
  const [savedIds, setSavedIds] = useState(() => new Set(item.resolved_txn_ids || []));

  // Load contacts + pickable on mount. Contacts endpoint is app-wide;
  // pickable is the firm-auth wrapper around the client-review shape.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cRes, pRes] = await Promise.all([
          api.get(`/companies/${companyId}/contacts`),
          api.get(`/companies/${companyId}/checkin/pickable`),
        ]);
        if (cancelled) return;
        const cs = (cRes.data?.contacts || cRes.data || [])
          .filter(c => c && c.id && c.name)
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        setContacts(cs);
        setPickable({
          accounts: pRes.data?.accounts || [],
          bills:    pRes.data?.bills    || [],
        });
        // Seed each check with one blank line pre-filled with the amount.
        const seed = {};
        for (const c of checks) {
          seed[c.id] = {
            contact_id: "",
            create_name: "",
            lines: [{ ..._emptyLine(), amount: String(Math.abs(Number(c.amount || 0)).toFixed(2)) }],
          };
        }
        setDrafts(seed);
      } catch (e) {
        if (!cancelled) toast.error(e?.response?.data?.detail || "Failed to load allocator data");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [companyId, checks.length]);   // eslint-disable-line react-hooks/exhaustive-deps

  const updateDraft = (checkId, patch) => {
    setDrafts(prev => ({ ...prev, [checkId]: { ...prev[checkId], ...patch } }));
  };
  const updateLine = (checkId, idx, patch) => {
    setDrafts(prev => {
      const d = prev[checkId] || {};
      const lines = (d.lines || []).slice();
      lines[idx] = { ...lines[idx], ...patch };
      return { ...prev, [checkId]: { ...d, lines } };
    });
  };
  const addLine = (checkId) =>
    setDrafts(prev => {
      const d = prev[checkId] || {};
      const lines = (d.lines || []).concat(_emptyLine());
      return { ...prev, [checkId]: { ...d, lines } };
    });
  const removeLine = (checkId, idx) =>
    setDrafts(prev => {
      const d = prev[checkId] || {};
      const lines = (d.lines || []).slice();
      lines.splice(idx, 1);
      return { ...prev, [checkId]: { ...d, lines: lines.length ? lines : [_emptyLine()] } };
    });

  const save = async (check) => {
    const draft = drafts[check.id] || {};
    const rawLines = (draft.lines || []).filter(l => (l.pick || l.amount));
    if (!rawLines.length) return toast.error("Add at least one category or bill line.");
    const line_items = rawLines.map(l => {
      const isBill = (l.pick || "").startsWith("bill:");
      const isAcct = (l.pick || "").startsWith("acct:");
      return {
        bill_id:             isBill ? l.pick.slice(5) : null,
        category_account_id: isAcct ? l.pick.slice(5) : null,
        amount:              parseFloat(l.amount || "0") || 0,
        description:         l.description || null,
      };
    });
    for (const li of line_items) {
      if (!li.bill_id && !li.category_account_id) {
        return toast.error("Every line needs a category or a bill.");
      }
    }
    const expected = Math.abs(Number(check.amount || 0));
    const got = line_items.reduce((s, l) => s + (l.amount || 0), 0);
    if (Math.abs(got - expected) > 0.005) {
      return toast.error(`Line total $${got.toFixed(2)} doesn't match check $${expected.toFixed(2)}.`);
    }
    const body = {
      txn_id: check.id,
      contact_id: draft.contact_id || null,
      create_contact_name: (!draft.contact_id && draft.create_name) ? draft.create_name : null,
      line_items,
    };
    if (!body.contact_id && !body.create_contact_name) {
      // Bill-driven payee auto-adoption is allowed — only require a
      // payee choice when NO line is a bill.
      const hasBill = line_items.some(l => l.bill_id);
      if (!hasBill) return toast.error("Pick a payee or add a bill line.");
    }
    setSavingId(check.id);
    try {
      const r = await api.post(
        `/companies/${companyId}/checkin/items/${item.id}/check-assign`,
        body,
      );
      toast.success(`${check.number || "Check"} saved — ${r.data?.contact_name || "assigned"}`);
      setSavedIds(prev => new Set(prev).add(check.id));
      if (r.data?.all_done) {
        // Item fully answered — parent tile will drop the row + refresh.
        setTimeout(() => onAllDone?.(item.id), 400);
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally {
      setSavingId(null);
    }
  };

  // Payee options: existing contacts (sorted) + a marker for inline
  // creation via the free-text field.
  const contactOptions = useMemo(() =>
    contacts.map(c => ({ value: c.id, label: c.name })),
    [contacts]);

  // Pickable dropdown options: bills first (urgent, dated), then all
  // accounts. Values prefixed so the save handler can tell them apart.
  const pickOptions = useMemo(() => {
    const opts = [];
    if (pickable.bills.length) {
      opts.push({ group: "Open bills", options: pickable.bills.map(b => ({
        value: `bill:${b.id}`,
        label: b.label,
      }))});
    }
    if (pickable.accounts.length) {
      opts.push({ group: "Categories", options: pickable.accounts.map(a => ({
        value: `acct:${a.id}`,
        label: `${a.code ? a.code + " · " : ""}${a.name}`,
      }))});
    }
    return opts;
  }, [pickable]);

  if (loading) {
    return (
      <div className="mt-2 rounded-md border border-indigo-200 bg-indigo-50/40 p-6 flex items-center justify-center text-slate-500" data-testid="checks-allocator-loading">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }

  const remaining = checks.filter(c => !savedIds.has(c.id));
  const savedCount = checks.length - remaining.length;

  return (
    <div className="mt-2 rounded-md border border-indigo-200 bg-indigo-50/30 p-3 space-y-3"
         data-testid={`checks-allocator-${item.id}`}>
      <div className="flex items-center justify-between px-1">
        <div>
          <div className="text-sm font-semibold text-slate-900">
            {checks.length} check{checks.length === 1 ? "" : "s"} still need a payee
          </div>
          <div className="text-[11px] text-slate-500">
            Fill in who each check was for, or apply it to an outstanding bill.
          </div>
        </div>
        <div className="text-[11px] text-slate-600 font-mono-num">
          {savedCount} of {checks.length} saved
        </div>
      </div>

      {checks.map((check) => {
        const isSaved = savedIds.has(check.id);
        const draft = drafts[check.id] || { lines: [_emptyLine()] };
        const expected = Math.abs(Number(check.amount || 0));
        const lineTotal = (draft.lines || []).reduce(
          (s, l) => s + (parseFloat(l.amount || "0") || 0), 0);
        const balanced = Math.abs(lineTotal - expected) < 0.005;
        return (
          <div
            key={check.id}
            className={`rounded-lg border bg-white p-3 space-y-2 transition-opacity ${isSaved ? "opacity-60" : ""}`}
            data-testid={`check-card-${check.id}`}
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <span className="text-slate-500 text-sm font-mono-num shrink-0">
                  #{check.number || "—"}
                </span>
                <span className="text-slate-500 text-sm font-mono-num shrink-0">
                  {_fmtDate(check.date)}
                </span>
                <span className="text-slate-900 text-sm font-mono-num font-semibold shrink-0">
                  {fmtMoney(expected)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => save(check)}
                disabled={savingId === check.id || isSaved}
                className={`inline-flex items-center gap-1 text-[11px] px-3 py-1.5 rounded-md font-medium transition-colors shrink-0 ${
                  isSaved
                    ? "bg-emerald-50 text-emerald-700 border border-emerald-200 cursor-default"
                    : "bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                }`}
                data-testid={`check-save-${check.id}`}
              >
                {isSaved ? <Check size={12} />
                 : savingId === check.id ? <Loader2 size={12} className="animate-spin" />
                                          : <Save size={12} />}
                {isSaved ? "Saved" : "Save"}
              </button>
            </div>

            {!isSaved && (
              <>
                {/* Payee */}
                <div className="space-y-1">
                  <label className="block text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Payee</label>
                  <select
                    className="w-full text-sm px-3 py-2 border border-slate-300 rounded-md bg-white focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                    value={draft.contact_id || ""}
                    onChange={(e) => updateDraft(check.id, { contact_id: e.target.value, create_name: "" })}
                    data-testid={`check-payee-${check.id}`}
                  >
                    <option value="">Select payee…</option>
                    {contactOptions.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  {!draft.contact_id && (
                    <input
                      className="w-full text-xs px-2.5 py-1.5 border border-slate-200 rounded-md bg-slate-50 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                      placeholder="…or type a new payee name"
                      value={draft.create_name || ""}
                      onChange={(e) => updateDraft(check.id, { create_name: e.target.value })}
                      data-testid={`check-new-payee-${check.id}`}
                    />
                  )}
                </div>

                {/* Lines */}
                <div className="space-y-1">
                  <label className="block text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Categories & amounts</label>
                  <div className="space-y-1.5">
                    {(draft.lines || []).map((line, idx) => (
                      <div key={idx} className="flex items-center gap-2" data-testid={`check-line-${check.id}-${idx}`}>
                        <select
                          className="flex-1 text-sm px-2 py-1.5 border border-slate-300 rounded-md bg-white focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 min-w-0"
                          value={line.pick || ""}
                          onChange={(e) => updateLine(check.id, idx, { pick: e.target.value })}
                          data-testid={`check-line-pick-${check.id}-${idx}`}
                        >
                          <option value="">Select category or bill…</option>
                          {pickOptions.map(g => (
                            <optgroup key={g.group} label={g.group}>
                              {g.options.map(o => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                        <input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          className="w-24 text-sm px-2 py-1.5 border border-slate-300 rounded-md bg-white focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 text-right font-mono-num"
                          placeholder="0.00"
                          value={line.amount}
                          onChange={(e) => updateLine(check.id, idx, { amount: e.target.value })}
                          data-testid={`check-line-amount-${check.id}-${idx}`}
                        />
                        {(draft.lines || []).length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeLine(check.id, idx)}
                            className="text-slate-400 hover:text-slate-700 p-1"
                            data-testid={`check-line-remove-${check.id}-${idx}`}
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <button
                      type="button"
                      onClick={() => addLine(check.id)}
                      className="text-[11px] text-indigo-700 hover:text-indigo-900 inline-flex items-center gap-1"
                      data-testid={`check-line-add-${check.id}`}
                    >
                      <Plus size={11} /> Add another line
                    </button>
                    <span className={`text-[11px] font-mono-num ${balanced ? "text-emerald-700" : "text-red-600"}`}>
                      Total {fmtMoney(lineTotal)} {balanced ? "✓" : `(need ${fmtMoney(expected)})`}
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
