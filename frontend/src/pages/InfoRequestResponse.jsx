/**
 * InfoRequestResponse — standalone response page reached via the
 * magic link in the underwriter's request-info email. No auth
 * wrapper, no sidebar; the signed token IS the credential.
 *
 * Route: /respond/:token
 *
 * Success path:
 *   1. Fetch /api/public/info-request/{token} → note, response_type, biz name
 *   2. Merchant uploads via /upload, types reply
 *   3. Submit via /respond → shows a Thank-you screen
 *
 * Failure paths:
 *   - 401 (bad signature) → "This link isn't valid"
 *   - 410 (expired / superseded) → "This link expired" + fallback link
 *   - 409 already responded → "We've already got your response"
 */
import React, { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import axios from "axios";
import {
  MessageSquareWarning, Upload, X, FileText, Send, Loader2,
  CheckCircle2, AlertTriangle, ShieldCheck,
} from "lucide-react";

const API = process.env.REACT_APP_BACKEND_URL;

const TYPE_BADGE = {
  docs:   { text: "Documents required",   cls: "bg-orange-100 text-orange-800 border-orange-200" },
  text:   { text: "Written reply required", cls: "bg-orange-100 text-orange-800 border-orange-200" },
  either: { text: "Reply with details and/or files", cls: "bg-slate-100 text-slate-700 border-slate-200" },
};

export default function InfoRequestResponse() {
  const { token } = useParams();
  const [state, setState] = useState({ loading: true, error: null, info: null });
  const [reply, setReply]         = useState("");
  const [staged, setStaged]       = useState([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending]     = useState(false);
  const [dragOver, setDragOver]   = useState(false);
  const [done, setDone]           = useState(false);
  const inputRef = useRef(null);

  // Initial fetch — decodes token server-side and returns the note.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await axios.get(`${API}/api/public/info-request/${token}`);
        if (!cancelled) setState({ loading: false, error: null, info: r.data });
        // Also seed the staged files list from anything already uploaded.
        try {
          const rf = await axios.get(`${API}/api/public/info-request/${token}/files`);
          if (!cancelled) setStaged((rf.data?.files || []).map((f) => ({ id: f.id, name: f.original_filename, size: f.size })));
        } catch { /* nothing staged yet — fine */ }
      } catch (e) {
        if (cancelled) return;
        const status = e?.response?.status;
        setState({
          loading: false,
          error: {
            status,
            message: e?.response?.data?.detail
              || (status === 410 ? "This link has expired."
                : status === 401 ? "This link isn't valid."
                : "Couldn't load your request."),
          },
          info: null,
        });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const uploadFiles = async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    for (const f of Array.from(fileList)) {
      try {
        const fd = new FormData();
        fd.append("file", f);
        const r = await axios.post(
          `${API}/api/public/info-request/${token}/upload`,
          fd,
          { headers: { "Content-Type": "multipart/form-data" } },
        );
        setStaged((prev) => [...prev, { id: r.data.id, name: r.data.name, size: r.data.size }]);
      } catch (e) {
        toast.error(`Couldn't upload ${f.name}: ${e?.response?.data?.detail || "try again"}`);
      }
    }
    setUploading(false);
  };

  const removeFile = async (fid) => {
    try {
      await axios.delete(`${API}/api/public/info-request/${token}/files/${fid}`);
      setStaged((prev) => prev.filter((f) => f.id !== fid));
    } catch { toast.error("Couldn't remove file"); }
  };

  const respType = state.info?.response_type || "either";
  const canSend = (() => {
    if (respType === "docs")   return staged.length > 0;
    if (respType === "text")   return reply.trim().length > 0;
    return staged.length > 0 || reply.trim().length > 0;
  })();

  const send = async () => {
    setSending(true);
    try {
      await axios.post(`${API}/api/public/info-request/${token}/respond`, {
        response_note: reply.trim() || null,
      });
      setDone(true);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't send response");
    } finally {
      setSending(false);
    }
  };

  // ---- Rendering states -----------------------------------------

  if (state.loading) {
    return (
      <FullPage>
        <Loader2 className="animate-spin text-slate-400" size={22} />
      </FullPage>
    );
  }

  if (state.error) {
    return (
      <FullPage>
        <div className="max-w-md text-center" data-testid="respond-error">
          <div className="w-14 h-14 mx-auto rounded-full bg-rose-50 flex items-center justify-center">
            <AlertTriangle className="text-rose-500" size={24} />
          </div>
          <h1 className="mt-4 text-2xl font-bold text-slate-900">
            {state.error.status === 410 ? "This link has expired" : "This link isn't valid"}
          </h1>
          <p className="mt-2 text-[14px] text-slate-500 leading-relaxed">
            {state.error.message} No worries — log into your app and head to <b>Get Paid Faster</b> to
            respond directly, or reply to the underwriter's email so they can send a fresh link.
          </p>
          <a
            href="/login"
            className="mt-6 inline-flex items-center gap-2 px-5 py-2 rounded-full bg-slate-900 text-white font-semibold shadow"
          >
            Log in to your app
          </a>
        </div>
      </FullPage>
    );
  }

  if (done || state.info?.already_responded) {
    return (
      <FullPage>
        <div className="max-w-md text-center" data-testid="respond-success">
          <div className="w-14 h-14 mx-auto rounded-full bg-emerald-50 flex items-center justify-center">
            <CheckCircle2 className="text-emerald-600" size={24} />
          </div>
          <h1 className="mt-4 text-2xl font-bold text-slate-900">
            {done ? "Response sent" : "You've already responded"}
          </h1>
          <p className="mt-2 text-[14px] text-slate-500 leading-relaxed">
            Thanks — your underwriter has been notified and will pick this up shortly.
            You can safely close this tab.
          </p>
        </div>
      </FullPage>
    );
  }

  const info = state.info;
  const badge = TYPE_BADGE[respType] || TYPE_BADGE.either;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-orange-50/40 py-10 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Trust header — tells the merchant this is legit and scoped. */}
        <div className="mb-4 flex items-center gap-2 text-slate-500 text-[12px]">
          <ShieldCheck size={13} className="text-emerald-500" />
          <span>Secure response link · scoped to <b className="text-slate-800">{info.business_name}</b> · single-use</span>
        </div>

        <div
          className="rounded-3xl bg-white border border-orange-200 shadow-xl p-8 sm:p-10 relative overflow-hidden"
          data-testid="respond-card"
        >
          <div className="pointer-events-none absolute -top-16 -right-16 w-64 h-64 rounded-full bg-orange-100 blur-3xl" />

          <div className="relative">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-orange-100 text-orange-700 px-2.5 py-1 text-[10px] uppercase tracking-widest font-semibold">
                <MessageSquareWarning size={11} /> Info requested
              </div>
              <div className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-widest font-semibold border ${badge.cls}`}
                   data-testid="respond-type-badge">
                {badge.text}
              </div>
            </div>

            <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold leading-tight tracking-tight text-slate-900">
              Your underwriter needs one more thing.
            </h1>

            {info.note && (
              <blockquote
                className="mt-4 border-l-4 border-orange-300 pl-4 py-2 text-slate-700 text-[14px] italic bg-orange-50/50 rounded-r whitespace-pre-line"
                data-testid="respond-note"
              >
                {info.note}
              </blockquote>
            )}

            {/* Upload zone */}
            {respType !== "text" && (
              <div className="mt-6">
                <div className="text-[11px] uppercase tracking-widest font-semibold text-slate-500 mb-1.5">
                  Attach files {respType === "docs" && <span className="text-orange-600">*</span>}
                </div>
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOver(false); uploadFiles(e.dataTransfer.files); }}
                  onClick={() => inputRef.current?.click()}
                  className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition ${
                    dragOver ? "border-orange-400 bg-orange-50" : "border-slate-300 bg-slate-50/40 hover:border-slate-400"
                  }`}
                  data-testid="respond-drop-zone"
                >
                  <input
                    ref={inputRef} type="file" multiple className="hidden"
                    onChange={(e) => uploadFiles(e.target.files)}
                    data-testid="respond-file-input"
                  />
                  {uploading ? (
                    <div className="text-[13px] text-slate-600 inline-flex items-center gap-2">
                      <Loader2 className="animate-spin" size={14} /> Uploading…
                    </div>
                  ) : (
                    <>
                      <Upload className="mx-auto text-slate-400" size={20} />
                      <div className="mt-1.5 text-[13px] font-semibold text-slate-800">
                        Drop files here or click to browse
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Add as many as you need before sending
                      </div>
                    </>
                  )}
                </div>

                {staged.length > 0 && (
                  <ul className="mt-3 space-y-1.5" data-testid="respond-staged-list">
                    {staged.map((f) => (
                      <li key={f.id} className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5">
                        <FileText size={14} className="text-slate-500 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium text-slate-800 truncate">{f.name}</div>
                          {f.size ? <div className="text-[10px] text-slate-500">{(f.size / 1024).toFixed(1)} KB</div> : null}
                        </div>
                        <button
                          type="button" onClick={() => removeFile(f.id)}
                          className="text-slate-400 hover:text-rose-600 shrink-0" title="Remove"
                          data-testid={`respond-file-remove-${f.id}`}
                        >
                          <X size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Written reply */}
            {respType !== "docs" && (
              <div className="mt-5">
                <div className="text-[11px] uppercase tracking-widest font-semibold text-slate-500 mb-1.5">
                  Written reply {respType === "text" && <span className="text-orange-600">*</span>}
                </div>
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  rows={4}
                  placeholder={respType === "text"
                    ? "e.g. Yes, our DBA is registered as Northgate Consulting under a fictitious name statement."
                    : "Optional — add any context your underwriter should know."}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  data-testid="respond-reply"
                />
              </div>
            )}

            <div className="mt-6 flex items-center justify-between gap-3 flex-wrap">
              <div className="text-[11px] text-slate-400">
                Prefer to update your full application? <a href="/login" className="underline underline-offset-2 hover:text-slate-700">Log in</a>.
              </div>
              <button
                type="button"
                disabled={!canSend || sending || uploading}
                onClick={send}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-orange-600 hover:bg-orange-700 text-white font-semibold shadow disabled:opacity-50"
                data-testid="respond-send"
              >
                {sending
                  ? <><Loader2 size={14} className="animate-spin" /> Sending…</>
                  : <><Send size={14} /> Send response</>}
              </button>
            </div>

            {!canSend && !sending && (
              <div className="mt-2 text-[11px] text-slate-500 flex items-center justify-end gap-1">
                <AlertTriangle size={11} />
                {respType === "docs" && "Attach at least one file to send."}
                {respType === "text" && "Add a written reply to send."}
                {respType === "either" && "Add a file or a written reply — either works."}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 text-center text-[11px] text-slate-400">
          You're responding on behalf of <b>{info.business_name}</b>. This link expires 7 days after
          it was sent and can only be used once.
        </div>
      </div>
    </div>
  );
}

function FullPage({ children }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-orange-50/40 flex items-center justify-center px-4 py-10">
      {children}
    </div>
  );
}
