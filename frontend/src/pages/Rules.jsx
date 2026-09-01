import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Wand2, Trash2, Plus, X, Sparkles, Check, ChevronDown, Bot } from "lucide-react";
import { toast } from "sonner";
import QuickCreateModal from "@/components/QuickCreateModal";

export default function Rules() {
  const { currentId } = useCompany();
  const [rules, setRules] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [accts, setAccts] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [classes, setClasses] = useState([]);
  const [tags, setTags] = useState([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const load = async () => {
    if (!currentId) return;
    const [r, a, c, cl, tg] = await Promise.all([
      api.get(`/companies/${currentId}/rules`),
      api.get(`/companies/${currentId}/accounts`),
      api.get(`/companies/${currentId}/contacts?limit=500`).catch(() => ({ data: {} })),
      api.get(`/companies/${currentId}/classes`).catch(() => ({ data: {} })),
      api.get(`/companies/${currentId}/tags`).catch(() => ({ data: {} })),
    ]);
    setRules(r.data.rules || []);
    setCandidates(r.data.candidates || []);
    setAccts(a.data.accounts || []);
    setContacts((c.data?.contacts || []).map(x => ({ id: x.id, name: x.name })));
    setClasses((cl.data?.classes || cl.data?.items || []).map(x => ({ id: x.id, name: x.name })));
    setTags((tg.data?.tags || tg.data?.items || []).map(x => ({ id: x.id, name: x.name })));
  };
  useEffect(() => { load(); }, [currentId]);

  const del = async (id) => {
    if (!confirm("Delete rule?")) return;
    await api.delete(`/companies/${currentId}/rules/${id}`);
    load();
  };

  const promoteCandidate = async (c) => {
    try {
      const r = await api.post(`/companies/${currentId}/rules`, {
        match_type: "merchant_contains", match_value: c.merchant,
        account_code: c.account_code, apply_to_existing: true,
      });
      toast.success(
        `Rule created: "${c.merchant}" → ${c.account_name}`
        + (r.data.applied ? ` (applied to ${r.data.applied} txn${r.data.applied === 1 ? "" : "s"})` : "")
      );
      load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to create rule");
    }
  };

  const dismissCandidate = async (c) => {
    await api.delete(`/companies/${currentId}/rule-candidates/${c.id}`);
    toast.success(`Dismissed suggestion for "${c.merchant}"`);
    load();
  };

  const acceptAll = async () => {
    if (!candidates.length) return;
    setBusy(true);
    let ok = 0, fail = 0, applied = 0;
    for (const c of candidates) {
      try {
        const r = await api.post(`/companies/${currentId}/rules`, {
          match_type: "merchant_contains", match_value: c.merchant,
          account_code: c.account_code, apply_to_existing: true,
        });
        ok += 1;
        applied += r.data.applied || 0;
      } catch {
        fail += 1;
      }
    }
    setBusy(false);
    toast.success(
      `Accepted ${ok} rule${ok === 1 ? "" : "s"}`
      + (applied ? ` · back-filled ${applied} txn${applied === 1 ? "" : "s"}` : "")
      + (fail ? ` · ${fail} failed` : "")
    );
    load();
  };

  const totalCleanup = candidates.reduce((s, c) => s + (c.applies_to_count || 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">AI Rules</h1>
          <p className="text-slate-500 text-sm mt-1">Rules automate categorization. Auto-suggested when a merchant is approved 2+ times.</p>
        </div>
        <button data-testid={TID.addBtn} onClick={() => setCreating(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
          <Plus size={13} /> Create Rule
        </button>
      </div>

      {candidates.length > 0 && (
        <div className="rounded-xl border bg-indigo-50 border-indigo-200" data-testid="suggested-rules">
          <button
            onClick={() => setExpanded(v => !v)}
            className="w-full px-4 py-3 flex items-center gap-2 text-left"
            data-testid="suggested-rules-toggle"
          >
            <Sparkles size={14} className="text-indigo-600" />
            <h3 className="font-heading font-semibold text-sm">
              AI suggests {candidates.length} new rule{candidates.length === 1 ? "" : "s"}
            </h3>
            {totalCleanup > 0 && (
              <span className="text-[11px] text-indigo-700 bg-indigo-100 px-1.5 py-0.5 rounded">
                would clean up {totalCleanup} un-reviewed txn{totalCleanup === 1 ? "" : "s"}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {candidates.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); acceptAll(); }}
                  disabled={busy}
                  data-testid="suggested-rules-accept-all"
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  <Check size={12} /> Accept all
                </button>
              )}
              <ChevronDown
                size={16}
                className={`text-indigo-600 transition-transform ${expanded ? "" : "-rotate-90"}`}
              />
            </div>
          </button>

          {expanded && (
            <div className="px-4 pb-4 space-y-2">
              {candidates.map(c => (
                <div
                  key={c.id}
                  className="flex items-center gap-3 bg-white rounded-md px-3 py-2 border"
                  data-testid={`suggested-rule-${c.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">
                      When merchant contains <b>{c.merchant}</b> → <b className="tabular-nums">{c.account_code}</b> {c.account_name}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      approved {c.approvals}×
                      {(c.applies_to_count ?? 0) > 0 && (
                        <> · would back-fill <b className="text-indigo-700">{c.applies_to_count}</b> un-reviewed txn{c.applies_to_count === 1 ? "" : "s"}</>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => promoteCandidate(c)}
                    data-testid={`suggested-rule-accept-${c.id}`}
                    className="text-xs px-2.5 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-800"
                  >
                    Create rule
                  </button>
                  <button
                    onClick={() => dismissCandidate(c)}
                    data-testid={`suggested-rule-dismiss-${c.id}`}
                    className="text-xs p-1 text-slate-500 hover:text-rose-600"
                    title="Dismiss"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr>
              <th className="px-3 py-2 text-left">Match</th>
              <th className="px-3 py-2 text-left">Category</th>
              <th className="px-3 py-2 text-left">Source</th>
              <th className="px-3 py-2 text-right">Applied</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rules.map(r => (
              <tr key={r.id} className="border-b hover:bg-slate-50">
                <td className="px-3 py-2">
                  <span className="text-xs text-slate-500">{r.match_type}</span> · <b>{r.match_value}</b>
                </td>
                <td className="px-3 py-2 font-mono-num">{r.account_code} <span className="text-slate-600 font-sans">{r.account_name}</span></td>
                <td className="px-3 py-2">
                  {r.created_by === "ai_miner" ? (
                    // "Auto-applied by AI" — the miner surfaced a
                    // high-confidence (≥98%, ≥10 hits) pattern from
                    // ledger history and promoted it directly to a
                    // real rule without needing a pro to approve.
                    // Emerald so it visually pops vs the plain
                    // indigo "AI" chip used for seeded/manual-AI
                    // rules. Feb 28 2026.
                    <span
                      data-testid="rule-source-badge"
                      title={
                        r.mined_confidence
                          ? `Confidence ${(r.mined_confidence * 100).toFixed(0)}% across ${r.hits} historical txns`
                          : "Promoted directly by the AI rules miner"
                      }
                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200"
                    >
                      <Bot size={9} />
                      Auto-applied by AI
                    </span>
                  ) : (
                    <span
                      data-testid="rule-source-badge"
                      className={`text-[10px] px-1.5 py-0.5 rounded ${r.created_by === "ai" ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-600"}`}
                    >
                      {r.created_by === "ai" ? <><Wand2 size={9} className="inline mr-1" />AI</> : "Human"}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono-num">{r.hits}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => del(r.id)} className="text-red-500 p-1"><Trash2 size={13} /></button>
                </td>
              </tr>
            ))}
            {!rules.length && <tr><td colSpan={5} className="text-center py-8 text-slate-500">No rules yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {creating && <CreateRule
        currentId={currentId}
        accts={accts}
        contacts={contacts}
        classes={classes}
        tags={tags}
        setClasses={setClasses}
        setTags={setTags}
        onClose={() => { setCreating(false); load(); }}
      />}
    </div>
  );
}

function CreateRule({ currentId, accts, contacts, classes, tags, setClasses, setTags, onClose }) {
  const [match, setMatch] = useState("");
  const [matchField, setMatchField] = useState("merchant");   // Feature A
  const [code, setCode] = useState("");
  const [applyExisting, setApplyExisting] = useState(true);
  // Inline "New Class" / "New Tag" popups so users never leave the modal.
  const [quickCreate, setQuickCreate] = useState(null);       // "class" | "tag" | null
  // Tier-1 QBO parity conditions + actions.
  const [bankAccountId, setBankAccountId] = useState("");
  const [amountOp, setAmountOp] = useState("");            // "" | gt | lt | eq | between
  const [amountValue, setAmountValue] = useState("");
  const [amountValue2, setAmountValue2] = useState("");
  const [contactId, setContactId] = useState("");
  // Tier-2 QBO parity — multi-condition + Class/Tag actions + posting mode.
  const [conditionLogic, setConditionLogic] = useState("all"); // all | any
  const [extraConditions, setExtraConditions] = useState([]);   // [{field, op, value, value_2}]
  const [classId, setClassId] = useState("");
  const [tagIds, setTagIds] = useState([]);
  const [postingMode, setPostingMode] = useState("auto");       // auto | review
  const [saving, setSaving] = useState(false);

  const addCondition = () => setExtraConditions(
    (cs) => [...cs, { field: "description", op: "contains", value: "", value_2: "" }]
  );
  const patchCondition = (i, patch) => setExtraConditions(
    (cs) => cs.map((c, idx) => idx === i ? { ...c, ...patch } : c)
  );
  const removeCondition = (i) => setExtraConditions(
    (cs) => cs.filter((_, idx) => idx !== i)
  );

  // Split the CoA into bank/asset options (for the condition) and
  // categorization targets (for the action). Asset+liability parents like
  // Chase Business / BofA Credit Card land in the bank filter.
  const bankOptions = (accts || []).filter(a =>
    ["asset", "liability"].includes((a.type || "").toLowerCase())
    && !a.is_parent
  );
  const categoryOptions = accts || [];

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const payload = {
        match_type: matchField === "contact" ? "contact_equals" : "merchant_contains",
        match_field: matchField,
        match_value: match,
        account_code: code,
        apply_to_existing: applyExisting,
        posting_mode: postingMode,
        condition_logic: conditionLogic,
      };
      if (bankAccountId) payload.bank_account_id = bankAccountId;
      // Contact ACTION is meaningless when the CONDITION already keys
      // on contact — the row already carries the contact id. Skip it.
      if (contactId && matchField !== "contact") payload.contact_id = contactId;
      if (classId)       payload.class_id        = classId;
      if (tagIds.length) payload.tag_ids         = tagIds;
      if (amountOp) {
        payload.amount_op    = amountOp;
        payload.amount_value = Number(amountValue);
        if (amountOp === "between") payload.amount_value_2 = Number(amountValue2);
      }
      if (extraConditions.length) {
        payload.extra_conditions = extraConditions
          .filter(c => c.field && c.op && c.value !== "")
          .map(c => ({
            field:   c.field,
            op:      c.op,
            value:   String(c.value),
            ...(c.op === "between" && c.value_2 !== ""
                ? { value_2: Number(c.value_2) } : {}),
          }));
      }
      const r = await api.post(`/companies/${currentId}/rules`, payload);
      toast.success(`Rule created · applied to ${r.data.applied} existing`);
      onClose();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to create rule");
    } finally {
      setSaving(false);
    }
  };

  const disabled = !match || !code || saving
    || (amountOp && amountValue === "")
    || (amountOp === "between" && amountValue2 === "");

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold">Create Rule</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>

        {/* ---- CONDITIONS ---- */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
              When a transaction matches
            </div>
            {(extraConditions.length > 0) && (
              <div className="flex rounded-md border overflow-hidden text-[10px]">
                {["all", "any"].map(v => (
                  <button
                    key={v}
                    onClick={() => setConditionLogic(v)}
                    data-testid={`rule-logic-${v}`}
                    className={`px-2 py-0.5 uppercase font-medium ${
                      conditionLogic === v
                        ? "bg-slate-900 text-white"
                        : "bg-white text-slate-600 hover:bg-slate-50"}`}
                  >
                    {v === "all" ? "ALL" : "ANY"}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Feature A — primary field selector. Merchant = regex on
              the raw bank string. Contact = exact match on contact_id
              (cleaner for well-curated books). */}
          {Array.isArray(contacts) && contacts.length > 0 && (
            <div className="flex rounded-md border overflow-hidden text-[10px] w-fit mb-2">
              {[
                { v: "merchant", label: "Merchant" },
                { v: "contact",  label: "Contact"  },
              ].map(o => (
                <button
                  key={o.v}
                  onClick={() => {
                    setMatchField(o.v);
                    setMatch("");   // reset value when swapping types
                  }}
                  data-testid={`rule-match-field-${o.v}`}
                  className={`px-2.5 py-1 uppercase font-medium tracking-wider ${
                    matchField === o.v
                      ? "bg-slate-900 text-white"
                      : "bg-white text-slate-600 hover:bg-slate-50"}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}

          {matchField === "contact" ? (
            <select
              value={match}
              onChange={(e) => setMatch(e.target.value)}
              data-testid="rule-match-value"
              className="w-full border rounded px-3 py-2 text-sm"
            >
              <option value="">Contact…</option>
              {contacts.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          ) : (
            <input
              placeholder="Merchant contains (e.g. Uber)"
              value={match}
              onChange={(e) => setMatch(e.target.value)}
              data-testid="rule-match-value"
              className="w-full border rounded px-3 py-2 text-sm"
            />
          )}

          <div className="grid grid-cols-2 gap-2 mt-2">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
                Bank account <span className="text-slate-400 normal-case font-normal">(optional)</span>
              </label>
              <select
                value={bankAccountId}
                onChange={(e) => setBankAccountId(e.target.value)}
                data-testid="rule-bank-account"
                className="w-full border rounded px-2 py-1.5 text-sm"
              >
                <option value="">Any account</option>
                {bankOptions.map(a => (
                  <option key={a.id} value={a.id}>{a.code} {a.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
                Amount <span className="text-slate-400 normal-case font-normal">(optional)</span>
              </label>
              <div className="flex gap-1">
                <select
                  value={amountOp}
                  onChange={(e) => setAmountOp(e.target.value)}
                  data-testid="rule-amount-op"
                  className="border rounded px-1.5 py-1.5 text-sm w-24"
                >
                  <option value="">any</option>
                  <option value="gt">{">"}</option>
                  <option value="lt">{"<"}</option>
                  <option value="eq">{"="}</option>
                  <option value="between">between</option>
                </select>
                <input
                  type="number"
                  step="0.01"
                  placeholder={amountOp === "between" ? "min" : "value"}
                  value={amountValue}
                  onChange={(e) => setAmountValue(e.target.value)}
                  disabled={!amountOp}
                  data-testid="rule-amount-value"
                  className="flex-1 border rounded px-2 py-1.5 text-sm disabled:bg-slate-50 disabled:text-slate-400"
                />
                {amountOp === "between" && (
                  <input
                    type="number"
                    step="0.01"
                    placeholder="max"
                    value={amountValue2}
                    onChange={(e) => setAmountValue2(e.target.value)}
                    data-testid="rule-amount-value-2"
                    className="w-24 border rounded px-2 py-1.5 text-sm"
                  />
                )}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                Signed — deposits {">"}0, withdrawals {"<"}0
              </div>
            </div>
          </div>

          {/* Tier-2: extra conditions builder. Text + amount + bank. */}
          {extraConditions.map((c, i) => (
            <div key={i} className="mt-2 flex items-center gap-1"
                 data-testid={`rule-extra-condition-${i}`}>
              <select
                value={c.field}
                onChange={(e) => patchCondition(i, {
                  field: e.target.value,
                  op: e.target.value === "amount" ? "gt"
                    : e.target.value === "bank_account" ? "equals" : "contains",
                  value: "", value_2: "",
                })}
                className="border rounded px-1 py-1 text-xs w-28"
              >
                <option value="merchant">Merchant</option>
                <option value="description">Description</option>
                <option value="amount">Amount</option>
                <option value="bank_account">Bank acct</option>
              </select>
              <select
                value={c.op}
                onChange={(e) => patchCondition(i, { op: e.target.value })}
                className="border rounded px-1 py-1 text-xs w-28"
              >
                {c.field === "amount" ? (
                  <>
                    <option value="gt">{">"}</option>
                    <option value="lt">{"<"}</option>
                    <option value="eq">{"="}</option>
                    <option value="between">between</option>
                  </>
                ) : c.field === "bank_account" ? (
                  <option value="equals">is</option>
                ) : (
                  <>
                    <option value="contains">contains</option>
                    <option value="not_contains">doesn't contain</option>
                    <option value="starts_with">starts with</option>
                    <option value="ends_with">ends with</option>
                    <option value="equals">equals</option>
                  </>
                )}
              </select>
              {c.field === "bank_account" ? (
                <select
                  value={c.value}
                  onChange={(e) => patchCondition(i, { value: e.target.value })}
                  className="flex-1 border rounded px-2 py-1 text-xs"
                >
                  <option value="">Pick account…</option>
                  {bankOptions.map(a => (
                    <option key={a.id} value={a.id}>{a.code} {a.name}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={c.value}
                  onChange={(e) => patchCondition(i, { value: e.target.value })}
                  placeholder={c.field === "amount" ? "value" : "text"}
                  type={c.field === "amount" ? "number" : "text"}
                  step="0.01"
                  className="flex-1 border rounded px-2 py-1 text-xs"
                />
              )}
              {c.field === "amount" && c.op === "between" && (
                <input
                  value={c.value_2}
                  onChange={(e) => patchCondition(i, { value_2: e.target.value })}
                  placeholder="max"
                  type="number"
                  step="0.01"
                  className="w-16 border rounded px-2 py-1 text-xs"
                />
              )}
              <button
                onClick={() => removeCondition(i)}
                data-testid={`rule-extra-remove-${i}`}
                className="text-slate-400 hover:text-rose-600"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            onClick={addCondition}
            data-testid="rule-add-condition"
            className="mt-2 text-[11px] text-emerald-700 hover:text-emerald-800 inline-flex items-center gap-1"
          >
            <Plus size={11} /> Add condition
          </button>
        </div>

        {/* ---- ACTIONS ---- */}
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
            Then apply
          </div>
          <select
            value={code}
            onChange={(e) => setCode(e.target.value)}
            data-testid="rule-category"
            className="w-full border rounded px-3 py-2 text-sm"
          >
            <option value="">Category…</option>
            {categoryOptions.map(a => (
              <option key={a.id} value={a.code}>{a.code} {a.name}</option>
            ))}
          </select>

          {Array.isArray(contacts) && contacts.length > 0 && matchField !== "contact" && (
            <select
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              data-testid="rule-contact"
              className="w-full border rounded px-3 py-2 text-sm mt-2"
            >
              <option value="">Contact (optional)…</option>
              {contacts.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}

          {Array.isArray(classes) && classes.length > 0 ? (
            <select
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              data-testid="rule-class"
              className="w-full border rounded px-3 py-2 text-sm mt-2"
            >
              <option value="">Class (optional)…</option>
              {classes.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          ) : (
            <div
              data-testid="rule-class-empty"
              className="w-full border rounded px-3 py-2 text-sm mt-2 bg-slate-50 text-slate-500 flex items-center justify-between"
            >
              <span>Class (optional)</span>
              <button
                type="button"
                onClick={() => setQuickCreate("class")}
                data-testid="rule-class-create"
                className="text-[11px] text-emerald-700 hover:underline"
              >
                No classes yet — create one →
              </button>
            </div>
          )}

          {Array.isArray(tags) && tags.length > 0 ? (
            <div className="mt-2">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
                Tags (optional)
              </div>
              <div className="flex flex-wrap gap-1">
                {tags.map(t => {
                  const on = tagIds.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      onClick={() => setTagIds(prev =>
                        on ? prev.filter(x => x !== t.id) : [...prev, t.id])}
                      data-testid={`rule-tag-${t.id}`}
                      className={`px-2 py-0.5 rounded-full text-[11px] border ${
                        on
                          ? "bg-slate-900 text-white border-slate-900"
                          : "bg-white text-slate-700 border-slate-200 hover:border-slate-300"}`}
                    >
                      {t.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div
              data-testid="rule-tags-empty"
              className="w-full border rounded px-3 py-2 text-sm mt-2 bg-slate-50 text-slate-500 flex items-center justify-between"
            >
              <span>Tags (optional)</span>
              <button
                type="button"
                onClick={() => setQuickCreate("tag")}
                data-testid="rule-tag-create"
                className="text-[11px] text-emerald-700 hover:underline"
              >
                No tags yet — create one →
              </button>
            </div>
          )}

          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
              Posting mode
            </div>
            <div className="flex rounded-md border overflow-hidden text-xs w-fit">
              {[
                { v: "auto",   label: "Auto-add",       hint: "Post immediately" },
                { v: "review", label: "Flag for review", hint: "Send to CPA queue" },
              ].map(o => (
                <button
                  key={o.v}
                  onClick={() => setPostingMode(o.v)}
                  data-testid={`rule-posting-${o.v}`}
                  title={o.hint}
                  className={`px-3 py-1 ${
                    postingMode === o.v
                      ? "bg-slate-900 text-white"
                      : "bg-white text-slate-700 hover:bg-slate-50"}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <label className="text-xs flex items-center gap-2">
          <input
            type="checkbox"
            checked={applyExisting}
            onChange={(e) => setApplyExisting(e.target.checked)}
          />
          Apply to existing unreviewed transactions
        </label>
        <button
          data-testid={TID.saveBtn}
          onClick={save}
          disabled={disabled}
          className="w-full py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save rule"}
        </button>
      </div>

      {quickCreate && (
        <QuickCreateModal
          kind={quickCreate}
          currentId={currentId}
          onClose={() => setQuickCreate(null)}
          onCreated={({ id, name }) => {
            if (quickCreate === "class") {
              setClasses(prev => [...prev, { id, name }]);
              setClassId(id);
            } else {
              setTags(prev => [...prev, { id, name }]);
              setTagIds(prev => [...prev, id]);
            }
            setQuickCreate(null);
            toast.success(`${quickCreate === "class" ? "Class" : "Tag"} "${name}" created`);
          }}
        />
      )}
    </div>
  );
}
