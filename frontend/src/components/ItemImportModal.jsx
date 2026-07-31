import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { UploadCloud, X, Loader2, CheckCircle2, AlertTriangle, FileSpreadsheet } from "lucide-react";

/**
 * Bulk-import items from CSV or Excel.
 *
 * Backend expects a `file` multipart field. We surface two toggles:
 *   - create_missing_accounts (default true): auto-create revenue /
 *     expense accounts on the fly when the source row references an
 *     account not yet in the CoA.
 *   - update_existing (default true): overwrite an existing item on
 *     name match; unchecking keeps the current record intact.
 */
export default function ItemImportModal({ currentId, onClose }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [createMissing, setCreateMissing] = useState(true);
  const [updateExisting, setUpdateExisting] = useState(true);
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);
  const dropRef = useRef(null);

  const onFile = (f) => {
    if (!f) return;
    const ok = /\.(csv|xls|xlsx|xlsm)$/i.test(f.name);
    if (!ok) { toast.error("Upload a .csv, .xlsx or .xls file"); return; }
    setFile(f);
    setResult(null);
  };

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("create_missing_accounts", createMissing ? "true" : "false");
      fd.append("update_existing", updateExisting ? "true" : "false");
      const r = await api.post(`/companies/${currentId}/items/import`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setResult(r.data);
      const { created, updated, skipped, errors } = r.data;
      if (errors?.length) {
        toast.warning(`Imported ${created} new, ${updated} updated · ${errors.length} error rows`);
      } else {
        toast.success(`Imported ${created} new, ${updated} updated${skipped ? `, ${skipped} skipped` : ""}`);
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || "Import failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5 space-y-4" data-testid="item-import-modal">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold inline-flex items-center gap-2">
            <FileSpreadsheet size={16} /> Bulk import items
          </h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>

        <p className="text-xs text-slate-500">
          Upload a CSV or Excel file. We auto-match columns:{" "}
          <b>Name, Description, Type, Account, Expense Account, Price, SKU, Active</b>.
        </p>

        <div
          ref={dropRef}
          onDragOver={(e) => { e.preventDefault(); dropRef.current?.classList.add("border-indigo-400", "bg-indigo-50"); }}
          onDragLeave={() => dropRef.current?.classList.remove("border-indigo-400", "bg-indigo-50")}
          onDrop={(e) => {
            e.preventDefault();
            dropRef.current?.classList.remove("border-indigo-400", "bg-indigo-50");
            onFile(e.dataTransfer.files?.[0]);
          }}
          onClick={() => inputRef.current?.click()}
          className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:border-slate-400 transition"
          data-testid="item-import-dropzone"
        >
          <UploadCloud size={26} className="mx-auto text-slate-400" />
          <div className="text-sm text-slate-600 mt-2">
            {file ? (
              <span className="font-medium text-slate-800">{file.name}</span>
            ) : (
              <>Click to browse or drop a file here</>
            )}
          </div>
          <div className="text-[10px] text-slate-400 mt-1">.csv · .xlsx · .xls</div>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xls,.xlsm"
            onChange={(e) => onFile(e.target.files?.[0])}
            className="hidden"
            data-testid="item-import-file"
          />
        </div>

        <div className="space-y-1.5 text-xs">
          <label className="flex items-center gap-2 text-slate-600">
            <input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)}
                   data-testid="item-import-create-accts" />
            Auto-create revenue &amp; expense accounts if they don't exist yet
          </label>
          <label className="flex items-center gap-2 text-slate-600">
            <input type="checkbox" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)}
                   data-testid="item-import-update-existing" />
            Update existing items with the same name
          </label>
        </div>

        {result && (
          <div className="rounded-lg border bg-slate-50 p-3 text-xs space-y-2" data-testid="item-import-result">
            <div className="flex items-center gap-4 flex-wrap">
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <CheckCircle2 size={12} /> Created <b className="font-mono-num">{result.created}</b>
              </span>
              <span className="inline-flex items-center gap-1 text-indigo-700">
                <CheckCircle2 size={12} /> Updated <b className="font-mono-num">{result.updated}</b>
              </span>
              {!!result.skipped && (
                <span className="inline-flex items-center gap-1 text-slate-500">
                  Skipped <b className="font-mono-num">{result.skipped}</b>
                </span>
              )}
              {!!(result.errors?.length) && (
                <span className="inline-flex items-center gap-1 text-amber-700">
                  <AlertTriangle size={12} /> {result.errors.length} error rows
                </span>
              )}
            </div>
            <div className="text-[10px] text-slate-500">
              Matched columns: {Object.entries(result.resolved_columns || {}).map(([k, v]) => `${k}=${v}`).join(" · ")}
            </div>
            {result.errors?.length ? (
              <ul className="text-[10px] text-amber-800 max-h-24 overflow-auto">
                {result.errors.slice(0, 8).map((er, i) => (
                  <li key={i}>Row {er.row}: {er.error}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {result ? (
            <button onClick={onClose}
                    className="px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm"
                    data-testid="item-import-done">Done</button>
          ) : (
            <button
              onClick={upload}
              disabled={!file || busy}
              className="px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm inline-flex items-center gap-1.5 disabled:opacity-60"
              data-testid="item-import-submit"
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              Import
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
