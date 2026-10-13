import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

/** CSV / PDF download buttons for a report. `href` is the API path (without fmt). */
export function ExportButtons({ href, testid }) {
  const [busy, setBusy] = useState(null);
  const grab = async (fmt) => {
    setBusy(fmt);
    try {
      const r = await api.get(`${href}${href.includes("?") ? "&" : "?"}fmt=${fmt}`, { responseType: "blob" });
      const cd = r.headers?.["content-disposition"] || "";
      const name = /filename=([^;]+)/.exec(cd)?.[1]?.trim() || `report.${fmt}`;
      const url = URL.createObjectURL(r.data);
      const a = document.createElement("a"); a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch { toast.error(`Couldn't export ${fmt.toUpperCase()}`); }
    finally { setBusy(null); }
  };
  return (
    <span className="inline-flex rounded-md border border-slate-300 overflow-hidden text-xs font-semibold">
      {["csv", "pdf"].map((f, i) => (
        <button key={f} onClick={() => grab(f)} disabled={!!busy} data-testid={`${testid}-export-${f}`}
          className={`inline-flex items-center gap-1 px-2.5 py-1.5 bg-white hover:bg-slate-50 disabled:opacity-50 ${i ? "border-l border-slate-300" : ""}`}>
          {busy === f ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} {f.toUpperCase()}
        </button>
      ))}
    </span>
  );
}
