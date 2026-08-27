import { useEffect, useMemo, useState } from "react";
import { X, Loader2, Layers, FileText, Receipt, Link2, Plus, ArrowRight } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";

/**
 * Modal form for creating (and later editing) a Project Phase.
 * Fields go beyond the phase itself: a PM can also LINK existing
 * estimates/invoices/bills to this phase (after save), OR open the
 * doc drawer from the modal to CREATE one already tagged to this
 * phase.
 *
 * Props:
 *   - open (bool)
 *   - onClose()
 *   - onSubmit(payload) → returns phase (with id) after save
 *   - projectId, contactId — parent project context (contactId used
 *     to filter linkable docs to the project's customer)
 *   - initial (optional) — existing phase for edit mode
 *   - onOpenDocDrawer(kind) — parent handler to open the doc drawer
 *     with this phase pre-selected after the phase is saved
 *   - onLinkedDocsChanged() — called whenever docs get linked so the
 *     parent Documents tab can refresh
 */
export default function PhaseFormModal({
  open, onClose, onSubmit,
  projectId, contactId,
  initial = null,
  onOpenDocDrawer,
  onLinkedDocsChanged,
}) {
  const { currentId } = useCompany();
  const fmtMoney = useMoneyFmt();

  const [form, setForm] = useState(makeBlank());
  const [savedPhase, setSavedPhase] = useState(initial || null);
  const [saving, setSaving] = useState(false);
  const [availDocs, setAvailDocs] = useState([]); // {id, kind, number, total, date, contact_name}
  const [availLoading, setAvailLoading] = useState(false);
  const [linking, setLinking] = useState(null); // key of the doc being linked

  useEffect(() => {
    if (!open) return;
    setForm(initial ? {
      name: initial.name || "",
      notes: initial.notes || "",
      start_date: initial.start_date || "",
      end_date: initial.end_date || "",
      estimated_revenue: initial.estimated_revenue ?? "",
      estimated_cost: initial.estimated_cost ?? "",
      status: initial.status || "in_progress",
    } : makeBlank());
    setSavedPhase(initial || null);
    setSaving(false);
    setLinking(null);
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, saving, onClose]);

  // Load available (unlinked or linked-to-a-different-phase) docs for
  // the project's customer/vendor so the PM can attach existing work.
  const loadAvailDocs = async () => {
    if (!currentId || !projectId) return;
    setAvailLoading(true);
    try {
      // Fetch all customer + vendor docs for the company, then filter
      // client-side to (a) same customer as this project OR any vendor
      // and (b) not already tagged to THIS phase.
      const [inv, est, bl] = await Promise.all([
        api.get(`/companies/${currentId}/invoices?limit=200`),
        api.get(`/companies/${currentId}/estimates?limit=200`),
        api.get(`/companies/${currentId}/bills?limit=200`),
      ]);
      const rows = [];
      const meId = savedPhase?.id;
      const pushRow = (arr, kind, dateField) => {
        for (const d of (arr || [])) {
          if (d.phase_id && meId && d.phase_id === meId) continue;
          // Only surface docs already tagged to this project OR
          // untagged docs for the project's customer.
          if (d.project_id && d.project_id !== projectId) continue;
          if (kind !== "bill" && contactId && d.contact_id && d.contact_id !== contactId) continue;
          rows.push({
            id: d.id, kind,
            number: d.number,
            total: Number(d.total || 0),
            date: d[dateField],
            contact_name: d.contact_name,
            phase_id: d.phase_id,
            project_id: d.project_id,
          });
        }
      };
      pushRow(inv.data?.invoices, "invoice", "issue_date");
      pushRow(est.data?.estimates, "estimate", "issue_date");
      pushRow(bl.data?.bills, "bill", "issue_date");
      rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      setAvailDocs(rows);
    } catch {
      setAvailDocs([]);
    } finally { setAvailLoading(false); }
  };
  useEffect(() => {
    if (!open || !savedPhase) return;
    loadAvailDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, savedPhase?.id, projectId]);

  if (!open) return null;

  const canSubmit = !!form.name.trim() && !saving;
  const dateInvalid = form.start_date && form.end_date && form.end_date < form.start_date;

  const submit = async () => {
    if (!canSubmit || dateInvalid) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        notes: form.notes.trim(),
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        estimated_revenue: form.estimated_revenue === ""
          ? null : Number(form.estimated_revenue),
        estimated_cost: form.estimated_cost === ""
          ? null : Number(form.estimated_cost),
        status: form.status,
      };
      const phase = await onSubmit(payload);
      if (phase) setSavedPhase(phase);
    } finally { setSaving(false); }
  };

  const linkDoc = async (doc) => {
    if (!savedPhase?.id) return;
    setLinking(`${doc.kind}-${doc.id}`);
    try {
      const routeMap = { invoice: "invoices", estimate: "estimates", bill: "bills" };
      await api.patch(
        `/companies/${currentId}/${routeMap[doc.kind]}/${doc.id}`,
        { phase_id: savedPhase.id, project_id: projectId });
      await loadAvailDocs();
      onLinkedDocsChanged?.();
    } catch {
      // Toast handled by parent — silent here.
    } finally { setLinking(null); }
  };

  const openDrawerForKind = (kind) => {
    if (!savedPhase?.id) return;
    // Parent opens its DocDrawer with { kind, phaseId }. Close this
    // modal so the drawer isn't rendered behind another overlay.
    onClose();
    onOpenDocDrawer?.(kind, savedPhase);
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4"
          role="dialog" aria-modal="true"
          data-testid="phase-form-modal">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[1px]"
            onClick={() => !saving && onClose()} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col">
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-cyan-50 text-cyan-600 flex items-center justify-center">
              <Layers size={15} />
            </div>
            <div>
              <div className="font-heading font-semibold text-slate-900">
                {savedPhase ? `Edit phase — ${savedPhase.name}` : "New phase"}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500">
                Demo · Framing · Rough-In · Finishes · Close-out
              </div>
            </div>
          </div>
          <button onClick={() => !saving && onClose()}
                  className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
                  data-testid="phase-form-close">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Basics */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phase name" required className="col-span-2">
              <input value={form.name}
                      onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="Framing" autoFocus
                      data-testid="phase-form-name"
                      className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500" />
            </Field>
            <Field label="Start date">
              <input type="date" value={form.start_date}
                      onChange={(e) => setForm(f => ({ ...f, start_date: e.target.value }))}
                      data-testid="phase-form-start"
                      className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500" />
            </Field>
            <Field label="End date">
              <input type="date" value={form.end_date}
                      onChange={(e) => setForm(f => ({ ...f, end_date: e.target.value }))}
                      data-testid="phase-form-end"
                      className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500 ${dateInvalid ? "border-rose-400" : "border-slate-300"}`} />
            </Field>
            {dateInvalid && (
              <div className="col-span-2 text-[11px] text-rose-600 -mt-2">End date is before start date.</div>
            )}
            <Field label="Estimated revenue">
              <MoneyInput value={form.estimated_revenue}
                            onChange={(v) => setForm(f => ({ ...f, estimated_revenue: v }))}
                            data-testid="phase-form-est-rev" />
            </Field>
            <Field label="Estimated cost">
              <MoneyInput value={form.estimated_cost}
                            onChange={(v) => setForm(f => ({ ...f, estimated_cost: v }))}
                            data-testid="phase-form-est-cost" />
            </Field>
            <Field label="Notes" className="col-span-2">
              <textarea value={form.notes}
                          onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
                          rows={2}
                          placeholder="Sub crews, materials list, key milestones — anything worth remembering."
                          data-testid="phase-form-notes"
                          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500 resize-y" />
            </Field>
          </div>

          {/* Docs linking — hidden until the phase has been saved once
              (we need an id before we can PATCH docs). Nudge the user
              with a friendly hint when in create-mode. */}
          <div className="border-t pt-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold text-slate-700 uppercase tracking-wider flex items-center gap-1">
                <Link2 size={12} className="text-slate-500" /> Linked documents
              </div>
              {savedPhase && (
                <div className="flex gap-1.5">
                  <button onClick={() => openDrawerForKind("estimate")}
                            data-testid="phase-form-new-estimate"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-amber-200 bg-amber-50 text-amber-700 text-[11px] hover:bg-amber-100">
                    <Plus size={10} /> Estimate
                  </button>
                  <button onClick={() => openDrawerForKind("invoice")}
                            data-testid="phase-form-new-invoice"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-indigo-200 bg-indigo-50 text-indigo-700 text-[11px] hover:bg-indigo-100">
                    <Plus size={10} /> Invoice
                  </button>
                  <button onClick={() => openDrawerForKind("bill")}
                            data-testid="phase-form-new-bill"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-rose-200 bg-rose-50 text-rose-700 text-[11px] hover:bg-rose-100">
                    <Plus size={10} /> Bill
                  </button>
                </div>
              )}
            </div>
            {!savedPhase ? (
              <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-3 text-center text-xs text-slate-500">
                Save the phase first, then link existing estimates / invoices / bills or create new ones tagged to this phase.
              </div>
            ) : (
              <>
                <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Link existing</div>
                {availLoading ? (
                  <div className="text-xs text-slate-500 py-3 text-center"><Loader2 size={12} className="inline animate-spin mr-1" /> Loading…</div>
                ) : availDocs.length === 0 ? (
                  <div className="text-[11px] italic text-slate-400 py-2 text-center">
                    No unlinked docs for this customer.
                  </div>
                ) : (
                  <div className="rounded-lg border max-h-52 overflow-y-auto">
                    <ul className="divide-y divide-slate-100">
                      {availDocs.map(d => {
                        const kc = KIND_CHIP[d.kind] || KIND_CHIP.default;
                        return (
                        <li key={`${d.kind}-${d.id}`}
                            className="px-3 py-1.5 grid grid-cols-12 gap-2 items-center text-xs hover:bg-slate-50"
                            data-testid={`phase-avail-${d.kind}-${d.id}`}>
                          <span className={`col-span-2 inline-flex justify-center text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${kc}`}>
                            {d.kind}
                          </span>
                          <span className="col-span-2 font-mono-num text-slate-800">{d.number || "—"}</span>
                          <span className="col-span-3 text-slate-500 truncate">{d.contact_name || "—"}</span>
                          <span className="col-span-2 text-slate-500">{d.date || "—"}</span>
                          <span className="col-span-2 text-right font-mono-num text-slate-800">{fmtMoney(d.total)}</span>
                          <button onClick={() => linkDoc(d)}
                                    disabled={linking === `${d.kind}-${d.id}`}
                                    data-testid={`phase-link-${d.kind}-${d.id}`}
                                    className="col-span-1 inline-flex items-center justify-center px-1.5 py-1 rounded bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50">
                            {linking === `${d.kind}-${d.id}` ? <Loader2 size={11} className="animate-spin" /> : <ArrowRight size={11} />}
                          </button>
                        </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t bg-slate-50 flex justify-end gap-2">
          <button onClick={() => !saving && onClose()}
                    disabled={saving}
                    className="text-sm px-3 py-2 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-100">
            {savedPhase ? "Done" : "Cancel"}
          </button>
          {!savedPhase && (
            <button onClick={submit}
                      disabled={!canSubmit || dateInvalid}
                      data-testid="phase-form-submit"
                      className="text-sm px-4 py-2 rounded-md bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50 inline-flex items-center gap-1.5">
              {saving ? <Loader2 size={13} className="animate-spin" /> : null}
              Create phase
            </button>
          )}
          {savedPhase && (
            <button onClick={submit}
                      disabled={!canSubmit || dateInvalid}
                      data-testid="phase-form-save-changes"
                      className="text-sm px-4 py-2 rounded-md bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50 inline-flex items-center gap-1.5">
              {saving ? <Loader2 size={13} className="animate-spin" /> : null}
              Save changes
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, required, className = "", children }) {
  return (
    <div className={className}>
      <label className="text-[11px] uppercase tracking-wider text-slate-500 block mb-1">
        {label} {required && <span className="text-rose-500">*</span>}
      </label>
      {children}
    </div>
  );
}

function MoneyInput({ value, onChange, ...rest }) {
  return (
    <div className="relative">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
      <input type="number" step="0.01" value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="0.00"
              className="w-full border border-slate-300 rounded-md pl-6 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500"
              {...rest} />
    </div>
  );
}

function kindColor(kind) {
  return kind === "invoice" ? "indigo"
        : kind === "estimate" ? "amber"
        : kind === "bill" ? "rose"
        : "slate";
}

// Static Tailwind class map — dynamic template strings get purged by
// the JIT compiler, so we spell each variant out here.
const KIND_CHIP = {
  invoice:  "bg-indigo-50 text-indigo-700 border-indigo-200",
  estimate: "bg-amber-50 text-amber-700 border-amber-200",
  bill:     "bg-rose-50 text-rose-700 border-rose-200",
  default:  "bg-slate-50 text-slate-700 border-slate-200",
};

function makeBlank() {
  return {
    name: "", notes: "", start_date: "", end_date: "",
    estimated_revenue: "", estimated_cost: "", status: "in_progress",
  };
}
