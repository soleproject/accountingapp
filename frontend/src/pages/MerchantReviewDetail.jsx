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
  Lock, Loader2, ShieldCheck, Printer, MessageSquareWarning, Clock,
  MailCheck,
} from "lucide-react";
import { api } from "@/lib/api";
import { ApproveModal, DeclineModal, RequestInfoModal } from "@/components/MerchantReviewModals";

const STATUS_LABEL = {
  draft:             { text: "Application started", cls: "bg-slate-50 text-slate-700 border-slate-200" },
  submitted:         { text: "Awaiting review",     cls: "bg-amber-50 text-amber-700 border-amber-200" },
  processing:        { text: "Processing review",   cls: "bg-blue-50 text-blue-700 border-blue-200" },
  waiting_on_client: { text: "Waiting on client",   cls: "bg-orange-50 text-orange-700 border-orange-200" },
  info_received:     { text: "Info received",       cls: "bg-violet-50 text-violet-700 border-violet-200" },
  approved:          { text: "Approved",            cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  declined:          { text: "Declined",            cls: "bg-rose-50 text-rose-700 border-rose-200" },
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
  const [showRequestInfo, setShowRequestInfo] = useState(false);
  const [working, setWorking] = useState(false);
  // Once per detail-page mount we auto-flip a `submitted` app into
  // `processing` so the "Awaiting Review" bucket only shows work that
  // truly hasn't been touched yet. We guard so re-loads within the
  // same session don't re-fire the toast.
  const autoStartedRef = React.useRef(false);

  const load = async () => {
    try {
      const r = await api.get(`/underwriter/apps/${cid}`);
      setDetail(r.data);
      // Auto-claim brand-new submissions on first open. Silent —
      // no toast — because it's a background workflow bookkeeping
      // move, not a user-initiated action.
      if (!autoStartedRef.current && r.data?.status === "submitted") {
        autoStartedRef.current = true;
        try {
          await api.post(`/underwriter/apps/${cid}/mark-processing`);
          // Reload so the UI reflects the new status + button set.
          const r2 = await api.get(`/underwriter/apps/${cid}`);
          setDetail(r2.data);
        } catch { /* non-fatal; user can still click Start Review */ }
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't load application");
      nav("/admin/merchant-review/awaiting");
    }
  };
  useEffect(() => { setDetail(null); autoStartedRef.current = false; load(); /* eslint-disable-next-line */ }, [cid]);

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
  const requestInfo = async (body) => {
    setWorking(true);
    try {
      await api.post(`/underwriter/apps/${cid}/request-info`, body);
      toast.success("Info request sent — client emailed.");
      setShowRequestInfo(false); load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't send info request");
    } finally { setWorking(false); }
  };
  const startReview = async () => {
    setWorking(true);
    try {
      await api.post(`/underwriter/apps/${cid}/mark-processing`);
      toast.success("Marked as processing.");
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't start review");
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

            {/* Manual "Start Review" toggle — useful when auto-mark
                didn't fire (network hiccup) or after the app came back
                as `info_received` from the client. */}
            {(status === "submitted" || status === "info_received") && (
              <button
                onClick={startReview}
                disabled={working}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-blue-300 text-blue-700 bg-white hover:bg-blue-50 text-[13px] font-semibold disabled:opacity-60"
                data-testid="btn-start-review"
              >
                <Clock size={13} /> Start Review
              </button>
            )}

            {/* Request Info — available anytime the app is live in the
                review pipeline. Never on approved/declined/draft. */}
            {["submitted", "processing", "info_received", "waiting_on_client"].includes(status) && (
              <button
                onClick={() => setShowRequestInfo(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-orange-300 text-orange-700 bg-white hover:bg-orange-50 text-[13px] font-semibold"
                data-testid="btn-request-info"
              >
                <MessageSquareWarning size={13} />
                {status === "waiting_on_client" ? "Update request" : "Request info"}
              </button>
            )}

            {/* Approve / Decline — only from active review states. */}
            {["submitted", "processing", "info_received"].includes(status) && (
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

        {/* Waiting-on-client callout — shows the note the underwriter
            sent so it's obvious what's blocking. Same wording the
            client sees in their email/banner. */}
        {status === "waiting_on_client" && detail.info_request_note && (
          <div className="rounded-md bg-orange-50 border border-orange-200 text-orange-800 text-[13px] px-3 py-2 mb-4" data-testid="mr-info-request-note">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-semibold">
              <MessageSquareWarning size={12} /> Info requested (visible to client)
            </div>
            <div className="mt-1 whitespace-pre-line">{detail.info_request_note}</div>
            {detail.info_requested_at && (
              <div className="mt-1 text-[11px] text-orange-600/80">
                Sent {new Date(detail.info_requested_at).toLocaleString()}
              </div>
            )}
          </div>
        )}

        {/* Info-received callout — flags that the client re-submitted
            with the underwriter's requested details. */}
        {status === "info_received" && (
          <div className="rounded-md bg-violet-50 border border-violet-200 text-violet-800 text-[13px] px-3 py-2 mb-4" data-testid="mr-info-received-note">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-semibold">
              <MailCheck size={12} /> Client responded
            </div>
            <div className="mt-1">
              The client has updated their application and re-submitted.
              {detail.info_request_note && <> Original request: <i>"{detail.info_request_note}"</i></>}
            </div>
            {detail.info_received_at && (
              <div className="mt-1 text-[11px] text-violet-600/80">
                Re-submitted {new Date(detail.info_received_at).toLocaleString()}
              </div>
            )}
          </div>
        )}

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

        {/* Additional requests — full history of every info request
            the underwriter sent, with links to the specific documents
            the client uploaded in response. Only renders when there's
            at least one entry to show. */}
        {(detail.info_requests || []).length > 0 && (
          <section
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm mb-4"
            data-testid="additional-requests-section"
          >
            <div className="flex items-center justify-between mb-3">
              <div className="text-[11px] uppercase tracking-widest font-semibold text-slate-500">
                Additional requests ({detail.info_requests.length})
              </div>
              <div className="text-[11px] text-slate-400">Newest first</div>
            </div>
            <ol className="space-y-3">
              {detail.info_requests.map((req, i) => {
                const done = !!req.responded_at;
                return (
                  <li
                    key={req.id || i}
                    className={`rounded-lg border p-3 ${
                      done ? "border-violet-200 bg-violet-50/40" : "border-orange-200 bg-orange-50/40"
                    }`}
                    data-testid={`info-request-${req.id || i}`}
                  >
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded ${
                          done
                            ? "bg-violet-100 text-violet-800"
                            : "bg-orange-100 text-orange-800"
                        }`}>
                          {done ? <MailCheck size={11} /> : <MessageSquareWarning size={11} />}
                          {done ? "Responded" : "Waiting on client"}
                        </span>
                        <span className="text-[11px] text-slate-500">
                          Requested {req.requested_at ? new Date(req.requested_at).toLocaleString() : "—"}
                        </span>
                      </div>
                      {done && (
                        <span className="text-[11px] text-violet-700 font-semibold">
                          Responded {new Date(req.responded_at).toLocaleString()}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 text-[13px] text-slate-800 whitespace-pre-line">
                      {req.note || <span className="text-slate-400 italic">no note provided</span>}
                    </div>
                    {done && (
                      <div className="mt-3 pt-2 border-t border-slate-200">
                        <div className="text-[10px] uppercase tracking-widest font-semibold text-slate-500 mb-1.5">
                          Documents uploaded in response
                        </div>
                        {(req.response_files || []).length === 0 ? (
                          <div className="text-[12px] text-slate-500 italic">
                            No new files were attached with this response — the client updated existing fields.
                          </div>
                        ) : (
                          <ul className="space-y-1">
                            {req.response_files.map((f) => (
                              <li key={f.id} className="flex items-center gap-2" data-testid={`request-file-${f.id}`}>
                                <FileText size={13} className="text-slate-500 shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <div className="text-[13px] font-medium text-slate-800 truncate">{f.original_filename}</div>
                                  <div className="text-[11px] text-slate-500">
                                    {f.content_type}
                                    {f.size ? ` · ${(f.size / 1024).toFixed(1)} KB` : ""}
                                    {f.uploaded_at ? ` · ${new Date(f.uploaded_at).toLocaleDateString()}` : ""}
                                  </div>
                                </div>
                                <a
                                  href={`${process.env.REACT_APP_BACKEND_URL}/api/underwriter/apps/${cid}/files/${f.id}`}
                                  target="_blank" rel="noreferrer"
                                  className="text-[12px] px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 inline-flex items-center gap-1"
                                  data-testid={`request-file-open-${f.id}`}
                                >
                                  <ExternalLink size={11} /> Preview
                                </a>
                                <a
                                  href={`${process.env.REACT_APP_BACKEND_URL}/api/underwriter/apps/${cid}/files/${f.id}`}
                                  download={f.original_filename}
                                  className="text-[12px] px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 inline-flex items-center gap-1"
                                  data-testid={`request-file-download-${f.id}`}
                                >
                                  <Download size={11} /> Download
                                </a>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        )}
      </div>

      <ApproveModal open={showApprove} onClose={() => setShowApprove(false)} onSubmit={approve} working={working} />
      <DeclineModal open={showDecline} onClose={() => setShowDecline(false)} onSubmit={decline} working={working} />
      <RequestInfoModal open={showRequestInfo} onClose={() => setShowRequestInfo(false)} onSubmit={requestInfo} working={working} />
    </div>
  );
}
