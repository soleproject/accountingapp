/**
 * InfoRequestResponseCard — client-side widget shown when their app
 * is in `waiting_on_client` status. Renders the underwriter's note,
 * an expected-response-type badge, a multi-file drag-drop area, an
 * optional text-reply textarea, and a Send response button.
 *
 * Files upload immediately (per-file POST to /payments-app/upload)
 * so partial progress isn't lost if the tab closes. The final Send
 * click POSTs to /payments-app/submit with the text reply — the
 * backend's timestamp attribution picks up the staged files.
 *
 * The full wizard is still available as an escape hatch via
 * `onOpenFullWizard`.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  MessageSquareWarning, Upload, X, FileText, Send, ArrowRight,
  Loader2, CheckCircle2, AlertTriangle,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";

const TYPE_BADGE = {
  docs:   { text: "Documents required",   cls: "bg-orange-100 text-orange-800 border-orange-200" },
  text:   { text: "Written reply required", cls: "bg-orange-100 text-orange-800 border-orange-200" },
  either: { text: "Reply with details and/or files", cls: "bg-slate-100 text-slate-700 border-slate-200" },
};

export function InfoRequestResponseCard({ cid, request, onSent, onOpenFullWizard }) {
  const note      = request?.note || "";
  const respType  = request?.response_type || "either";
  const requestedAt = request?.requested_at;
  const [reply, setReply]         = useState("");
  const [staged, setStaged]       = useState([]);       // {id, name, size}
  const [uploading, setUploading] = useState(false);
  const [sending, setSending]     = useState(false);
  const [dragOver, setDragOver]   = useState(false);
  const inputRef = useRef(null);

  // On first mount, seed the staged list with any files the client
  // already uploaded during this waiting window (e.g. they refreshed
  // mid-response). We look for files uploaded strictly after the
  // request was made and not yet attached to a closed response.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await api.get(`/companies/${cid}/payments-app/files`);
        const files = r.data?.files || [];
        const cutoff = requestedAt ? new Date(requestedAt).getTime() : 0;
        const fresh = files
          .filter((f) => !f.is_deleted && new Date(f.uploaded_at).getTime() > cutoff)
          .map((f) => ({ id: f.id, name: f.original_filename, size: f.size }));
        if (!cancelled) setStaged(fresh);
      } catch { /* endpoint may not exist — that's OK, they'll re-upload */ }
    };
    load();
    return () => { cancelled = true; };
  }, [cid, requestedAt]);

  const uploadFiles = async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    // Upload sequentially so we can surface a per-file error without
    // aborting the whole batch. In practice this is fast enough for
    // any reasonable set of docs.
    for (const f of Array.from(fileList)) {
      try {
        const fd = new FormData();
        fd.append("file", f);
        const r = await api.post(`/companies/${cid}/payments-app/upload`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
        setStaged((prev) => [...prev, { id: r.data.id, name: r.data.name, size: r.data.size }]);
      } catch (e) {
        toast.error(`Couldn't upload ${f.name}: ${e?.response?.data?.detail || "try again"}`);
      }
    }
    setUploading(false);
  };

  const removeFile = async (fid) => {
    try {
      await api.delete(`/companies/${cid}/payments-app/files/${fid}`);
      setStaged((prev) => prev.filter((f) => f.id !== fid));
    } catch (e) {
      toast.error("Couldn't remove file");
    }
  };

  const canSend = (() => {
    const hasFiles = staged.length > 0;
    const hasReply = reply.trim().length > 0;
    if (respType === "docs")   return hasFiles;
    if (respType === "text")   return hasReply;
    return hasFiles || hasReply;   // either
  })();

  const send = async () => {
    setSending(true);
    try {
      await api.post(`/companies/${cid}/payments-app/submit`, {
        response_note: reply.trim() || null,
      });
      toast.success("Sent — your underwriter has been notified.");
      onSent && onSent();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't send response");
    } finally {
      setSending(false);
    }
  };

  const badge = TYPE_BADGE[respType] || TYPE_BADGE.either;

  return (
    <div
      className="rounded-3xl bg-white border border-orange-200 shadow-xl p-8 sm:p-10 relative overflow-hidden"
      data-testid="info-response-card"
    >
      <div className="pointer-events-none absolute -top-16 -right-16 w-64 h-64 rounded-full bg-orange-100 blur-3xl" />

      <div className="relative">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-orange-100 text-orange-700 px-2.5 py-1 text-[10px] uppercase tracking-widest font-semibold">
            <MessageSquareWarning size={11} /> Info requested
          </div>
          <div className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-widest font-semibold border ${badge.cls}`}
               data-testid="info-response-type-badge">
            {badge.text}
          </div>
        </div>

        <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold leading-tight tracking-tight text-slate-900">
          Your underwriter needs one more thing.
        </h1>

        {note && (
          <blockquote
            className="mt-4 border-l-4 border-orange-300 pl-4 py-2 text-slate-700 text-[14px] italic bg-orange-50/50 rounded-r whitespace-pre-line"
            data-testid="info-response-note"
          >
            {note}
          </blockquote>
        )}

        {/* -- Upload zone -------------------------------------------- */}
        {respType !== "text" && (
          <div className="mt-6">
            <div className="text-[11px] uppercase tracking-widest font-semibold text-slate-500 mb-1.5">
              Attach files {respType === "docs" && <span className="text-orange-600">*</span>}
            </div>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                uploadFiles(e.dataTransfer.files);
              }}
              onClick={() => inputRef.current?.click()}
              className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition ${
                dragOver
                  ? "border-orange-400 bg-orange-50"
                  : "border-slate-300 bg-slate-50/40 hover:border-slate-400"
              }`}
              data-testid="info-response-drop-zone"
            >
              <input
                ref={inputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => uploadFiles(e.target.files)}
                data-testid="info-response-file-input"
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
                    PDF, image, or Office docs · Add as many as you need before sending
                  </div>
                </>
              )}
            </div>

            {staged.length > 0 && (
              <ul className="mt-3 space-y-1.5" data-testid="info-response-staged-list">
                {staged.map((f) => (
                  <li key={f.id} className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5">
                    <FileText size={14} className="text-slate-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-slate-800 truncate">{f.name}</div>
                      {f.size ? (
                        <div className="text-[10px] text-slate-500">{(f.size / 1024).toFixed(1)} KB</div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(f.id)}
                      className="text-slate-400 hover:text-rose-600 shrink-0"
                      title="Remove"
                      data-testid={`info-response-file-remove-${f.id}`}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* -- Text reply --------------------------------------------- */}
        {respType !== "docs" && (
          <div className="mt-5">
            <div className="text-[11px] uppercase tracking-widest font-semibold text-slate-500 mb-1.5">
              Written reply {respType === "text" && <span className="text-orange-600">*</span>}
            </div>
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={4}
              placeholder={
                respType === "text"
                  ? "e.g. Yes, our DBA is registered as Northgate Consulting under a fictitious name statement filed in Massachusetts."
                  : "Optional — add any context your underwriter should know."
              }
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              data-testid="info-response-reply"
            />
          </div>
        )}

        {/* -- Actions ------------------------------------------------ */}
        <div className="mt-6 flex items-center justify-between gap-3 flex-wrap">
          <button
            type="button"
            onClick={onOpenFullWizard}
            className="text-[12px] text-slate-500 hover:text-slate-900 underline underline-offset-2"
            data-testid="info-response-open-wizard"
          >
            Or open the full application to edit any field
          </button>
          <button
            type="button"
            disabled={!canSend || sending || uploading}
            onClick={send}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-orange-600 hover:bg-orange-700 text-white font-semibold shadow disabled:opacity-50"
            data-testid="info-response-send"
          >
            {sending
              ? <><Loader2 size={14} className="animate-spin" /> Sending…</>
              : <><Send size={14} /> Send response</>}
          </button>
        </div>

        {/* Hint about why the button is disabled — reduces confusion. */}
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
  );
}
