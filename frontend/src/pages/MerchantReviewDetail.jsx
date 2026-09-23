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
  MailCheck, Key, RefreshCw, AlertTriangle, Ban, Check,
} from "lucide-react";
import { api } from "@/lib/api";
import { ApproveModal, DeclineModal, RequestInfoModal, GatewayKeysModal } from "@/components/MerchantReviewModals";

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
  const [showGatewayKeys, setShowGatewayKeys] = useState(false);
  const [working, setWorking] = useState(false);
  // Masked view of the merchant's stored NMI credentials. `null` =
  // haven't fetched yet, `{configured:false}` = fetched, none on file.
  const [gwKeys, setGwKeys] = useState(null);
  // Which tab is active under the header callouts. Three tabs:
  // Application (business + owners), Documents (originals + info
  // request replies), and Gateway Keys (this merchant's NMI creds).
  const [tab, setTab] = useState("application");
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

  // ---- Gateway Keys tab ------------------------------------------
  const loadGwKeys = async () => {
    try {
      const r = await api.get(`/underwriter/apps/${cid}/gateway-keys`);
      setGwKeys(r.data);
    } catch (e) {
      // 404-ish states just mean "not configured" — treat as such.
      setGwKeys({ configured: false });
    }
  };
  useEffect(() => { setGwKeys(null); loadGwKeys(); /* eslint-disable-next-line */ }, [cid]);

  const saveGwKeys = async (body) => {
    setWorking(true);
    try {
      await api.put(`/underwriter/apps/${cid}/gateway-keys`, body);
      toast.success(gwKeys?.configured ? "Keys rotated." : "Credentials saved.");
      setShowGatewayKeys(false);
      loadGwKeys();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save credentials");
    } finally { setWorking(false); }
  };
  const revokeGwKeys = async () => {
    if (!window.confirm(
      "Revoke this merchant's stored credentials?\n\n"
      + "The Pay Now button on their invoices will stop working immediately. "
      + "The approval decision stays intact — you can re-enter keys anytime."
    )) return;
    setWorking(true);
    try {
      await api.delete(`/underwriter/apps/${cid}/gateway-keys`);
      toast.success("Credentials revoked.");
      loadGwKeys();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't revoke");
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
                onClick={() => { setTab("gateway"); setShowGatewayKeys(true); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-emerald-300 text-emerald-700 bg-white hover:bg-emerald-50 text-[13px] font-semibold"
                data-testid="btn-rotate-keys"
              >
                <Key size={13} /> Update merchant keys
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

        {/* Decline reason */}
        {status === "declined" && detail.decline_reason && (
          <div className="rounded-md bg-rose-50 border border-rose-200 text-rose-800 text-[13px] px-3 py-2 mb-4">
            <div className="text-[10px] uppercase tracking-widest font-semibold">Decline reason (visible to client)</div>
            <div className="mt-1">{detail.decline_reason}</div>
          </div>
        )}

        {/* Tab switcher: Application vs. Documents. Documents groups
            the originally-uploaded files with every additional info
            request so the underwriter has one place to see the full
            paper trail. */}
        <div className="border-b border-slate-200 mb-4 flex items-center gap-4" data-testid="mr-detail-tabs">
          <TabButton
            active={tab === "application"}
            onClick={() => setTab("application")}
            testid="mr-tab-application"
          >
            Application
          </TabButton>
          <TabButton
            active={tab === "documents"}
            onClick={() => setTab("documents")}
            testid="mr-tab-documents"
            badge={files.length}
          >
            Documents
          </TabButton>
          <TabButton
            active={tab === "gateway"}
            onClick={() => setTab("gateway")}
            testid="mr-tab-gateway"
          >
            Gateway Keys
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                gwKeys?.configured ? "bg-emerald-500" : "bg-slate-300"
              }`}
              title={gwKeys?.configured ? "Configured" : "Not configured"}
            />
          </TabButton>
        </div>

        {tab === "application" && (
        <>
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
        </>
        )}

        {tab === "documents" && (
        <>
        {/* Original uploaded documents */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm mb-4">
          {(() => {
            // Any file that was attached in response to an info
            // request is shown under "Additional requests" below,
            // so keep it out of the "Original documents" list to
            // avoid duplicates.
            const respIds = new Set(
              (detail.info_requests || []).flatMap((r) => (r.response_files || []).map((f) => f.id))
            );
            const originals = files.filter((f) => !respIds.has(f.id));
            return (
            <>
            <div className="text-[11px] uppercase tracking-widest font-semibold text-slate-500 mb-3">
              Original documents ({originals.length})
            </div>
            {originals.length === 0 ? (
              <div className="text-[13px] text-slate-500 italic">
                {files.length === 0
                  ? "No documents uploaded with this application."
                  : "All uploaded documents came in via info requests — see below."}
              </div>
            ) : (
              <ul className="divide-y divide-slate-100 border border-slate-200 rounded-md overflow-hidden">
                {originals.map((f) => (
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
            </>
            );
          })()}
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
                        {/* Response type expectation set by the underwriter
                            when the request was created. Reminds them what
                            they asked for so they can grade the reply. */}
                        {req.response_type && req.response_type !== "either" && (
                          <span className="text-[10px] uppercase tracking-widest font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                            {req.response_type === "docs" ? "Docs required" : "Text required"}
                          </span>
                        )}
                        <span className="text-[11px] text-slate-500">
                          Requested {req.requested_at ? new Date(req.requested_at).toLocaleString() : "—"}
                        </span>
                      </div>
                      {done && (
                        <span className="text-[11px] text-violet-700 font-semibold">
                          Responded {new Date(req.responded_at).toLocaleString()}
                          {req.response_channel && (
                            <span className="text-slate-400 font-normal"> · via {req.response_channel === "link" ? "email link" : "portal"}</span>
                          )}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 text-[13px] text-slate-800 whitespace-pre-line">
                      {req.note || <span className="text-slate-400 italic">no note provided</span>}
                    </div>
                    {/* Client's written reply, if they included one. */}
                    {done && req.response_note && (
                      <div className="mt-3 rounded-md border border-violet-200 bg-violet-50/60 px-3 py-2" data-testid={`info-request-reply-${req.id || i}`}>
                        <div className="text-[10px] uppercase tracking-widest font-semibold text-violet-700 mb-1">
                          Client's reply
                        </div>
                        <div className="text-[13px] text-slate-800 whitespace-pre-line">
                          {req.response_note}
                        </div>
                      </div>
                    )}
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
        </>
        )}

        {tab === "gateway" && (
          <GatewayKeysPanel
            info={gwKeys}
            onEdit={() => setShowGatewayKeys(true)}
            onRevoke={revokeGwKeys}
            working={working}
            cid={cid}
          />
        )}
      </div>

      <ApproveModal open={showApprove} onClose={() => setShowApprove(false)} onSubmit={approve} working={working} keysConfigured={!!gwKeys?.configured} />
      <DeclineModal open={showDecline} onClose={() => setShowDecline(false)} onSubmit={decline} working={working} />
      <RequestInfoModal open={showRequestInfo} onClose={() => setShowRequestInfo(false)} onSubmit={requestInfo} working={working} />
      <GatewayKeysModal
        open={showGatewayKeys}
        onClose={() => setShowGatewayKeys(false)}
        onSubmit={saveGwKeys}
        working={working}
        merchantName={detail.company_name || "this merchant"}
        initialEnvironment={gwKeys?.environment || "sandbox"}
        initialSurcharge={gwKeys?.surcharge_pct || 0}
        existingLast4={gwKeys?.configured ? gwKeys?.security_key_last4 : null}
      />
    </div>
  );
}

/**
 * GatewayKeysPanel — the third tab. Shows a masked view of the
 * merchant's stored NMI credentials (or an empty state prompting
 * the underwriter to set them). Everything is "replace-all" — the
 * underwriter either rotates all keys at once or revokes them.
 */
function GatewayKeysPanel({ info, onEdit, onRevoke, working, cid }) {
  const [copied, setCopied] = React.useState(false);
  if (!info) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm text-center text-slate-500" data-testid="gateway-keys-panel-loading">
        <Loader2 className="animate-spin inline mr-2" size={14} /> Loading credentials…
      </section>
    );
  }
  if (!info.configured) {
    // Empty state — no credentials yet. Pre-provisioning path.
    return (
      <section className="rounded-2xl border-2 border-dashed border-slate-300 bg-white p-8 shadow-sm text-center" data-testid="gateway-keys-panel-empty">
        <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 flex items-center justify-center">
          <Key size={20} className="text-slate-400" />
        </div>
        <h3 className="mt-3 text-lg font-bold text-slate-900">No gateway credentials yet</h3>
        <p className="mt-1 text-[13px] text-slate-500 max-w-md mx-auto">
          Once you've created a Merchant Gateway Account for this business in NMI's Partner Portal
          and generated the security &amp; tokenization keys, paste them here so we can process
          transactions on their behalf.
        </p>
        <button
          type="button"
          onClick={onEdit}
          className="mt-5 inline-flex items-center gap-2 px-5 py-2 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow"
          data-testid="btn-set-gateway-keys"
        >
          <Key size={13} /> Set credentials
        </button>
        <div className="mt-4 text-[11px] text-slate-400 max-w-sm mx-auto">
          You can set keys before approving — approval and credentials are decoupled.
        </div>
      </section>
    );
  }
  // Configured — masked view.
  const isLive = info.environment === "production";
  const envBadge = isLive
    ? { text: "LIVE · Production", cls: "bg-rose-600 text-white border-rose-700" }
    : { text: "TEST · Sandbox",    cls: "bg-amber-100 text-amber-800 border-amber-200" };
  const webhookUrl = `${process.env.REACT_APP_BACKEND_URL}/api/nmi/webhook/${cid}`;
  const webhookSecretSet = !!info.webhook_secret_last4;
  const webhookEverSeen  = !!info.webhook_last_received_at;
  const copyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* browser without clipboard perms — ignore */ }
  };
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm" data-testid="gateway-keys-panel">
      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-bold text-emerald-700">
            <ShieldCheck size={11} /> Gateway credentials on file
          </div>
          <div className="text-[13px] text-slate-500 mt-1">
            Encrypted at rest. Only decrypted server-side for API calls to NMI.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[11px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full border ${envBadge.cls}`}
                data-testid="gk-env-pill">
            {envBadge.text}
          </span>
        </div>
      </div>

      {/* Webhook status callout — optional-but-recommended. Soft
          nudge when the secret isn't set (nothing breaks — Direct Post
          keeps the ledger honest for card sales), and a separate soft
          nudge when the secret IS set but no webhook has landed yet
          (URL not wired in NMI's Merchant Portal). */}
      {!webhookSecretSet && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 flex items-start gap-2" data-testid="gk-webhook-warn">
          <AlertTriangle size={14} className="shrink-0 mt-0.5 text-amber-700" />
          <div className="text-[12px] text-amber-900 leading-relaxed">
            <b>No webhook signing secret on file.</b> Core payments still work — synchronous
            Direct Post responses keep the ledger accurate for in-app card sales, refunds, and
            voids. Add a secret if this merchant accepts <b>ACH</b>, may face <b>chargebacks</b>,
            or issues refunds directly inside <b>NMI's portal</b>. NMI's async settlement events
            will be rejected until then.
          </div>
        </div>
      )}
      {webhookSecretSet && !webhookEverSeen && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 flex items-start gap-2" data-testid="gk-webhook-not-received">
          <AlertTriangle size={14} className="shrink-0 mt-0.5 text-amber-700" />
          <div className="text-[12px] text-amber-900">
            <b>Signing secret is set, but we've never received a webhook.</b> Paste the URL below
            into NMI's Merchant Portal → <b>Options → Settings → Webhooks → Add</b> so async
            settlement / chargeback events land here.
          </div>
        </div>
      )}
      <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3" data-testid="gk-webhook-url-box">
        <div className="text-[10px] uppercase tracking-widest font-semibold text-slate-500 mb-1">
          Webhook URL for this merchant
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <code className="flex-1 min-w-0 text-[12px] font-mono text-slate-800 break-all bg-white border border-slate-200 rounded px-2 py-1">
            {webhookUrl}
          </code>
          <button
            type="button"
            onClick={copyWebhook}
            className="text-[12px] px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 inline-flex items-center gap-1 shrink-0"
            data-testid="gk-webhook-copy"
          >
            {copied ? <><Check size={11} /> Copied</> : <>Copy</>}
          </button>
        </div>
        <div className="text-[11px] text-slate-500 mt-1.5">
          {webhookEverSeen
            ? <>Last webhook received <b>{new Date(info.webhook_last_received_at).toLocaleString()}</b>.</>
            : <>Paste inside NMI's Merchant Portal → Options → Settings → Webhooks.</>}
        </div>
      </div>

      <dl className="divide-y divide-slate-100 border border-slate-200 rounded-md overflow-hidden">
        <KeyRow label="Security key (private)"
                masked value={info.security_key_last4}
                hint="Server-side — signs NMI Direct Post API calls." />
        <KeyRow label="Tokenization key (public)"
                value={info.tokenization_key_last4 ? `pub_key_ending_…${info.tokenization_key_last4}` : ""}
                hint="Browser-safe — used by Payment Component / Collect.js." />
        <KeyRow label="Processor / Gateway ID"
                value={info.nmi_processor_id || <span className="text-slate-400 italic">not set</span>}
                hint="Optional. Required for multi-processor merchants." />
        <KeyRow label="Webhook secret"
                masked value={info.webhook_secret_last4}
                hint="HMAC signing secret. Optional — recommended for ACH, chargebacks, and portal-initiated refunds." />
        <KeyRow label="Surcharge %"
                value={`${(info.surcharge_pct || 0).toFixed(2)}%`}
                hint="Applied to card transactions; waived for ACH." />
      </dl>

      {/* Environment history — the audit trail for sandbox↔production
          flips. Only rendered when there's more than the initial write
          to show, otherwise it's noise. */}
      {(info.env_history || []).length > 1 && (
        <details className="mt-4 rounded-md border border-slate-200 bg-slate-50" data-testid="gk-env-history">
          <summary className="cursor-pointer px-3 py-2 text-[12px] font-semibold text-slate-700">
            Environment history · {info.env_history.length} change{info.env_history.length === 1 ? "" : "s"}
          </summary>
          <ol className="px-3 pb-2 space-y-1">
            {[...info.env_history].reverse().map((h, i) => (
              <li key={i} className="text-[12px] text-slate-600 flex items-center gap-2">
                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                  h.env === "production" ? "bg-rose-100 text-rose-800" : "bg-amber-100 text-amber-800"
                }`}>{h.env}</span>
                {h.prior_env && <span className="text-slate-400">from <span className="line-through">{h.prior_env}</span></span>}
                <span className="ml-auto text-slate-400">{new Date(h.changed_at).toLocaleString()}</span>
              </li>
            ))}
          </ol>
        </details>
      )}

      <div className="mt-4 flex items-center justify-between flex-wrap gap-3 text-[12px] text-slate-500">
        <div>
          Keys last set <b>{info.set_at ? new Date(info.set_at).toLocaleString() : "—"}</b>
          {info.set_by_name && <> by <b>{info.set_by_name}</b></>}
          {info.rotation_count > 1 && <> · {info.rotation_count - 1} prior rotation{info.rotation_count - 1 === 1 ? "" : "s"}</>}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onEdit}
            disabled={working}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-emerald-300 text-emerald-700 bg-white hover:bg-emerald-50 text-[13px] font-semibold disabled:opacity-60"
            data-testid="btn-rotate-gateway-keys"
          >
            <RefreshCw size={12} /> Rotate keys
          </button>
          <button
            type="button"
            onClick={onRevoke}
            disabled={working}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-rose-300 text-rose-700 bg-white hover:bg-rose-50 text-[13px] font-semibold disabled:opacity-60"
            data-testid="btn-revoke-gateway-keys"
          >
            <Ban size={12} /> Revoke
          </button>
        </div>
      </div>
    </section>
  );
}

/** Two-line dt/dd row for the credentials list. */
function KeyRow({ label, value, hint, masked = false }) {
  const display = masked
    ? (value ? <span className="font-mono">{"•".repeat(20)}{value}</span> : <span className="text-slate-400 italic">not set</span>)
    : (value || <span className="text-slate-400 italic">not set</span>);
  return (
    <div className="flex items-start gap-4 px-4 py-3">
      <dt className="w-56 shrink-0 text-[12px] font-semibold text-slate-700">
        {label}
        {hint && <div className="text-[10px] font-normal text-slate-400 mt-0.5">{hint}</div>}
      </dt>
      <dd className="flex-1 text-[13px] text-slate-800 break-all">{display}</dd>
    </div>
  );
}

/**
 * TabButton — underline-style tab used to switch between Application
 * detail and the Documents view. Renders a small badge for counts.
 */
function TabButton({ active, onClick, testid, badge, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      className={`relative -mb-px inline-flex items-center gap-2 px-1 py-2.5 text-[13px] font-semibold transition ${
        active
          ? "text-slate-900 border-b-2 border-slate-900"
          : "text-slate-500 hover:text-slate-800 border-b-2 border-transparent"
      }`}
    >
      {children}
      {badge != null && badge > 0 && (
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
          active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
        }`}>
          {badge}
        </span>
      )}
    </button>
  );
}
