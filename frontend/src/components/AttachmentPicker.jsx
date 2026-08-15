import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Paperclip, X, ImagePlus } from "lucide-react";

const ALLOWED_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_ONE = 5 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/**
 * AttachmentPicker — reusable multi-image picker with drag-and-drop,
 * clipboard-paste, and thumbnail grid. Emits `{filename, mime, data_url}`
 * shaped items via `onChange`. Constraints: 5MB / image, 20MB total,
 * PNG/JPG/GIF/WebP only — matches the backend guardrails in feedback.py.
 *
 * `testIdPrefix` optional — data-testids default to `attach-*` and can be
 * scoped when multiple pickers live on one page (e.g. `reply-attach-*`).
 */
export default function AttachmentPicker({
  value,
  onChange,
  testIdPrefix = "attach",
  emptyHint = "Drop, paste, or click + to add screenshots.",
  compact = false,
}) {
  const attachments = value || [];
  const [drag, setDrag] = useState(false);
  const fileRef = useRef(null);

  const totalBytes = attachments.reduce((a, b) => a + (b.size || 0), 0);

  const addFiles = async (files) => {
    const arr = Array.from(files || []);
    if (!arr.length) return;
    let total = totalBytes;
    const next = [...attachments];
    for (const f of arr) {
      if (!ALLOWED_MIMES.includes(f.type)) { toast.error(`${f.name}: only PNG/JPG/GIF/WebP`); continue; }
      if (f.size > MAX_ONE) { toast.error(`${f.name}: exceeds 5MB`); continue; }
      if (total + f.size > MAX_TOTAL) { toast.error("Attachments would exceed 20MB"); break; }
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
      } catch { toast.error(`Could not read ${f.name}`); }
    }
    onChange(next);
  };

  const onDrop = async (e) => {
    e.preventDefault();
    setDrag(false);
    await addFiles(e.dataTransfer?.files);
  };

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
      if (files.length) { e.preventDefault(); await addFiles(files); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line
  }, [attachments]);

  const removeOne = (id) => onChange(attachments.filter((a) => a.id !== id));

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
      className={`relative ${drag ? "ring-2 ring-cyan-400 rounded" : ""}`}
      data-testid={`${testIdPrefix}-picker`}
    >
      {drag && (
        <div className="absolute inset-0 bg-cyan-50/80 border-2 border-dashed border-cyan-400 rounded flex items-center justify-center z-10 pointer-events-none">
          <div className="text-cyan-700 font-medium text-xs flex items-center gap-1">
            <ImagePlus size={14} /> Drop images
          </div>
        </div>
      )}
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Attachments {attachments.length ? `(${attachments.length})` : ""}
        </span>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-1 text-[11px] text-cyan-700 hover:underline"
          data-testid={`${testIdPrefix}-add-btn`}
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
          data-testid={`${testIdPrefix}-input`}
        />
      </div>
      {attachments.length === 0 ? (
        <div className="text-[11px] text-slate-400 border border-dashed border-slate-200 rounded p-2 text-center">
          {emptyHint}
        </div>
      ) : (
        <div className={`grid ${compact ? "grid-cols-4" : "grid-cols-3"} gap-2`}>
          {attachments.map((a) => (
            <div key={a.id} className="relative group">
              <img
                src={a.data_url}
                alt={a.filename}
                className={`w-full ${compact ? "h-16" : "h-20"} object-cover rounded border border-slate-200`}
              />
              <button
                type="button"
                onClick={() => removeOne(a.id)}
                data-testid={`${testIdPrefix}-remove-${a.id}`}
                className="absolute top-1 right-1 p-0.5 rounded-full bg-slate-900/80 text-white opacity-0 group-hover:opacity-100 transition"
                title="Remove"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
