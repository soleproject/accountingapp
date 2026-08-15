import { useEffect, useRef, useState } from "react";
import { X, Bug, Lightbulb, Loader2, Paperclip, ImagePlus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

const ALLOWED_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_ONE = 5 * 1024 * 1024;   // 5MB / image
const MAX_TOTAL = 20 * 1024 * 1024; // 20MB / submission

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/**
 * FeedbackModal — Bug/Recommendation compose. Supports multiple image
 * attachments (via file picker, drag/drop, or paste) capped at 5MB each
 * and 20MB total. Auto-captures active route + company + user-agent.
 */
export default function FeedbackModal({ onClose, defaultType = "bug" }) {
  const { currentId } = useCompany() || {};
  const [type, setType] = useState(defaultType === "recommendation" ? "recommendation" : "bug");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [attachments, setAttachments] = useState([]); // [{id, filename, mime, size, data_url}]
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef(null);

  const route = typeof window !== "undefined"
    ? (window.location.pathname + window.location.search)
    : "";
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const isBug = type === "bug";

  const currentTotalBytes = attachments.reduce((a, b) => a + (b.size || 0), 0);

  const addFiles = async (files) => {
    const arr = Array.from(files || []);
    if (!arr.length) return;
    let total = currentTotalBytes;
    const next = [...attachments];
    for (const f of arr) {
      if (!ALLOWED_MIMES.includes(f.type)) {
        toast.error(`${f.name}: only PNG/JPG/GIF/WebP allowed`);
        continue;
      }
      if (f.size > MAX_ONE) {
        toast.error(`${f.name}: exceeds 5MB`);
        continue;
      }
      if (total + f.size > MAX_TOTAL) {
        toast.error("Attachments would exceed 20MB total");
        break;
      }
      try {
        const dataUrl = await readAsDataUrl(f);
        next.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          filename: f.name || "screenshot.png",
          mime: f.type,
          size: f.size,
          data_url: dataUrl,
        });
        total += f.size;
      } catch {
        toast.error(`Could not read ${f.name}`);
      }
    }
    setAttachments(next);
  };

  const onDrop = async (e) => {
    e.preventDefault();
    setDrag(false);
    await addFiles(e.dataTransfer?.files);
  };

  // Paste-from-clipboard support — anywhere inside the modal
  useEffect(() => {
    const onPaste = async (e) => {
      const items = e.clipboardData?.items || [];
      const files = [];
      for (const it of items) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        await addFiles(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line
  }, [attachments]);

  const removeAttachment = (id) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) { toast.error("Add a short title"); return; }
    setBusy(true);
    try {
      // Server accepts only filename/mime/data_url — trim client-only fields
      const payload = {
        type,
        title: title.trim(),
        description: description.trim(),
        route,
        user_agent: userAgent,
        company_id: currentId || null,
        attachments: attachments.map((a) => ({
          filename: a.filename,
          mime: a.mime,
          data_url: a.data_url,
        })),
      };
      await api.post("/feedback", payload);
      toast.success("Thanks — we got it. You can track it in your feedback inbox.");
      onClose && onClose();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't submit feedback");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[1100] bg-slate-900/50 flex items-center justify-center p-4"
      onClick={onClose}
      data-testid="feedback-modal-overlay"
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={`bg-white rounded-lg shadow-xl w-full max-w-md relative ${drag ? "ring-2 ring-cyan-400" : ""}`}
        data-testid="feedback-modal"
      >
        {drag && (
          <div className="absolute inset-0 bg-cyan-50/80 border-2 border-dashed border-cyan-400 rounded-lg flex items-center justify-center z-10 pointer-events-none">
            <div className="text-cyan-700 font-medium text-sm flex items-center gap-2">
              <ImagePlus size={18} /> Drop images to attach
            </div>
          </div>
        )}

        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-100">
          <div>
            <div className="font-heading font-semibold text-slate-900">
              Report a bug or recommendation
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              You'll be able to track its status in your{" "}
              <a href="/feedback/mine" className="underline hover:text-slate-700">
                feedback inbox
              </a>
              .
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100"
            data-testid="feedback-close-btn"
          >
            <X size={16} className="text-slate-500" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setType("bug")}
              data-testid="feedback-type-bug"
              className={`px-3 py-2.5 rounded-md border text-sm font-medium flex items-center justify-center gap-2 transition ${
                isBug
                  ? "border-rose-300 bg-rose-50 text-rose-700"
                  : "border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              <Bug size={14} /> Bug
            </button>
            <button
              type="button"
              onClick={() => setType("recommendation")}
              data-testid="feedback-type-recommendation"
              className={`px-3 py-2.5 rounded-md border text-sm font-medium flex items-center justify-center gap-2 transition ${
                !isBug
                  ? "border-cyan-300 bg-cyan-50 text-cyan-700"
                  : "border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              <Lightbulb size={14} /> Recommendation
            </button>
          </div>

          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Title
            </span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={isBug ? "What went wrong?" : "What would you like to see?"}
              maxLength={200}
              autoFocus
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400"
              data-testid="feedback-title"
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Description
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={isBug
                ? "What did you expect to happen? What happened instead? Steps to reproduce?"
                : "Describe the recommendation and the problem it solves."}
              rows={5}
              maxLength={5000}
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400 resize-none"
              data-testid="feedback-description"
            />
          </label>

          {/* Attachments */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Attachments
              </span>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="inline-flex items-center gap-1 text-[11px] text-cyan-700 hover:underline"
                data-testid="feedback-add-image"
              >
                <Paperclip size={11} /> Add image
              </button>
              <input
                ref={fileRef}
                type="file"
                accept={ALLOWED_MIMES.join(",")}
                multiple
                className="hidden"
                onChange={(e) => addFiles(e.target.files)}
                data-testid="feedback-file-input"
              />
            </div>
            {attachments.length === 0 ? (
              <div className="text-[11px] text-slate-400 border border-dashed border-slate-200 rounded p-2 text-center">
                Drop, paste, or click "Add image" — PNG/JPG/GIF/WebP up to 5MB each.
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2" data-testid="feedback-attachments-grid">
                {attachments.map((a) => (
                  <div key={a.id} className="relative group">
                    <img
                      src={a.data_url}
                      alt={a.filename}
                      className="w-full h-20 object-cover rounded border border-slate-200"
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.id)}
                      data-testid={`feedback-remove-attachment-${a.id}`}
                      className="absolute top-1 right-1 p-0.5 rounded-full bg-slate-900/80 text-white opacity-0 group-hover:opacity-100 transition"
                      title="Remove"
                    >
                      <X size={11} />
                    </button>
                    <div className="text-[10px] text-slate-500 mt-0.5 truncate">{a.filename}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="text-[11px] text-slate-500">
            Submitted from{" "}
            <code className="bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
              {route || "/"}
            </code>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-slate-100 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm text-slate-600 hover:bg-slate-100"
            data-testid="feedback-cancel-btn"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-md bg-cyan-600 text-white text-sm font-medium hover:bg-cyan-700 disabled:opacity-50"
            data-testid="feedback-submit-btn"
          >
            {busy && <Loader2 size={13} className="animate-spin" />} Submit
          </button>
        </div>
      </form>
    </div>
  );
}
