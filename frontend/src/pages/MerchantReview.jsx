/**
 * MerchantReview — dedicated portal for the NMI underwriter (Paul).
 *
 * Layout is a two-pane list-detail:
 *   • Left rail  — every submitted / approved / declined app.
 *                  Bucketed by status, most recent first.
 *   • Right pane — full decrypted application, uploaded documents,
 *                  and Approve / Decline actions.
 *
 * Approve captures NMI Security Key, Tokenization Key, Processor ID,
 * webhook secret, environment (sandbox / production), and the
 * per-merchant surcharge %. All persist server-side encrypted.
 *
 * Access-gated to `underwriter` or `superadmin` roles by both the
 * backend router and this component's mount-time redirect.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  ShieldCheck, Loader2, CheckCircle2, XCircle, FileText, Download,
  ExternalLink, Search, Lock,
} from "lucide-react";

import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const STATUS_LABEL = {
  submitted: { text: "Awaiting review", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  approved:  { text: "Approved",        cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  declined:  { text: "Declined",        cls: "bg-rose-50 text-rose-700 border-rose-200" },
};

function StatusPill({ status }) {
  const s = STATUS_LABEL[status] || STATUS_LABEL.submitted;
  return (
    <span className={`inline-block text-[10px] uppercase tracking-widest font-semibold px-1.5 py-0.5 rounded border ${s.cls}`}>
      {s.text}
    </span>
  );
}

function FieldRow({ label, value, mono }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</div>
      <div className={`text-[13px] text-slate-900 mt-0.5 ${mono ? "font-mono" : ""}`}>
        {value || <span className="text-slate-400 italic">not provided</span>}
      </div>
    </div>
  );
}

function ApproveModal({ open, onClose, onSubmit, working }) {
  const [form, setForm] = useState({
    nmi_security_key: "",
    nmi_tokenization_key: "",
    nmi_processor_id: "",
    webhook_secret: "",
    environment: "sandbox",
    surcharge_pct: "",
    note: "",
  });
  useEffect(() => {
    if (open) setForm(f => ({ ...f, nmi_security_key: "", nmi_tokenization_key: "" }));
  }, [open]);
  if (!open) return null;
  const valid = form.nmi_security_key.trim().length >= 8 && form.nmi_tokenization_key.trim().length >= 8;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" data-testid="approve-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="p-5 border-b border-slate-200">
          <div className="flex items-center gap-2 text-emerald-700">
            <ShieldCheck size={16} />
            <div className="text-[10px] uppercase tracking-widest font-semibold">Underwriter · Approve</div>
          </div>
          <div className="text-lg font-bold text-slate-900 mt-1">Enable payments for this merchant</div>
          <div className="text-[12px] text-slate-500 mt-1">Keys are encrypted at rest and only decrypted server-side for API calls.</div>
        </div>
        <div className="p-5 space-y-3 max-h-[65vh] overflow-y-auto">
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Environment</div>
            <select
              value={form.environment}
              onChange={(e) => setForm({ ...form, environment: e.target.value })}
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm bg-white"
              data-testid="approve-env"
            >
              <option value="sandbox">Sandbox (test)</option>
              <option value="production">Production (live)</option>
            </select>
          </label>
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">NMI Security Key *</div>
            <input
              type="password" value={form.nmi_security_key}
              onChange={(e) => setForm({ ...form, nmi_security_key: e.target.value })}
              placeholder="private, server-side only"
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
              data-testid="approve-sec-key"
            />
          </label>
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">NMI Tokenization Key *</div>
            <input
              type="text" value={form.nmi_tokenization_key}
              onChange={(e) => setForm({ ...form, nmi_tokenization_key: e.target.value })}
              placeholder="public — browser-facing"
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
              data-testid="approve-tok-key"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Processor ID</div>
              <input
                type="text" value={form.nmi_processor_id}
                onChange={(e) => setForm({ ...form, nmi_processor_id: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
                data-testid="approve-proc-id"
              />
            </label>
            <label className="block">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Surcharge %</div>
              <input
                type="number" step="0.01" min="0" max="10"
                value={form.surcharge_pct}
                onChange={(e) => setForm({ ...form, surcharge_pct: e.target.value })}
                placeholder="0"
                className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                data-testid="approve-surcharge"
              />
            </label>
          </div>
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Webhook Secret <span className="text-slate-400 normal-case tracking-normal">(optional)</span></div>
            <input
              type="password" value={form.webhook_secret}
              onChange={(e) => setForm({ ...form, webhook_secret: e.target.value })}
              placeholder="HMAC signing secret from NMI's webhook settings"
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
              data-testid="approve-webhook-secret"
            />
            <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">
              Recommended for ACH, chargebacks, and portal-initiated refunds. Skip if card-only
              and all refunds go through this app.
            </div>
          </label>
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Internal note (optional)</div>
            <textarea
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              rows={2}
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              data-testid="approve-note"
            />
          </label>
        </div>
        <div className="p-5 border-t border-slate-200 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm text-slate-700 hover:text-slate-900" data-testid="approve-cancel">Cancel</button>
          <button
            type="button"
            disabled={!valid || working}
            onClick={() => onSubmit({ ...form, surcharge_pct: parseFloat(form.surcharge_pct || 0) })}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow disabled:opacity-50"
            data-testid="approve-submit"
          >
            {working && <Loader2 size={13} className="animate-spin" />}
            Approve & enable payments
          </button>
        </div>
      </div>
    </div>
  );
}

function DeclineModal({ open, onClose, onSubmit, working }) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => { if (open) { setReason(""); setNote(""); } }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" data-testid="decline-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="p-5 border-b border-slate-200">
          <div className="flex items-center gap-2 text-rose-700">
            <XCircle size={16} />
            <div className="text-[10px] uppercase tracking-widest font-semibold">Underwriter · Decline</div>
          </div>
          <div className="text-lg font-bold text-slate-900 mt-1">Decline this application</div>
          <div className="text-[12px] text-slate-500 mt-1">The client sees the reason in their inbox and can update and resubmit.</div>
        </div>
        <div className="p-5 space-y-3">
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Reason (visible to client) *</div>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              placeholder="e.g. Need a business bank statement showing the legal name and address."
              data-testid="decline-reason"
            />
          </label>
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Internal note</div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              data-testid="decline-note"
            />
          </label>
        </div>
        <div className="p-5 border-t border-slate-200 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm text-slate-700 hover:text-slate-900">Cancel</button>
          <button
            type="button"
            disabled={reason.trim().length < 4 || working}
            onClick={() => onSubmit({ reason: reason.trim(), note })}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-rose-600 hover:bg-rose-700 text-white font-semibold shadow disabled:opacity-50"
            data-testid="decline-submit"
          >
            {working && <Loader2 size={13} className="animate-spin" />}
            Send decline
          </button>
        </div>
      </div>
    </div>
  );
}

function AppDetail({ cid, onReviewed }) {
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showApprove, setShowApprove] = useState(false);
  const [showDecline, setShowDecline] = useState(false);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!cid) return;
    setBusy(true);
    api.get(`/underwriter/apps/${cid}`)
      .then((r) => setDetail(r.data))
      .catch((e) => toast.error(e?.response?.data?.detail || "Couldn't load application"))
      .finally(() => setBusy(false));
  }, [cid]);

  const approve = async (body) => {
    setWorking(true);
    try {
      await api.post(`/underwriter/apps/${cid}/approve`, body);
      toast.success("Approved. Client has been emailed and payments are live.");
      setShowApprove(false);
      onReviewed?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Approval failed");
    } finally { setWorking(false); }
  };
  const decline = async (body) => {
    setWorking(true);
    try {
      await api.post(`/underwriter/apps/${cid}/decline`, body);
      toast.success("Declined. Client has been emailed with the reason.");
      setShowDecline(false);
      onReviewed?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Decline failed");
    } finally { setWorking(false); }
  };

  if (!cid) {
    return <div className="p-10 text-center text-[13px] text-slate-500">Pick an application from the list to review.</div>;
  }
  if (busy || !detail) {
    return <div className="p-10 flex justify-center"><Loader2 className="animate-spin text-slate-400" /></div>;
  }
  const biz = detail.business || {};
  const owners = detail.owners || [];
  const files = detail.files || [];
  const status = detail.status;

  return (
    <div className="p-5 space-y-5" data-testid="app-detail">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <div className="text-xl font-bold text-slate-900">{detail.company_name}</div>
            <StatusPill status={status} />
          </div>
          {biz.dba && <div className="text-[13px] text-slate-500 mt-0.5">DBA: {biz.dba}</div>}
          <div className="text-[11px] text-slate-400 mt-1">
            Submitted {detail.submitted_at ? new Date(detail.submitted_at).toLocaleString() : "—"}
            {detail.reviewed_at && <> · Reviewed {new Date(detail.reviewed_at).toLocaleString()}</>}
          </div>
        </div>
        {status === "submitted" && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowDecline(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-rose-300 text-rose-700 bg-white hover:bg-rose-50 text-[13px] font-semibold"
              data-testid="btn-decline"
            >
              <XCircle size={13} /> Decline
            </button>
            <button
              onClick={() => setShowApprove(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-[13px] font-semibold shadow"
              data-testid="btn-approve"
            >
              <CheckCircle2 size={13} /> Approve
            </button>
          </div>
        )}
        {status === "approved" && detail.credentials && (
          <div className="rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 text-[12px] px-3 py-2">
            <div className="flex items-center gap-1.5 font-semibold">
              <Lock size={12} /> Payments enabled ({detail.credentials.environment})
            </div>
            <div className="text-[11px] mt-0.5">Tokenization key: <span className="font-mono">{detail.credentials.nmi_tokenization_key?.slice(0, 8)}…</span></div>
            <button
              onClick={() => setShowApprove(true)}
              className="mt-1 text-[11px] underline"
              data-testid="btn-rotate-keys"
            >
              Rotate keys
            </button>
          </div>
        )}
        {status === "declined" && (
          <div className="rounded-md bg-rose-50 border border-rose-200 text-rose-800 text-[12px] px-3 py-2 max-w-md">
            <div className="font-semibold">Declined</div>
            <div className="mt-0.5">{detail.decline_reason || "No reason on file."}</div>
            <button
              onClick={() => setShowApprove(true)}
              className="mt-1 text-[11px] underline"
              data-testid="btn-reconsider"
            >
              Reconsider & approve
            </button>
          </div>
        )}
      </div>

      {/* Business */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="text-[11px] uppercase tracking-widest font-semibold text-slate-500 mb-3">Business</div>
        <div className="grid grid-cols-2 gap-4">
          <FieldRow label="Legal name" value={biz.legal_name} />
          <FieldRow label="Federal Tax ID (EIN)" value={biz.federal_tax_id} mono />
          <FieldRow label="DBA" value={biz.dba} />
          <FieldRow label="Business start date" value={biz.start_date} />
          <FieldRow label="Business address" value={biz.address} />
          <FieldRow label="Business phone" value={biz.phone} />
          <FieldRow label="Contact name" value={biz.contact_name} />
          <FieldRow label="Contact email" value={biz.contact_email} />
          <FieldRow label="Website" value={biz.website} />
          <FieldRow label="Product / service" value={biz.product_sold} />
          <FieldRow label="Avg transaction" value={biz.avg_txn_size ? `$${biz.avg_txn_size}` : ""} />
          <FieldRow label="Avg monthly volume" value={biz.avg_monthly_volume ? `$${biz.avg_monthly_volume}` : ""} />
        </div>
      </section>

      {/* Owners */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] uppercase tracking-widest font-semibold text-slate-500">
            Signers · beneficial owners ({owners.length})
          </div>
          <div className="text-[12px] text-slate-600">
            Combined ownership: <b>{Math.round(detail.completion?.ownership_pct || 0)}%</b>
          </div>
        </div>
        <div className="space-y-3">
          {owners.map((o, i) => (
            <div key={i} className="rounded-md border border-slate-200 p-3 bg-slate-50/40" data-testid={`owner-${i}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[11px] uppercase tracking-widest text-slate-500 font-semibold">Signer #{i + 1} — {o.ownership_pct}%</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FieldRow label="Legal name" value={o.legal_name} />
                <FieldRow label="Date of birth" value={o.dob} />
                <FieldRow label="SSN" value={o.ssn} mono />
                <FieldRow label="Home address" value={o.home_address} />
                <FieldRow label="Home phone" value={o.home_phone} />
                <FieldRow label="Signer email" value={o.signer_email} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Uploaded documents */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="text-[11px] uppercase tracking-widest font-semibold text-slate-500 mb-3">Uploaded documents ({files.length})</div>
        {files.length === 0 ? (
          <div className="text-[13px] text-slate-500 italic">No documents uploaded.</div>
        ) : (
          <ul className="divide-y divide-slate-100 border border-slate-200 rounded-md overflow-hidden">
            {files.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-3 py-2 hover:bg-slate-50" data-testid={`file-${f.id}`}>
                <FileText size={14} className="text-slate-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-slate-800 truncate">{f.original_filename}</div>
                  <div className="text-[11px] text-slate-500">
                    {f.content_type} · {f.size ? `${(f.size / 1024).toFixed(1)} KB` : ""}
                    {f.uploaded_at && ` · uploaded ${new Date(f.uploaded_at).toLocaleDateString()}`}
                  </div>
                </div>
                <a
                  href={`${process.env.REACT_APP_BACKEND_URL}/api/underwriter/apps/${cid}/files/${f.id}`}
                  target="_blank" rel="noreferrer"
                  className="text-[12px] px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 inline-flex items-center gap-1"
                  data-testid={`file-open-${f.id}`}
                >
                  <ExternalLink size={11} /> Preview
                </a>
                <a
                  href={`${process.env.REACT_APP_BACKEND_URL}/api/underwriter/apps/${cid}/files/${f.id}`}
                  download
                  className="text-[12px] px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 inline-flex items-center gap-1"
                  data-testid={`file-download-${f.id}`}
                >
                  <Download size={11} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ApproveModal
        open={showApprove}
        onClose={() => setShowApprove(false)}
        onSubmit={approve}
        working={working}
      />
      <DeclineModal
        open={showDecline}
        onClose={() => setShowDecline(false)}
        onSubmit={decline}
        working={working}
      />
    </div>
  );
}

export default function MerchantReview() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [items, setItems] = useState(null);
  const [selected, setSelected] = useState(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    // Front-end gate — backend enforces too.
    if (user && !["underwriter", "superadmin"].includes(user.role)) nav("/");
  }, [user, nav]);

  const load = async () => {
    try {
      const r = await api.get("/underwriter/apps");
      setItems(r.data?.items || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't load applications");
      setItems([]);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const filtered = useMemo(() => {
    if (!items) return [];
    const needle = q.trim().toLowerCase();
    return needle
      ? items.filter((i) => (i.company_name || "").toLowerCase().includes(needle))
      : items;
  }, [items, q]);

  const groups = useMemo(() => ({
    submitted: filtered.filter((i) => i.status === "submitted"),
    approved:  filtered.filter((i) => i.status === "approved"),
    declined:  filtered.filter((i) => i.status === "declined"),
  }), [filtered]);

  return (
    <div className="min-h-screen bg-slate-50" data-testid="merchant-review-page">
      <div className="max-w-[1300px] mx-auto px-6 py-6">
        <div className="flex items-baseline justify-between mb-4">
          <div>
            <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.15em] font-semibold text-slate-500">
              <ShieldCheck size={13} /> Underwriter Portal
            </div>
            <h1 className="text-2xl font-bold text-slate-900 mt-1">Merchant Review</h1>
            <p className="text-[13px] text-slate-500 mt-1">
              Approve or decline payments applications. Approved merchants can start invoicing immediately.
            </p>
          </div>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search merchants…"
              className="pl-7 pr-3 py-1.5 text-[13px] rounded-md border border-slate-300 bg-white w-64"
              data-testid="mr-search"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
          {/* Left list */}
          <aside className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden self-start sticky top-4 max-h-[85vh] overflow-y-auto">
            {items === null ? (
              <div className="p-6 flex justify-center"><Loader2 className="animate-spin text-slate-400" /></div>
            ) : filtered.length === 0 ? (
              <div className="p-6 text-[13px] text-slate-500 italic text-center">No applications found.</div>
            ) : (
              <>
                {(["submitted", "approved", "declined"]).map((bucket) => (
                  groups[bucket].length > 0 && (
                    <div key={bucket}>
                      <div className="px-4 py-2 text-[10px] uppercase tracking-widest font-semibold text-slate-500 bg-slate-50 border-b border-slate-200">
                        {STATUS_LABEL[bucket].text} ({groups[bucket].length})
                      </div>
                      <ul>
                        {groups[bucket].map((it) => (
                          <li key={it.company_id}>
                            <button
                              type="button"
                              onClick={() => setSelected(it.company_id)}
                              className={`w-full text-left px-4 py-3 hover:bg-slate-50 border-b border-slate-100 ${
                                selected === it.company_id ? "bg-slate-100" : ""
                              }`}
                              data-testid={`mr-row-${it.company_id}`}
                            >
                              <div className="text-[13px] font-semibold text-slate-900 truncate">{it.company_name}</div>
                              {it.dba && <div className="text-[11px] text-slate-500 truncate">DBA: {it.dba}</div>}
                              <div className="flex items-center justify-between mt-1">
                                <StatusPill status={it.status} />
                                {it.submitted_at && (
                                  <span className="text-[10px] text-slate-400">
                                    {new Date(it.submitted_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                                  </span>
                                )}
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                ))}
              </>
            )}
          </aside>

          {/* Detail pane */}
          <section className="rounded-xl border border-slate-200 bg-white shadow-sm min-h-[70vh]">
            <AppDetail cid={selected} onReviewed={() => { load(); }} />
          </section>
        </div>
      </div>
    </div>
  );
}
