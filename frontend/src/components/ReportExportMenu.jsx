import { useEffect, useRef, useState } from "react";
import { Download, ChevronDown, Printer, FileText, FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

/**
 * Report Export dropdown — mirrors the one on Trial Balance / Cash Flow /
 * Balance Sheet reports:
 *   • Download as PDF   → GET {basePath}/pdf → binary download
 *   • Download as CSV   → GET {basePath}/csv → binary download
 *   • Print (PDF)       → invokes window.print() so the browser's
 *                         print-to-PDF dialog renders ONLY the
 *                         `.print-report` region (everything else on
 *                         the page is hidden by `print:hidden` in the
 *                         parent + global print CSS in index.css).
 *
 * `basePath` should be a company-scoped API path like
 *   `/companies/{cid}/reports/ar-aging`
 * WITHOUT the `/api` prefix (handled by our shared `api` axios client)
 * and WITHOUT the `.pdf` / `.csv` suffix (appended here).
 *
 * `params` optional query params (as_of, start, end, etc.) appended to
 * both PDF and CSV requests.
 */
export default function ReportExportMenu({ basePath, filename = "report", params = {}, testIdPrefix = "report-export" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const download = async (ext) => {
    setOpen(false);
    try {
      const resp = await api.get(`${basePath}/${ext}`, { params, responseType: "blob" });
      const blob = new Blob([resp.data], { type: ext === "pdf" ? "application/pdf" : "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filename}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
    } catch (e) {
      toast.error(e.response?.data?.detail || `Failed to download ${ext.toUpperCase()}`);
    }
  };

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs hover:bg-slate-800"
        data-testid={`${testIdPrefix}-toggle`}
      >
        <Download size={13} /> Export <ChevronDown size={12} />
      </button>
      {open && (
        <div
          className="absolute right-0 mt-1 w-52 rounded-md border bg-white shadow-lg z-20 py-1"
          data-testid={`${testIdPrefix}-menu`}
        >
          <button
            onClick={() => download("pdf")}
            className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 inline-flex items-center gap-2"
            data-testid={`${testIdPrefix}-pdf`}
          >
            <FileText size={13} className="text-rose-600" /> Download as PDF
          </button>
          <button
            onClick={() => download("csv")}
            className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 inline-flex items-center gap-2"
            data-testid={`${testIdPrefix}-csv`}
          >
            <FileSpreadsheet size={13} className="text-emerald-600" /> Download as CSV
          </button>
          <div className="border-t my-1" />
          <button
            onClick={() => { setOpen(false); window.print(); }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 inline-flex items-center gap-2"
            data-testid={`${testIdPrefix}-print`}
          >
            <Printer size={13} className="text-slate-600" /> Print (PDF)
          </button>
        </div>
      )}
    </div>
  );
}
