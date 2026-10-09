import { useEffect, useRef, useState } from "react";
import { Paperclip, FileText, X, Loader2, Camera } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";

const MAX_BYTES = 15 * 1024 * 1024;
const blobCache = new Map();

export const fmtSize = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function fetchBlobUrl(cid, fid) {
  if (blobCache.has(fid)) return blobCache.get(fid);
  const r = await api.get(`/companies/${cid}/client-messages/files/${fid}`, { responseType: "blob" });
  const url = URL.createObjectURL(r.data);
  blobCache.set(fid, url);
  return url;
}

/** Picks + uploads files for a message; returns pending refs to send with the message. */
export function useAttachments(cid) {
  const [pending, setPending] = useState([]);
  const pick = async (file) => {
    if (!file) return;
    if (!(file.type.startsWith("image/") || file.type === "application/pdf")) { toast.error("Only photos or PDFs"); return; }
    if (file.size > MAX_BYTES) { toast.error("File is larger than 15 MB"); return; }
    const tmp = `tmp-${Date.now()}`;
    const localUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
    setPending(p => [...p, { id: tmp, name: file.name, mime: file.type, size: file.size, uploading: true, localUrl }]);
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      const r = await api.post(`/companies/${cid}/client-messages/attachments`, fd, { headers: { "Content-Type": "multipart/form-data" } });
      setPending(p => p.map(a => a.id === tmp ? { ...r.data, localUrl } : a));
      if (localUrl) blobCache.set(r.data.id, localUrl);
    } catch (e) {
      setPending(p => p.filter(a => a.id !== tmp));
      toast.error(e?.response?.data?.detail || "Upload failed");
    }
  };
  const remove = (id) => setPending(p => p.filter(a => a.id !== id));
  const reset = () => setPending([]);
  const ready = pending.filter(a => !a.uploading).map(a => a.id);
  return { pending, pick, remove, reset, ready, busy: pending.some(a => a.uploading) };
}

/** Paperclip (and camera on touch devices) that feeds `pick`. */
export function AttachButton({ pick, disabled, testid }) {
  const fileRef = useRef(null);
  const camRef = useRef(null);
  return (
    <>
      <button type="button" onClick={() => fileRef.current?.click()} disabled={disabled} title="Attach a photo or PDF"
        className="h-10 w-10 shrink-0 rounded-full border border-slate-300 bg-white text-slate-600 hover:text-slate-900 hover:border-slate-400 flex items-center justify-center disabled:opacity-40 transition-colors" data-testid={`${testid}-attach`}>
        <Paperclip size={15} />
      </button>
      <button type="button" onClick={() => camRef.current?.click()} disabled={disabled} title="Take a photo"
        className="sm:hidden h-10 w-10 shrink-0 rounded-full border border-slate-300 bg-white text-slate-600 flex items-center justify-center disabled:opacity-40" data-testid={`${testid}-camera`}>
        <Camera size={15} />
      </button>
      <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" data-testid={`${testid}-attach-input`}
        onChange={e => { pick(e.target.files?.[0]); e.target.value = ""; }} />
      <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" data-testid={`${testid}-camera-input`}
        onChange={e => { pick(e.target.files?.[0]); e.target.value = ""; }} />
    </>
  );
}

/** Chips for files queued to send (with remove X). */
export function PendingAttachments({ pending, remove, testid }) {
  if (!pending.length) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-2" data-testid={`${testid}-pending`}>
      {pending.map(a => (
        <div key={a.id} className="relative flex items-center gap-2 pl-1.5 pr-7 py-1 rounded-lg border border-slate-200 bg-white text-[11px] text-slate-700 max-w-[220px]" data-testid={`${testid}-pending-item`}>
          {a.localUrl ? <img src={a.localUrl} alt="" className="h-8 w-8 rounded object-cover" /> : <FileText size={16} className="text-rose-500 shrink-0" />}
          <span className="truncate">{a.name}</span>
          {a.uploading ? <Loader2 size={12} className="absolute right-2 animate-spin text-slate-400" />
            : <button type="button" onClick={() => remove(a.id)} className="absolute right-1.5 p-0.5 text-slate-400 hover:text-red-600" aria-label="Remove"><X size={12} /></button>}
        </div>
      ))}
    </div>
  );
}

function AuthImage({ cid, att, className }) {
  const [url, setUrl] = useState(blobCache.get(att.id) || null);
  useEffect(() => { if (!url) fetchBlobUrl(cid, att.id).then(setUrl).catch(() => {}); }, [cid, att.id, url]);
  if (!url) return <div className={`${className} bg-slate-200 animate-pulse`} />;
  return <img src={url} alt={att.name} className={className} />;
}

/** Attachments rendered inside a chat bubble: image thumbnails + PDF chips. Click opens the file. */
export function AttachmentList({ atts, cid, mine, testid }) {
  if (!atts?.length) return null;
  const open = async (a) => {
    try { window.open(await fetchBlobUrl(cid, a.id), "_blank", "noopener"); }
    catch { toast.error("Couldn't open file"); }
  };
  return (
    <div className={`flex flex-wrap gap-2 ${mine ? "justify-end" : ""}`} data-testid={testid}>
      {atts.map(a => a.mime?.startsWith("image/") ? (
        <button key={a.id} type="button" onClick={() => open(a)} className="block rounded-xl overflow-hidden border border-slate-200 hover:opacity-90 transition-opacity" title={a.name} data-testid={`${testid}-image`}>
          <AuthImage cid={cid} att={a} className="h-32 w-32 object-cover" />
        </button>
      ) : (
        <button key={a.id} type="button" onClick={() => open(a)} className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-white text-left hover:border-slate-400 transition-colors max-w-[240px]" data-testid={`${testid}-file`}>
          <FileText size={18} className="text-rose-500 shrink-0" />
          <span className="min-w-0">
            <span className="block text-[12px] font-medium text-slate-800 truncate">{a.name}</span>
            <span className="block text-[10px] text-slate-500">PDF · {fmtSize(a.size)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
