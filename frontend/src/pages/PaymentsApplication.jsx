/**
 * PaymentsApplication — "Get Paid Faster" intake wizard.
 *
 * Sits between /welcome (housekeeping toggles) and /welcome/summary
 * ("Great News"). The user first chooses whether they want to enable
 * electronic invoicing / ACH; if Yes, we surface the full KYC form.
 * Fields autosave to the backend every 1s (debounced) so the client
 * can bail out with "Save & continue later" and resume from the
 * sidebar/cockpit resume cards without losing data.
 *
 * Sensitive fields (Federal Tax ID, per-owner SSN, DOB, Home
 * Address, Home Phone) are encrypted server-side; the frontend
 * treats them as plain strings and lets the backend handle the
 * ciphering (see routes/payments_app.py).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  Sparkles, Plus, Trash2, AlertTriangle, ShieldCheck, ArrowRight, Loader2, Upload, Check, X,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

const SENSITIVE_HINT = "Encrypted at rest";

// Shape of a single empty owner row.
const EMPTY_OWNER = {
  legal_name: "", ownership_pct: "", home_address: "", home_phone: "",
  signer_email: "", dob: "", ssn: "",
};

// Encode a File as a base64 data URL for the MVP inline-attachment
// store. Swap to Emergent Object Storage in follow-up.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, mime: file.type, data_b64: r.result });
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// One text input + label bundle. `sensitive` shows a small lock hint.
function Field({ label, value, onChange, required, type = "text", sensitive, placeholder, testid, className = "" }) {
  return (
    <label className={`block ${className}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">
        <span>{label}{required ? " *" : ""}</span>
        {sensitive && (
          <span className="inline-flex items-center gap-0.5 text-[9px] font-normal normal-case text-emerald-600" title={SENSITIVE_HINT}>
            <ShieldCheck size={9} /> Encrypted
          </span>
        )}
      </div>
      <input
        type={type}
        value={value ?? ""}
        placeholder={placeholder || ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-slate-500 focus:ring-1 focus:ring-slate-500 outline-none"
        data-testid={testid}
      />
    </label>
  );
}

function Upl({ label, value, onUpload, onRemove, required, testid }) {
  const [busy, setBusy] = useState(false);
  const handle = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const enc = await fileToBase64(f);
      onUpload(enc);
    } finally {
      setBusy(false);
      // Reset the input so re-uploading the same file re-fires onChange.
      e.target.value = "";
    }
  };
  return (
    <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded bg-white border border-slate-200 flex items-center justify-center shrink-0">
          {value ? <Check size={14} className="text-emerald-600" /> : <Upload size={14} className="text-slate-400" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-slate-800">{label}{required ? " *" : ""}</div>
          <div className="text-[11px] text-slate-500 truncate">{value?.name || "PDF, JPG, or PNG"}</div>
        </div>
        <label className="text-[11px] px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 cursor-pointer inline-flex items-center gap-1" data-testid={`${testid}-btn`}>
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
          {value ? "Replace" : "Upload"}
          <input type="file" className="hidden" onChange={handle} accept="image/*,application/pdf" data-testid={testid} />
        </label>
        {value && onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-slate-400 hover:text-red-600 p-1"
            title="Remove file"
            data-testid={`${testid}-remove`}
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * UplMulti — same visual language as `Upl` but manages a list. The
 * top-level row is the always-visible "Add another" affordance; each
 * uploaded file renders as its own row underneath with its own
 * remove-X. Value is always an array (`[]` when empty).
 */
function UplMulti({ label, value, onChange, required, testid }) {
  const [busy, setBusy] = useState(false);
  const items = Array.isArray(value) ? value : [];
  const handle = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setBusy(true);
    try {
      const encoded = await Promise.all(files.map(fileToBase64));
      onChange([...items, ...encoded]);
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  };
  const removeAt = (idx) => onChange(items.filter((_, i) => i !== idx));
  return (
    <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 space-y-2">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded bg-white border border-slate-200 flex items-center justify-center shrink-0">
          {items.length > 0 ? <Check size={14} className="text-emerald-600" /> : <Upload size={14} className="text-slate-400" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-slate-800">{label}{required ? " *" : ""}</div>
          <div className="text-[11px] text-slate-500">
            {items.length === 0 ? "PDF, JPG, or PNG · you can add multiple" : `${items.length} file${items.length === 1 ? "" : "s"} added`}
          </div>
        </div>
        <label className="text-[11px] px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 cursor-pointer inline-flex items-center gap-1" data-testid={`${testid}-btn`}>
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
          {items.length > 0 ? "Add another" : "Upload"}
          <input type="file" multiple className="hidden" onChange={handle} accept="image/*,application/pdf" data-testid={testid} />
        </label>
      </div>
      {items.length > 0 && (
        <ul className="pl-11 space-y-1" data-testid={`${testid}-list`}>
          {items.map((it, idx) => (
            <li
              key={idx}
              className="flex items-center gap-2 text-[12px] text-slate-700 bg-white border border-slate-200 rounded px-2 py-1"
              data-testid={`${testid}-item-${idx}`}
            >
              <Check size={11} className="text-emerald-600 shrink-0" />
              <span className="truncate flex-1">{it.name}</span>
              <button
                type="button"
                onClick={() => removeAt(idx)}
                className="text-slate-400 hover:text-red-600"
                title="Remove"
                data-testid={`${testid}-remove-${idx}`}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function PaymentsApplication() {
  const nav = useNavigate();
  const { current, currentId } = useCompany();
  const [wantsIt, setWantsIt] = useState(null); // null | true | false
  const [app, setApp] = useState({ business: {}, owners: [], attachments: {} });
  const [status, setStatus] = useState({ pct: 0, ownership_pct: 0 });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const saveT = useRef(null);
  const dirty = useRef(false);

  // Load draft (if any) once we have a company id.
  useEffect(() => {
    if (!currentId) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(`/companies/${currentId}/payments-app`);
        if (cancelled) return;
        const d = r.data || {};
        setApp({
          business: d.business || {},
          owners: d.owners || [],
          attachments: d.attachments || {},
        });
        setStatus(d.completion || { pct: 0, ownership_pct: 0 });
        // Auto-open the form when there's already meaningful progress.
        if ((d.business && Object.keys(d.business).length) || (d.owners || []).length) {
          setWantsIt(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentId]);

  // Debounced autosave whenever the editable payload changes.
  useEffect(() => {
    if (!currentId || !wantsIt) return;
    if (!dirty.current) return;
    if (saveT.current) clearTimeout(saveT.current);
    saveT.current = setTimeout(async () => {
      try {
        const r = await api.patch(`/companies/${currentId}/payments-app`, app);
        setStatus(r.data?.completion || status);
      } catch (e) { /* silent on autosave */ }
    }, 1000);
    return () => saveT.current && clearTimeout(saveT.current);
  }, [app, currentId, wantsIt]);   // eslint-disable-line react-hooks/exhaustive-deps

  const setBiz = (k, v) => { dirty.current = true; setApp(cur => ({ ...cur, business: { ...cur.business, [k]: v } })); };
  const setOwner = (i, k, v) => {
    dirty.current = true;
    setApp(cur => {
      const owners = cur.owners.map((o, idx) => idx === i ? { ...o, [k]: v } : o);
      return { ...cur, owners };
    });
  };
  const addOwner = () => { dirty.current = true; setApp(cur => ({ ...cur, owners: [...cur.owners, { ...EMPTY_OWNER }] })); };
  const removeOwner = (i) => { dirty.current = true; setApp(cur => ({ ...cur, owners: cur.owners.filter((_, idx) => idx !== i) })); };
  const setAttachment = (k, v) => { dirty.current = true; setApp(cur => ({ ...cur, attachments: { ...cur.attachments, [k]: v } })); };

  const ownershipTotal = useMemo(() =>
    (app.owners || []).reduce((s, o) => s + (parseFloat(o.ownership_pct) || 0), 0),
  [app.owners]);
  const ownershipBelow80 = ownershipTotal < 80;

  const saveAndExit = () => { toast.success("Progress saved. Come back from the sidebar anytime."); nav("/welcome/summary"); };
  const skipEntirely = () => nav("/welcome/summary");

  const submitAll = async () => {
    setSubmitting(true);
    try {
      // Force a final autosave first so nothing debouncy is lost.
      await api.patch(`/companies/${currentId}/payments-app`, app);
      await api.post(`/companies/${currentId}/payments-app/submit`);
      toast.success("Payments application submitted!");
      nav("/welcome/summary");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't submit — check the highlighted fields.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-white flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-white p-6 pt-14">
      <div className="max-w-3xl mx-auto" data-testid="payments-app-page">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-blue-500 flex items-center justify-center">
            <Sparkles size={16} className="text-white" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Onboarding · Payments</div>
            <div className="text-2xl font-bold text-slate-900 leading-tight">Get Paid Faster</div>
          </div>
        </div>

        {/* Intro / Yes-No */}
        {wantsIt === null && (
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4" data-testid="payments-app-intro">
            <p className="text-slate-800 leading-relaxed">
              Want to enable <b>electronic invoicing</b> and <b>ACH pulls</b> for <b>{current?.name || "your company"}</b>? You'll get paid faster (usually 2–3 days vs 30+), skip check-chasing, and give your customers a one-click "Pay now" button.
            </p>
            <p className="text-slate-600 text-sm">
              It takes about 10 minutes and you can save your progress and finish later from the sidebar. All sensitive fields are encrypted at rest.
            </p>
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => setWantsIt(true)}
                className="px-4 py-2 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow inline-flex items-center gap-2"
                data-testid="payments-app-yes"
              >
                <Check size={14} /> Yes, let's do it
              </button>
              <button
                type="button"
                onClick={skipEntirely}
                className="text-sm text-slate-500 hover:text-slate-900"
                data-testid="payments-app-no"
              >
                Not right now
              </button>
            </div>
          </div>
        )}

        {wantsIt === true && (
          <>
            {/* Business */}
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm mb-4" data-testid="payments-app-business">
              <div className="font-semibold text-slate-900 mb-3">Business info</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Legal name" required value={app.business.legal_name} onChange={v => setBiz("legal_name", v)} testid="biz-legal-name" />
                <Field label="Federal Tax ID (EIN)" required sensitive value={app.business.federal_tax_id} onChange={v => setBiz("federal_tax_id", v)} testid="biz-ein" placeholder="XX-XXXXXXX" />
                <Field label="Doing business as (DBA)" value={app.business.dba} onChange={v => setBiz("dba", v)} testid="biz-dba" />
                <Field label="Business start date" required type="date" value={app.business.start_date} onChange={v => setBiz("start_date", v)} testid="biz-start" />
                <Field label="Business address" required value={app.business.address} onChange={v => setBiz("address", v)} className="sm:col-span-2" testid="biz-addr" />
                <Field label="Business phone" required value={app.business.phone} onChange={v => setBiz("phone", v)} testid="biz-phone" />
                <Field label="Website" value={app.business.website} onChange={v => setBiz("website", v)} testid="biz-web" />
                <Field label="Contact name" required value={app.business.contact_name} onChange={v => setBiz("contact_name", v)} testid="biz-contact" />
                <Field label="Contact email" required type="email" value={app.business.contact_email} onChange={v => setBiz("contact_email", v)} testid="biz-email" />
                <Field label="Product / service sold" required value={app.business.product_sold} onChange={v => setBiz("product_sold", v)} className="sm:col-span-2" testid="biz-product" />
                <Field label="Avg transaction / invoice size ($)" required type="number" value={app.business.avg_txn_size} onChange={v => setBiz("avg_txn_size", v)} testid="biz-avg-txn" />
                <Field label="Avg monthly volume ($)" required type="number" value={app.business.avg_monthly_volume} onChange={v => setBiz("avg_monthly_volume", v)} testid="biz-avg-vol" />
              </div>
            </section>

            {/* Owners / signers */}
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm mb-4" data-testid="payments-app-owners">
              <div className="flex items-center justify-between mb-3">
                <div className="font-semibold text-slate-900">Signer(s) — beneficial owners</div>
                <button
                  type="button"
                  onClick={addOwner}
                  className="text-[12px] px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50 inline-flex items-center gap-1"
                  data-testid="payments-app-add-owner"
                >
                  <Plus size={11} /> Add owner
                </button>
              </div>

              {app.owners.length === 0 && (
                <div className="text-[13px] text-slate-500 italic mb-3">Add at least one signer. If a single owner isn't ≥ 80%, you'll need to add more.</div>
              )}

              {app.owners.map((o, i) => (
                <div key={i} className="rounded-md border border-slate-200 p-3 mb-3 bg-slate-50/40" data-testid={`payments-app-owner-${i}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[11px] uppercase tracking-widest text-slate-500 font-semibold">Signer #{i + 1}</div>
                    <button
                      type="button"
                      onClick={() => removeOwner(i)}
                      className="text-slate-400 hover:text-red-600"
                      data-testid={`payments-app-owner-${i}-remove`}
                    ><Trash2 size={13} /></button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="Legal name" required value={o.legal_name} onChange={v => setOwner(i, "legal_name", v)} testid={`owner-${i}-name`} />
                    <Field label="% ownership" required type="number" value={o.ownership_pct} onChange={v => setOwner(i, "ownership_pct", v)} testid={`owner-${i}-pct`} placeholder="0–100" />
                    <Field label="Home address" required sensitive value={o.home_address} onChange={v => setOwner(i, "home_address", v)} className="sm:col-span-2" testid={`owner-${i}-addr`} />
                    <Field label="Home / cell phone" required sensitive value={o.home_phone} onChange={v => setOwner(i, "home_phone", v)} testid={`owner-${i}-phone`} />
                    <Field label="Signer email" required type="email" value={o.signer_email} onChange={v => setOwner(i, "signer_email", v)} testid={`owner-${i}-email`} />
                    <Field label="Date of birth" required sensitive type="date" value={o.dob} onChange={v => setOwner(i, "dob", v)} testid={`owner-${i}-dob`} />
                    <Field label="SSN" required sensitive value={o.ssn} onChange={v => setOwner(i, "ssn", v)} testid={`owner-${i}-ssn`} placeholder="XXX-XX-XXXX" />
                  </div>
                </div>
              ))}

              {/* Ownership rollup */}
              <div className={`rounded-md px-3 py-2 flex items-start gap-2 text-[13px] ${
                ownershipBelow80
                  ? "bg-amber-50 border border-amber-200 text-amber-800"
                  : "bg-emerald-50 border border-emerald-200 text-emerald-800"
              }`} data-testid="payments-app-ownership-banner">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <div>
                  <b>Combined ownership: {ownershipTotal.toFixed(0)}%.</b>{" "}
                  {ownershipBelow80
                    ? "Federal KYC needs at least 80% of the company represented — please add another beneficial owner before you can submit."
                    : "Great — you've represented enough of the business to satisfy KYC."}
                </div>
              </div>
            </section>

            {/* Uploads */}
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm mb-6" data-testid="payments-app-uploads">
              <div className="font-semibold text-slate-900 mb-3">Uploads</div>
              <div className="space-y-3">
                <Upl
                  label="Voided check"
                  required
                  value={app.attachments.voided_check}
                  onUpload={(v) => setAttachment("voided_check", v)}
                  onRemove={() => setAttachment("voided_check", null)}
                  testid="upl-check"
                />
                <Upl
                  label="Signer ID / license"
                  required
                  value={app.attachments.signer_id}
                  onUpload={(v) => setAttachment("signer_id", v)}
                  onRemove={() => setAttachment("signer_id", null)}
                  testid="upl-id"
                />
                <UplMulti
                  label="Last 3 months of processing statements (optional)"
                  value={app.attachments.processing_stmts}
                  onChange={(v) => setAttachment("processing_stmts", v)}
                  testid="upl-processing"
                />
                <UplMulti
                  label="Last 2 months of business bank statements (if ACH)"
                  value={app.attachments.bank_stmts}
                  onChange={(v) => setAttachment("bank_stmts", v)}
                  testid="upl-bank"
                />
              </div>
            </section>

            {/* Footer */}
            <div className="flex flex-wrap items-center gap-3 justify-between">
              <div className="text-[12px] text-slate-500 inline-flex items-center gap-2" data-testid="payments-app-progress">
                <span className="inline-block w-40 h-1.5 bg-slate-200 rounded overflow-hidden">
                  <span className="block h-full bg-emerald-500 transition-all" style={{ width: `${status.pct || 0}%` }} />
                </span>
                <span>{(status.pct || 0).toFixed(0)}% complete</span>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={saveAndExit}
                  className="text-sm text-slate-600 hover:text-slate-900 px-3 py-2"
                  data-testid="payments-app-save-later"
                >
                  Save & continue later
                </button>
                <button
                  type="button"
                  onClick={submitAll}
                  disabled={submitting || ownershipBelow80}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="payments-app-submit"
                >
                  {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
                  Submit application <ArrowRight size={14} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
