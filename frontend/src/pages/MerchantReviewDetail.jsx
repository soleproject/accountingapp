/**
 * MerchantReviewDetail — dedicated detail page for a single payments
 * application. Renders decrypted business data + owners + documents
 * and exposes Approve/Decline/Rotate-keys/Reconsider actions plus
 * PDF download and per-document download.
 *
 * Route: /admin/merchant-review/apps/:cid
 */
import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowLeft, CheckCircle2, XCircle, FileText, Download, ExternalLink,
  Lock, Loader2, ShieldCheck, Printer,
} from "lucide-react";
import { api } from "@/lib/api";
import { ApproveModal, DeclineModal } from "@/components/MerchantReviewModals";

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

export default function MerchantReviewDetail() {
  const { cid } = useParams();
  const nav = useNavigate();
  const [detail, setDetail] = useState(null);
  const [showApprove, setShowApprove] = useState(false);
  const [showDecline, setShowDecline] = useState(false);
  const [working, setWorking] = useState(false);

  const load = async () => {
    try {
      const r = await api.get(`/underwriter/apps/${cid}`);
      setDetail(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't load application");
      nav("/admin/merchant-review/awaiting");
    }
  };
  useEffect(() => { setDetail(null); load(); /* eslint-disable-next-line */ }, [cid]);

  const approve = async (body) => {
    setWorking(true);
    try {
      await api.post(`/underwriter/apps/${cid}/approve`, body);
      toast.success("Approved. Client emailed, payments are live.");
      setShowApprove(false); load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Approval failed");
    } finally { setWorking(false); }
  };
  const decline = async (body) => {
    setWorking(true);
    try {
      await api.post(`/underwriter/apps/${cid}/decline`, body);
      toast.success("Declined. Client emailed with the reason.");
      setShowDecline(false); load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Decline failed");
    } finally { setWorking(false); }
  };

  const downloadPdf = async () => {
    try {
      const r = await api.get(`/underwriter/apps/${cid}/pdf`, { responseType: "blob" });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${detail?.company_name || "application"}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't download PDF");
    }
  };

  if (!detail) {
    return <div className="min-h-screen bg-slate-50 flex justify-center pt-24"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  const biz = detail.business || {};
  const owners = detail.owners || [];
  const files = detail.files || [];
  const status = detail.status;

  return (
    <div className="min-h-screen bg-slate-50" data-testid="merchant-review-detail">
      <div className="max-w-[1100px] mx-auto px-6 py-6">
        {/* Breadcrumb / back */}
        <button
          onClick={() => nav(-1)}
          className="inline-flex items-center gap-1.5 text-[12px] text-slate-500 hover:text-slate-900 mb-3"
          data-testid="mr-back"
        >
          <ArrowLeft size={13} /> Back to list
        </button>

        {/* Header */}
        <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-slate-900">{detail.company_name}</h1>
              <StatusPill status={status} />
            </div>
            {biz.dba && <div className="text-[13px] text-slate-500 mt-0.5">DBA: {biz.dba}</div>}
            <div className="text-[11px] text-slate-400 mt-1">
              Submitted {detail.submitted_at ? new Date(detail.submitted_at).toLocaleString() : "—"}
              {detail.reviewed_at && <> · Reviewed {new Date(detail.reviewed_at).toLocaleString()}</>}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={downloadPdf}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 text-[13px] font-semibold"
              data-testid="mr-download-pdf"
              title="Download the full application as a PDF"
            >
              <Printer size={13} /> Download PDF
            </button>
            {status === "submitted" && (
              <>
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
              </>
            )}
            {status === "approved" && (
              <button
                onClick={() => setShowApprove(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-emerald-300 text-emerald-700 bg-white hover:bg-emerald-50 text-[13px] font-semibold"
                data-testid="btn-rotate-keys"
              >
                <Lock size={13} /> Rotate NMI keys
              </button>
            )}
            {status === "declined" && (
              <button
                onClick={() => setShowApprove(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-[13px] font-semibold shadow"
                data-testid="btn-reconsider"
              >
                <CheckCircle2 size={13} /> Reconsider & approve
              </button>
            )}
          </div>
        </div>

        {/* Approved-key summary */}
        {status === "approved" && detail.credentials && (
          <div className="rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 text-[12px] px-3 py-2 mb-4 flex items-center gap-2">
            <ShieldCheck size={13} />
            <div>
              <b>Payments enabled ({detail.credentials.environment})</b> ·
              Tokenization key <span className="font-mono">{detail.credentials.nmi_tokenization_key?.slice(0, 12)}…</span> ·
              Surcharge {detail.credentials.surcharge_pct || 0}%
            </div>
          </div>
        )}

        {/* Declined reason */}
        {status === "declined" && detail.decline_reason && (
          <div className="rounded-md bg-rose-50 border border-rose-200 text-rose-800 text-[13px] px-3 py-2 mb-4">
            <div className="text-[10px] uppercase tracking-widest font-semibold">Decline reason (visible to client)</div>
            <div className="mt-1">{detail.decline_reason}</div>
          </div>
        )}

        {/* Business */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm mb-4">
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
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm mb-4">
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
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm mb-4">
          <div className="text-[11px] uppercase tracking-widest font-semibold text-slate-500 mb-3">
            Uploaded documents ({files.length})
          </div>
          {files.length === 0 ? (
            <div className="text-[13px] text-slate-500 italic">No documents uploaded with this application.</div>
          ) : (
            <ul className="divide-y divide-slate-100 border border-slate-200 rounded-md overflow-hidden">
              {files.map((f) => (
                <li key={f.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50" data-testid={`file-${f.id}`}>
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
                    download={f.original_filename}
                    className="text-[12px] px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 inline-flex items-center gap-1"
                    data-testid={`file-download-${f.id}`}
                  >
                    <Download size={11} /> Download
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <ApproveModal open={showApprove} onClose={() => setShowApprove(false)} onSubmit={approve} working={working} />
      <DeclineModal open={showDecline} onClose={() => setShowDecline(false)} onSubmit={decline} working={working} />
    </div>
  );
}
