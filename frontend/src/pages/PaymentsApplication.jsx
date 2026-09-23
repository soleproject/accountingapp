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
  Zap, Clock, CreditCard, TrendingUp, CheckCircle2, DollarSign, MousePointerClick,
  MessageSquareWarning,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { InfoRequestResponseCard } from "@/components/InfoRequestResponseCard";

const SENSITIVE_HINT = "Encrypted at rest";

// Shape of a single empty owner row.
const EMPTY_OWNER = {
  legal_name: "", ownership_pct: "", home_address: "", home_phone: "",
  signer_email: "", dob: "", ssn: "",
};

// Client-side mirror of the backend's required-field list (routes/payments_app.py).
// Kept in sync manually — if the backend list changes, update this too so the
// wizard's per-step gating stays truthful.
const BIZ_REQUIRED = [
  "legal_name", "federal_tax_id", "start_date", "address", "phone",
  "contact_name", "contact_email", "product_sold",
  "avg_txn_size", "avg_monthly_volume",
];
const OWNER_REQUIRED = [
  "legal_name", "ownership_pct", "home_address", "home_phone",
  "signer_email", "dob", "ssn",
];
const STEPS = [
  { n: 1, title: "Business" },
  { n: 2, title: "Signers" },
  { n: 3, title: "Uploads" },
];

/**
 * Upload a File to Emergent Object Storage via the backend proxy.
 * Returns the reference the payments_app doc stores in place of the
 * old base64 blob: `{id, name, mime, size, storage_path}`. Storage
 * failures surface as toast'd 503s upstream.
 */
async function uploadFile(companyId, file) {
  const fd = new FormData();
  fd.append("file", file);
  const r = await api.post(
    `/companies/${companyId}/payments-app/upload`,
    fd,
    { headers: { "Content-Type": "multipart/form-data" } },
  );
  return r.data;
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

function Upl({ label, value, onUpload, onRemove, required, testid, companyId }) {
  const [busy, setBusy] = useState(false);
  const handle = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const ref = await uploadFile(companyId, f);
      onUpload(ref);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Upload failed — try again?");
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  };
  const remove = async () => {
    // Fire-and-forget soft delete server-side; failures don't block
    // the UI cleanup — worst case we leave one orphan storage record.
    if (value?.id && companyId) {
      api.delete(`/companies/${companyId}/payments-app/files/${value.id}`).catch(() => {});
    }
    onRemove?.();
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
            onClick={remove}
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
 * UplMulti — same visual language as `Upl` but manages a list.
 * Value is always an array of `{id, name, mime, size, storage_path}`.
 */
function UplMulti({ label, value, onChange, required, testid, companyId }) {
  const [busy, setBusy] = useState(false);
  const items = Array.isArray(value) ? value : [];
  const handle = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setBusy(true);
    try {
      const uploaded = [];
      for (const f of files) {
        try { uploaded.push(await uploadFile(companyId, f)); }
        catch (err) {
          toast.error(err?.response?.data?.detail || `Couldn't upload ${f.name}`);
        }
      }
      if (uploaded.length) onChange([...items, ...uploaded]);
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  };
  const removeAt = (idx) => {
    const it = items[idx];
    if (it?.id && companyId) {
      api.delete(`/companies/${companyId}/payments-app/files/${it.id}`).catch(() => {});
    }
    onChange(items.filter((_, i) => i !== idx));
  };
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
  // `docStatus` mirrors payments_applications.status so we can branch
  // the intro screen between: fresh (no draft), welcome-back (draft),
  // in-review (submitted), approved, and declined.
  const [docStatus, setDocStatus] = useState("draft");
  const [hasSavedDraft, setHasSavedDraft] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [infoRequestNote, setInfoRequestNote] = useState("");
  // Full info_requests[] history — used to identify the newest open
  // request so the response card knows exactly what's being asked.
  const [infoRequests, setInfoRequests] = useState([]);
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
        const saved = !!(d.updated_at || d.created_at || d.submitted_at);
        setHasSavedDraft(saved);
        setDocStatus(d.status || "draft");
        setDeclineReason(d.decline_reason || "");
        setInfoRequestNote(d.info_request_note || "");
        setInfoRequests(Array.isArray(d.info_requests) ? d.info_requests : []);
        // We NO LONGER auto-open the wizard on load. The intro screen
        // branches on `docStatus` (approved / submitted / declined /
        // draft) so returning users see a "Welcome back" hero with a
        // progress bar and Continue CTA instead of being dropped
        // silently into the form. They flip `wantsIt` themselves.
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

  // Wizard step (1..3). Auto-advance a returning user to the first
  // incomplete step so drafts pick up where they left off.
  const [step, setStep] = useState(1);

  // Per-step validity — mirrors backend `_completion` so the Submit
  // button only lights up when the server will actually accept it.
  const isFilled = (v) => v !== null && v !== undefined && String(v).trim() !== "";
  const step1Valid = useMemo(
    () => BIZ_REQUIRED.every((k) => isFilled(app.business?.[k])),
    [app.business],
  );
  const step2Valid = useMemo(() => {
    const owners = app.owners || [];
    if (!owners.length) return false;
    if (ownershipTotal < 80) return false;
    return owners.every((o) => OWNER_REQUIRED.every((k) => isFilled(o?.[k])));
  }, [app.owners, ownershipTotal]);
  const step3Valid = useMemo(
    () => !!app.attachments?.voided_check && !!app.attachments?.signer_id,
    [app.attachments],
  );
  const allValid = step1Valid && step2Valid && step3Valid;

  // Auto-jump to the first incomplete step on first load of a resumed draft.
  const jumpedRef = useRef(false);
  useEffect(() => {
    if (loading || wantsIt !== true || jumpedRef.current) return;
    jumpedRef.current = true;
    if (!step1Valid) setStep(1);
    else if (!step2Valid) setStep(2);
    else setStep(3);
  }, [loading, wantsIt, step1Valid, step2Valid]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Seed a blank Signer #1 card the first time the user lands on
  // step 2 with no owners saved yet. Removes the "Add owner" click
  // friction — the form is right there ready to fill, and "Add owner"
  // is still available for co-owners / partners.
  const seededSignerRef = useRef(false);
  useEffect(() => {
    if (loading || wantsIt !== true || seededSignerRef.current) return;
    if (step !== 2) return;
    if ((app.owners || []).length > 0) { seededSignerRef.current = true; return; }
    seededSignerRef.current = true;
    addOwner();
  }, [step, loading, wantsIt, app.owners]);   // eslint-disable-line react-hooks/exhaustive-deps

  const goNext = () => {
    // Non-blocking advance: users can browse ahead to see what else
    // the application will ask for. A friendly toast surfaces what's
    // still missing on this step; the Submit button (step 3) remains
    // fully gated on `allValid`, so the server never receives a
    // half-baked application.
    if (step === 1 && !step1Valid) {
      toast.info("Missing fields on Business — you can come back. Submit stays locked until everything's filled in.");
    } else if (step === 2 && !step2Valid) {
      const msg = (app.owners || []).length === 0
        ? "No signers added yet — you can come back to add them."
        : ownershipBelow80
          ? "Combined ownership is under 80% — you can come back to fix this."
          : "Some signer fields are still empty — you can come back to fill them.";
      toast.info(msg);
    }
    setStep((s) => Math.min(3, s + 1));
  };
  const goBack = () => setStep((s) => Math.max(1, s - 1));

  const saveAndExit = () => { toast.success("Progress saved. Come back from the sidebar anytime."); nav("/welcome/summary"); };
  const skipEntirely = () => nav("/welcome/summary");

  // Nuke a draft-in-progress so the user can start fresh from the
  // marketing intro. Guarded by a browser confirm — accidental clicks
  // here delete real progress.
  const startOver = async () => {
    if (!currentId) return;
    const ok = window.confirm(
      "Start over? Your current draft and any uploaded documents will be permanently discarded.",
    );
    if (!ok) return;
    try {
      await api.delete(`/companies/${currentId}/payments-app/draft`);
      // Reset UI to the fresh-visitor state.
      setApp({ business: { legal_name: current?.name || "" }, owners: [], attachments: {} });
      setStatus({ pct: 0, ownership_pct: 0 });
      setDocStatus("draft");
      setHasSavedDraft(false);
      setDeclineReason("");
      setWantsIt(null);
      toast.success("Draft discarded — you can start fresh.");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't discard draft.");
    }
  };

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
          <div data-testid="payments-app-intro">
            {/* Approved — nothing more to do. Payments are already live. */}
            {docStatus === "approved" && (
              <div className="rounded-3xl bg-gradient-to-br from-emerald-500 via-emerald-500 to-teal-600 text-white p-8 sm:p-10 shadow-xl relative overflow-hidden" data-testid="payments-app-approved-card">
                <div className="pointer-events-none absolute -top-16 -right-16 w-64 h-64 rounded-full bg-white/10 blur-3xl" />
                <div className="inline-flex items-center gap-1.5 rounded-full bg-white/15 backdrop-blur-sm px-2.5 py-1 text-[10px] uppercase tracking-widest font-semibold">
                  <CheckCircle2 size={11} /> You're live
                </div>
                <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold leading-tight tracking-tight">
                  Payments are enabled for<br />
                  <span className="text-emerald-100">{current?.name || "your business"}.</span>
                </h1>
                <p className="mt-3 text-emerald-50/95 text-[15px] leading-relaxed max-w-md">
                  Every invoice you send now includes a Pay Now link. Money settles in 2–3 business days
                  and posts to your books automatically.
                </p>
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => nav("/invoices")}
                    className="group inline-flex items-center gap-2 px-6 py-3 rounded-full bg-white text-emerald-700 font-bold shadow-lg hover:shadow-xl hover:scale-[1.02] transition-transform"
                    data-testid="payments-app-goto-invoices"
                  >
                    Go to Invoices <ArrowRight size={16} className="group-hover:translate-x-0.5 transition-transform" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setWantsIt(true)}
                    className="text-[13px] text-white/85 hover:text-white underline underline-offset-4"
                    data-testid="payments-app-view-details"
                  >
                    View application details
                  </button>
                </div>
              </div>
            )}

            {/* Submitted — waiting on the underwriter. Read-only status. */}
            {docStatus === "submitted" && (
              <div className="rounded-3xl bg-gradient-to-br from-amber-500 via-orange-500 to-rose-500 text-white p-8 sm:p-10 shadow-xl relative overflow-hidden" data-testid="payments-app-submitted-card">
                <div className="pointer-events-none absolute -top-16 -right-16 w-64 h-64 rounded-full bg-white/10 blur-3xl" />
                <div className="inline-flex items-center gap-1.5 rounded-full bg-white/15 backdrop-blur-sm px-2.5 py-1 text-[10px] uppercase tracking-widest font-semibold">
                  <Clock size={11} /> Application under review
                </div>
                <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold leading-tight tracking-tight">
                  Thanks — your application is in.
                </h1>
                <p className="mt-3 text-amber-50/95 text-[15px] leading-relaxed max-w-md">
                  Our underwriter is reviewing your details right now. Most applications get approved
                  within a few hours. We'll email {app.business?.contact_email || "you"} the moment
                  you're live.
                </p>
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => nav("/dashboard")}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-white text-amber-700 font-semibold shadow"
                    data-testid="payments-app-back-to-dash"
                  >
                    Back to dashboard <ArrowRight size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setWantsIt(true)}
                    className="text-[13px] text-white/85 hover:text-white underline underline-offset-4"
                    data-testid="payments-app-view-details-submitted"
                  >
                    View my submitted details
                  </button>
                </div>
              </div>
            )}

            {/* Declined — reason + fix-and-resubmit CTA. */}
            {docStatus === "declined" && (
              <div className="rounded-3xl bg-white border border-rose-200 shadow-xl p-8 sm:p-10 relative overflow-hidden" data-testid="payments-app-declined-card">
                <div className="inline-flex items-center gap-1.5 rounded-full bg-rose-100 text-rose-700 px-2.5 py-1 text-[10px] uppercase tracking-widest font-semibold">
                  <AlertTriangle size={11} /> Needs another look
                </div>
                <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold leading-tight tracking-tight text-slate-900">
                  Your application wasn't approved as-is.
                </h1>
                {declineReason && (
                  <blockquote className="mt-4 border-l-4 border-rose-300 pl-4 py-2 text-slate-700 text-[14px] italic bg-rose-50/40 rounded-r">
                    {declineReason}
                  </blockquote>
                )}
                <p className="mt-3 text-slate-600 text-[14px] leading-relaxed max-w-md">
                  Update the flagged details and resubmit — the underwriter will re-review as soon
                  as you're done.
                </p>
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setWantsIt(true)}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow"
                    data-testid="payments-app-fix-resubmit"
                  >
                    Update & resubmit <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            )}

            {/* Waiting on client — inline response card. The client can
                upload files, write a reply, and send back all without
                opening the wizard. Full-wizard remains as an escape
                hatch for merchants who want to edit application fields. */}
            {docStatus === "waiting_on_client" && (() => {
              // Newest open info request in the history array. Falls
              // back to a synthesized entry from the legacy top-level
              // fields for apps that pre-date the array migration.
              const openReq = [...infoRequests].reverse().find((r) => !r.responded_at)
                || (infoRequestNote ? {
                    id: "legacy",
                    note: infoRequestNote,
                    response_type: "either",
                    requested_at: null,
                  } : null);
              if (!openReq) return null;
              return (
                <InfoRequestResponseCard
                  cid={currentId}
                  request={openReq}
                  onSent={() => window.location.reload()}
                  onOpenFullWizard={() => setWantsIt(true)}
                />
              );
            })()}


            {/* Welcome back — active draft. Progress bar + Continue CTA. */}
            {docStatus === "draft" && hasSavedDraft && (
              <div className="rounded-3xl bg-gradient-to-br from-slate-800 via-slate-900 to-emerald-900 text-white p-8 sm:p-10 shadow-xl relative overflow-hidden" data-testid="payments-app-welcome-back">
                <div className="pointer-events-none absolute -top-16 -right-16 w-64 h-64 rounded-full bg-emerald-400/10 blur-3xl" />
                <div className="pointer-events-none absolute -bottom-20 -left-10 w-72 h-72 rounded-full bg-emerald-300/10 blur-3xl" />
                <div className="relative">
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-white/10 backdrop-blur-sm px-2.5 py-1 text-[10px] uppercase tracking-widest font-semibold">
                    <ArrowRight size={11} /> Welcome back
                  </div>
                  <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold leading-tight tracking-tight">
                    Let's finish getting<br />
                    <span className="text-emerald-300">{current?.name || "your business"}</span> paid faster.
                  </h1>

                  {/* Progress bar */}
                  <div className="mt-5 max-w-md">
                    <div className="flex items-baseline justify-between mb-1.5">
                      <div className="text-[12px] uppercase tracking-widest text-emerald-200 font-semibold">
                        You're {Math.round(status.pct || 0)}% done
                      </div>
                      <div className="text-[11px] text-white/60">autosaved just now</div>
                    </div>
                    <div className="h-2.5 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-emerald-400 to-teal-300 transition-all"
                        style={{ width: `${Math.round(status.pct || 0)}%` }}
                      />
                    </div>
                    {/* Small summary of what they've captured so far —
                        reassures the user their work is safe. */}
                    <div className="mt-3 text-[12px] text-emerald-100/85 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>Business: <b className="text-white">{app.business?.legal_name || current?.name || "—"}</b></span>
                      <span>·</span>
                      <span><b className="text-white">{(app.owners || []).length}</b> signer{(app.owners || []).length === 1 ? "" : "s"}</span>
                      <span>·</span>
                      <span><b className="text-white">{Object.keys(app.attachments || {}).filter((k) => app.attachments[k]).length}</b> doc{Object.keys(app.attachments || {}).filter((k) => app.attachments[k]).length === 1 ? "" : "s"} uploaded</span>
                    </div>
                  </div>

                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setWantsIt(true)}
                      className="group inline-flex items-center gap-2 px-6 py-3 rounded-full bg-emerald-500 hover:bg-emerald-400 text-slate-900 font-bold shadow-lg hover:shadow-xl hover:scale-[1.02] transition-transform"
                      data-testid="payments-app-continue"
                    >
                      Continue application
                      <ArrowRight size={16} className="group-hover:translate-x-0.5 transition-transform" />
                    </button>
                    <button
                      type="button"
                      onClick={skipEntirely}
                      className="text-[13px] text-white/80 hover:text-white underline underline-offset-4"
                      data-testid="payments-app-save-later"
                    >
                      Save & come back later
                    </button>
                    <button
                      type="button"
                      onClick={startOver}
                      className="text-[11px] text-white/50 hover:text-rose-200 underline underline-offset-4 ml-auto"
                      data-testid="payments-app-start-over"
                      title="Discard your draft and start fresh"
                    >
                      Start over
                    </button>
                  </div>

                  <div className="mt-4 inline-flex items-center gap-1.5 text-[11px] text-emerald-100/70">
                    <ShieldCheck size={12} /> Everything you've entered is encrypted at rest
                  </div>
                </div>
              </div>
            )}

            {/* Fresh visitor — original marketing hero. Only renders
                when there's no draft and no submitted/approved doc. */}
            {docStatus === "draft" && !hasSavedDraft && (
            <>
            {/* Hero — big claim + illustration in a warm gradient */}
            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-500 via-teal-500 to-cyan-600 text-white p-8 sm:p-10 shadow-xl">
              {/* Ambient decorative blobs — pointer-events:none so they
                  never intercept clicks. */}
              <div className="pointer-events-none absolute -top-16 -right-16 w-64 h-64 rounded-full bg-white/10 blur-3xl" />
              <div className="pointer-events-none absolute -bottom-20 -left-10 w-72 h-72 rounded-full bg-cyan-300/20 blur-3xl" />

              <div className="relative grid grid-cols-1 md:grid-cols-5 gap-6 items-center">
                <div className="md:col-span-3">
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-white/15 backdrop-blur-sm px-2.5 py-1 text-[10px] uppercase tracking-widest font-semibold">
                    <Zap size={11} /> Get paid 10× faster
                  </div>
                  <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold leading-tight tracking-tight">
                    Stop chasing checks.<br />
                    <span className="text-emerald-100">Get paid the same week.</span>
                  </h1>
                  <p className="mt-3 text-emerald-50/95 text-[15px] leading-relaxed max-w-md">
                    Flip on <b className="text-white">electronic invoicing</b> and <b className="text-white">ACH pulls</b> so your customers can pay in one click — and you can finally close the month without a stack of unpaid invoices.
                  </p>

                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setWantsIt(true)}
                      className="group inline-flex items-center gap-2 px-6 py-3 rounded-full bg-white text-emerald-700 font-bold shadow-lg hover:shadow-xl hover:scale-[1.02] transition-transform"
                      data-testid="payments-app-yes"
                    >
                      Yes, get me paid faster
                      <ArrowRight size={16} className="group-hover:translate-x-0.5 transition-transform" />
                    </button>
                    <button
                      type="button"
                      onClick={skipEntirely}
                      className="text-[13px] text-white/85 hover:text-white underline underline-offset-4 decoration-white/40 hover:decoration-white/80"
                      data-testid="payments-app-no"
                    >
                      Not right now
                    </button>
                  </div>
                  <div className="mt-4 inline-flex items-center gap-1.5 text-[11px] text-emerald-100">
                    <ShieldCheck size={12} /> Bank-grade encryption · No monthly fee · Cancel anytime
                  </div>
                </div>

                {/* Illustration — pure SVG so it renders anywhere. A
                    stylized "invoice + pay-now button + speed lines"
                    scene, hand-tuned to match the emerald palette. */}
                <div className="md:col-span-2 flex justify-center md:justify-end">
                  <svg viewBox="0 0 220 200" className="w-56 h-52 drop-shadow-lg" aria-hidden="true">
                    {/* speed lines */}
                    <g stroke="rgba(255,255,255,0.4)" strokeWidth="3" strokeLinecap="round">
                      <line x1="18" y1="40" x2="52" y2="40" />
                      <line x1="8"  y1="60" x2="38" y2="60" />
                      <line x1="20" y1="80" x2="60" y2="80" />
                      <line x1="10" y1="150" x2="42" y2="150" />
                      <line x1="24" y1="170" x2="54" y2="170" />
                    </g>
                    {/* invoice card */}
                    <rect x="70" y="30" width="120" height="140" rx="14" fill="white" />
                    <rect x="82" y="46" width="60" height="8" rx="4" fill="#0f766e" />
                    <rect x="82" y="62" width="90" height="4" rx="2" fill="#a7f3d0" />
                    <rect x="82" y="72" width="70" height="4" rx="2" fill="#a7f3d0" />
                    <line x1="82" y1="90" x2="178" y2="90" stroke="#d1fae5" strokeWidth="1" />
                    <rect x="82" y="98"  width="60" height="4" rx="2" fill="#e2e8f0" />
                    <rect x="152" y="98" width="26" height="4" rx="2" fill="#0f766e" />
                    <rect x="82" y="110" width="48" height="4" rx="2" fill="#e2e8f0" />
                    <rect x="152" y="110" width="26" height="4" rx="2" fill="#0f766e" />
                    <rect x="82" y="122" width="56" height="4" rx="2" fill="#e2e8f0" />
                    <rect x="152" y="122" width="26" height="4" rx="2" fill="#0f766e" />
                    {/* Pay-now pill */}
                    <rect x="86" y="140" width="88" height="22" rx="11" fill="url(#payBtn)" />
                    <text x="130" y="155" textAnchor="middle" fontFamily="ui-sans-serif" fontWeight="700" fontSize="10" fill="white">PAY NOW</text>
                    {/* Cursor click */}
                    <g transform="translate(160, 152)">
                      <path d="M0 0 L14 6 L6 8 L4 16 Z" fill="#0f172a" />
                    </g>
                    {/* Coin / dollar */}
                    <circle cx="52" cy="112" r="18" fill="#facc15" stroke="#eab308" strokeWidth="2" />
                    <text x="52" y="118" textAnchor="middle" fontFamily="ui-sans-serif" fontWeight="800" fontSize="18" fill="#78350f">$</text>
                    <defs>
                      <linearGradient id="payBtn" x1="0" x2="1" y1="0" y2="1">
                        <stop offset="0" stopColor="#10b981" />
                        <stop offset="1" stopColor="#0891b2" />
                      </linearGradient>
                    </defs>
                  </svg>
                </div>
              </div>
            </div>

            {/* Stat strip */}
            <div className="grid grid-cols-3 gap-3 mt-4">
              {[
                { stat: "2–3 days", label: "average time to money" },
                { stat: "83%",     label: "of invoices paid on time" },
                { stat: "$0",       label: "monthly platform fee" },
              ].map((s) => (
                <div key={s.label} className="rounded-xl bg-white border border-slate-200 shadow-sm p-3 text-center">
                  <div className="text-lg sm:text-xl font-extrabold text-slate-900 leading-none">{s.stat}</div>
                  <div className="text-[10px] uppercase tracking-widest text-slate-500 mt-1">{s.label}</div>
                </div>
              ))}
            </div>

            {/* Feature grid */}
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                { Icon: Clock,               tone: "text-emerald-600 bg-emerald-50", title: "Money in 2–3 days",   desc: "ACH pulls settle in days, not the 30+ your customers 'meant to send a check' last month." },
                { Icon: MousePointerClick,   tone: "text-cyan-600 bg-cyan-50",       title: "One-click Pay button", desc: "Every invoice gets a Pay Now link — no logins, no 'sorry, we mail checks only'." },
                { Icon: TrendingUp,          tone: "text-violet-600 bg-violet-50",   title: "Auto-reconciled",       desc: "Payments post themselves into your books and clear the matching invoice — no double-entry." },
                { Icon: ShieldCheck,         tone: "text-amber-600 bg-amber-50",     title: "Encrypted end-to-end", desc: "Federal Tax ID, SSN, and DOB are ciphered at rest. Only the CPA and superadmin can decrypt." },
              ].map((f) => {
                const I = f.Icon;
                return (
                  <div key={f.title} className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 flex items-start gap-3">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${f.tone}`}>
                      <I size={16} />
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900 text-[14px] leading-tight">{f.title}</div>
                      <div className="text-[12px] text-slate-600 mt-1 leading-relaxed">{f.desc}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* How-it-works timeline */}
            <div className="mt-4 rounded-xl bg-slate-900 text-white p-5 shadow-sm">
              <div className="text-[10px] uppercase tracking-widest text-emerald-300 font-semibold mb-3">
                How it works
              </div>
              <ol className="space-y-3">
                {[
                  { n: 1, title: "10-minute application",   desc: "Business info, signer(s), a voided check, and an ID — all autosaved, come back anytime." },
                  { n: 2, title: "Same-day approval",        desc: "Most applications get approved within a few hours. We'll ping you the moment you're live." },
                  { n: 3, title: "Send your first e-invoice", desc: "Your existing invoices become one-click Pay Now links. The money hits your bank in 2–3 days." },
                ].map((s) => (
                  <li key={s.n} className="flex items-start gap-3">
                    <div className="w-6 h-6 rounded-full bg-emerald-400 text-slate-900 text-[12px] font-extrabold flex items-center justify-center shrink-0">{s.n}</div>
                    <div>
                      <div className="font-semibold text-white text-[14px] leading-tight">{s.title}</div>
                      <div className="text-[12px] text-slate-300 mt-0.5">{s.desc}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            {/* Trust bar */}
            <div className="mt-4 rounded-xl bg-white border border-slate-200 shadow-sm p-4 flex flex-wrap items-center gap-4 justify-around text-[11px] text-slate-600">
              <span className="inline-flex items-center gap-1.5"><ShieldCheck size={13} className="text-emerald-600" /> 256-bit AES at rest</span>
              <span className="inline-flex items-center gap-1.5"><CheckCircle2 size={13} className="text-emerald-600" /> SOC 2 pipeline</span>
              <span className="inline-flex items-center gap-1.5"><CreditCard size={13} className="text-emerald-600" /> ACH · Card · Wire</span>
              <span className="inline-flex items-center gap-1.5"><DollarSign size={13} className="text-emerald-600" /> No monthly fees</span>
            </div>

            {/* Bottom CTA — mirrors hero so the button is always in reach */}
            <div className="mt-6 flex items-center justify-between">
              <button
                type="button"
                onClick={skipEntirely}
                className="text-sm text-slate-500 hover:text-slate-900"
                data-testid="payments-app-no-bottom"
              >
                Not right now
              </button>
              <button
                type="button"
                onClick={() => setWantsIt(true)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow"
                data-testid="payments-app-yes-bottom"
              >
                <Check size={14} /> Yes, let's do it <ArrowRight size={14} />
              </button>
            </div>
            </>
            )}
          </div>
        )}

        {wantsIt === true && (
          <>
            {/* Stepper — three numbered pips with a connecting bar
                that fills as the user advances. Clicking a completed
                step jumps back; forward jumps are gated by validity. */}
            <div className="mb-6" data-testid="payments-app-stepper">
              <div className="flex items-center">
                {STEPS.map((s, idx) => {
                  const done = (s.n === 1 && step1Valid) || (s.n === 2 && step2Valid) || (s.n === 3 && step3Valid);
                  const active = step === s.n;
                  const clickable = s.n < step
                    || (s.n === 2 && step1Valid)
                    || (s.n === 3 && step1Valid && step2Valid);
                  return (
                    <React.Fragment key={s.n}>
                      <button
                        type="button"
                        disabled={!clickable}
                        onClick={() => clickable && setStep(s.n)}
                        className={`flex items-center gap-2 group ${clickable ? "cursor-pointer" : "cursor-not-allowed"}`}
                        data-testid={`payments-app-step-${s.n}`}
                      >
                        <span className={`w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-bold shrink-0 transition-colors ${
                          active
                            ? "bg-emerald-600 text-white shadow"
                            : done
                              ? "bg-emerald-100 text-emerald-700 border border-emerald-300"
                              : "bg-white text-slate-400 border border-slate-300"
                        }`}>
                          {done && !active ? <Check size={14} /> : s.n}
                        </span>
                        <span className={`text-[13px] font-semibold ${active ? "text-slate-900" : done ? "text-emerald-700" : "text-slate-400"}`}>
                          {s.title}
                        </span>
                      </button>
                      {idx < STEPS.length - 1 && (
                        <div className="flex-1 mx-3 h-[2px] bg-slate-200 rounded overflow-hidden">
                          <div
                            className="h-full bg-emerald-500 transition-all"
                            style={{ width: ((s.n === 1 && step1Valid) || (s.n === 2 && step2Valid)) ? "100%" : "0%" }}
                          />
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>

            {/* Step 1 — Business */}
            {step === 1 && (
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
            )}

            {/* Step 2 — Owners / signers */}
            {step === 2 && (
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
            )}

            {/* Step 3 — Uploads */}
            {step === 3 && (
              <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm mb-4" data-testid="payments-app-uploads">
                <div className="font-semibold text-slate-900 mb-3">Uploads</div>
                <div className="space-y-3">
                  <Upl
                    label="Voided check"
                    required
                    value={app.attachments.voided_check}
                    onUpload={(v) => setAttachment("voided_check", v)}
                    onRemove={() => setAttachment("voided_check", null)}
                    companyId={currentId}
                    testid="upl-check"
                  />
                  <Upl
                    label="Signer ID / license"
                    required
                    value={app.attachments.signer_id}
                    onUpload={(v) => setAttachment("signer_id", v)}
                    onRemove={() => setAttachment("signer_id", null)}
                    companyId={currentId}
                    testid="upl-id"
                  />
                  <UplMulti
                    label="Last 3 months of processing statements (optional)"
                    value={app.attachments.processing_stmts}
                    onChange={(v) => setAttachment("processing_stmts", v)}
                    companyId={currentId}
                    testid="upl-processing"
                  />
                  <UplMulti
                    label="Last 2 months of business bank statements (if ACH)"
                    value={app.attachments.bank_stmts}
                    onChange={(v) => setAttachment("bank_stmts", v)}
                    companyId={currentId}
                    testid="upl-bank"
                  />
                </div>
              </section>
            )}

            {/* Footer — nav + save + submit. Submit only lights up on
                step 3 when *every* step is valid. Prior steps show a
                Next button that guards forward motion. */}
            <div className="flex flex-wrap items-center gap-3 justify-between mt-2">
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
                {step > 1 && (
                  <button
                    type="button"
                    onClick={goBack}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-slate-300 bg-white text-slate-700 font-semibold hover:bg-slate-50"
                    data-testid="payments-app-back"
                  >
                    Back
                  </button>
                )}
                {step < 3 ? (
                  <button
                    type="button"
                    onClick={goNext}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow"
                    data-testid="payments-app-next"
                  >
                    Next <ArrowRight size={14} />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={submitAll}
                    disabled={submitting || !allValid}
                    title={!allValid ? "Complete every step to enable submit." : ""}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="payments-app-submit"
                  >
                    {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
                    Submit application <ArrowRight size={14} />
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
