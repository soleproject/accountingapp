import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Upload, Loader2, FileText, Trash2, ChevronRight, CheckCircle2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

/**
 * Bank-statement import tab (Veryfi).
 *
 * Multi-file drop zone → each file POSTs to /statements/upload → shows
 * "processing" pill until the backend returns → row moves to the imports
 * table. Auto-detect picks (or creates) the target CoA asset row from the
 * statement's bank name + last-4; user can override via the account
 * selector.
 */
export default function StatementsTab({ companyId }) {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState("auto");
  const [uploading, setUploading] = useState([]); // [{tempId, filename, size, status, error}]
  const [imports, setImports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  const loadAssets = useCallback(async () => {
    try {
      const r = await api.get(`/companies/${companyId}/accounts`);
      const list = (r.data.accounts || r.data || []).filter(a =>
        (a.type === "asset") && a.active !== false,
      );
      setAccounts(list);
    } catch { /* ignore */ }
  }, [companyId]);

  const loadImports = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get(`/companies/${companyId}/statements/imports`);
      setImports(r.data.imports || []);
    } catch (e) {
      toast.error(`Load imports failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;
    loadAssets();
    loadImports();
  }, [companyId, loadAssets, loadImports]);

  const uploadOne = async (file) => {
    const tempId = `${file.name}::${Date.now()}::${Math.random()}`;
    setUploading(u => [...u, {
      tempId, filename: file.name, size: file.size,
      status: "processing", error: null,
    }]);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (accountId && accountId !== "auto") fd.append("account_id", accountId);
      const r = await api.post(
        `/companies/${companyId}/statements/upload`, fd,
        { headers: { "Content-Type": "multipart/form-data" }, timeout: 180_000 },
      );
      setUploading(u => u.map(x => x.tempId === tempId
        ? { ...x, status: "completed",
            importId: r.data.import_id,
            transactionCount: r.data.transaction_count,
            accountName: r.data.account?.name,
            last4: r.data.last4 }
        : x));
      toast.success(
        `${file.name} → ${r.data.transaction_count} txns` +
        (r.data.account ? ` · ${r.data.account.name}` : "") +
        (r.data.account?.matched === false ? " (new account)" : ""),
        { duration: 6000 },
      );
      loadImports();
    } catch (e) {
      const msg = e.response?.data?.detail || e.message;
      setUploading(u => u.map(x => x.tempId === tempId
        ? { ...x, status: "failed", error: msg } : x));
      toast.error(`${file.name}: ${msg}`);
    }
  };

  const onFiles = async (files) => {
    const arr = Array.from(files || []);
    if (!arr.length) return;
    const oversized = arr.filter(f => f.size > 25 * 1024 * 1024);
    if (oversized.length) {
      toast.error(`Too large (>25 MB): ${oversized.map(f => f.name).join(", ")}`);
      return;
    }
    for (const f of arr) uploadOne(f);
  };

  const clearCompleted = () => {
    setUploading(u => u.filter(x => x.status === "processing"));
  };

  const onDeleteImport = async (id, filename, count) => {
    if (!confirm(
      `Delete ${filename}? This will remove all ${count ?? "0"} transactions ` +
      `it produced.`,
    )) return;
    try {
      await api.delete(`/companies/${companyId}/statements/imports/${id}`);
      toast.success(`Deleted ${filename}`);
      loadImports();
    } catch (e) {
      toast.error(`Delete failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const activeUploads = uploading.filter(x => x.status === "processing");
  const finishedUploads = uploading.filter(x => x.status !== "processing");

  return (
    <div className="space-y-4" data-testid="statements-tab">
      <div className="rounded-xl border bg-white p-5">
        <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
          <div>
            <h3 className="font-heading font-semibold text-lg">Upload bank statements</h3>
            <p className="text-sm text-slate-500 mt-1 max-w-2xl">
              Drop PDFs (or images) of bank statements. Veryfi extracts every transaction,
              our AI resolver auto-matches (or creates) the target bank account,
              and every line is auto-posted to the ledger.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-slate-500">Bank account</span>
            <select
              data-testid="stmt-account-select"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm min-w-[240px]"
            >
              <option value="auto">Auto-detect from statement</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div
          data-testid="stmt-dropzone"
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            onFiles(e.dataTransfer.files);
          }}
          className={
            "flex flex-col items-center justify-center gap-2 rounded-lg " +
            "border-2 border-dashed p-10 text-center cursor-pointer " +
            "transition-colors " +
            (dragOver
              ? "border-cyan-500 bg-cyan-50/60 text-cyan-800"
              : "border-blue-400 bg-blue-50/40 text-blue-700 hover:bg-blue-50/70")
          }
        >
          <Upload size={40} strokeWidth={1.5} aria-hidden="true" />
          <div className="text-base font-medium">
            Drop bank statements here, or click to browse
          </div>
          <div className="text-xs text-slate-500">
            PDF · JPG · PNG · up to 25 MB · multiple files OK
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="application/pdf,image/jpeg,image/png,image/jpg"
            className="hidden"
            onChange={(e) => onFiles(e.target.files)}
          />
        </div>

        {(activeUploads.length + finishedUploads.length) > 0 && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold">
                Uploads
              </div>
              {finishedUploads.length > 0 && (
                <button
                  onClick={clearCompleted}
                  className="text-xs text-slate-500 hover:text-slate-800 underline"
                >
                  Clear completed
                </button>
              )}
            </div>
            <div className="space-y-1">
              {uploading.map(x => (
                <UploadRow key={x.tempId} entry={x} onOpen={(id) =>
                  navigate(`/connections/imports/${id}`)} />
              ))}
            </div>
          </div>
        )}
      </div>

      <ImportsTable
        loading={loading}
        rows={imports}
        onOpen={(id) => navigate(`/connections/imports/${id}`)}
        onDelete={onDeleteImport}
      />
    </div>
  );
}

function UploadRow({ entry, onOpen }) {
  const size = entry.size ? `${(entry.size / 1024).toFixed(0)} KB` : "";
  return (
    <div className="flex items-center gap-3 rounded-md border bg-slate-50/50 px-3 py-2 text-sm">
      <FileText size={16} className="text-slate-400" />
      <div className="flex-1 truncate">{entry.filename}</div>
      <span className="text-xs text-slate-400 font-mono-num">{size}</span>
      {entry.status === "processing" && (
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
          <Loader2 size={12} className="animate-spin" /> processing
        </span>
      )}
      {entry.status === "completed" && (
        <>
          {entry.accountName && (
            <span className="text-xs text-slate-600 truncate max-w-[220px]" title={entry.accountName}>
              ↳ {entry.accountName}
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
            <CheckCircle2 size={12} /> {entry.transactionCount} txns
          </span>
          <button
            onClick={() => entry.importId && onOpen(entry.importId)}
            className="text-xs text-cyan-700 hover:underline"
          >
            View
          </button>
        </>
      )}
      {entry.status === "failed" && (
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-800" title={entry.error}>
          failed
        </span>
      )}
    </div>
  );
}

function ImportsTable({ loading, rows, onOpen, onDelete }) {
  return (
    <div className="rounded-xl border bg-white overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left">
          <tr className="text-xs uppercase tracking-wide text-slate-500">
            <th className="px-4 py-2 font-medium">When</th>
            <th className="px-4 py-2 font-medium">File</th>
            <th className="px-4 py-2 font-medium">Account</th>
            <th className="px-4 py-2 font-medium">Method</th>
            <th className="px-4 py-2 font-medium text-right">#</th>
            <th className="px-4 py-2 font-medium">Range</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 text-right"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">
              <Loader2 size={16} className="inline-block animate-spin mr-2" />Loading…
            </td></tr>
          )}
          {!loading && rows.length === 0 && (
            <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">
              No imports yet.
            </td></tr>
          )}
          {!loading && rows.map(r => (
            <tr key={r.id}
                className="border-t border-slate-100 hover:bg-slate-50 transition-colors cursor-pointer"
                onClick={() => onOpen(r.id)}
                data-testid={`stmt-import-row-${r.id}`}>
              <td className="px-4 py-2 tabular-nums text-slate-700">
                {r.created_at ? new Date(r.created_at).toLocaleDateString() : "—"}
              </td>
              <td className="px-4 py-2 text-slate-700 max-w-[280px] truncate" title={r.filename}>
                {r.filename ?? "—"}
              </td>
              <td className="px-4 py-2 text-slate-700 max-w-[240px] truncate" title={r.account_name}>
                {r.account_name ?? "—"}
              </td>
              <td className="px-4 py-2 text-slate-500 font-mono-num text-xs">
                {r.method}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                {r.transaction_count ?? "—"}
              </td>
              <td className="px-4 py-2 text-slate-700 tabular-nums text-xs">
                {r.period_start && r.period_end ? `${r.period_start} → ${r.period_end}` : "—"}
              </td>
              <td className="px-4 py-2">
                <StatusPill status={r.status} />
              </td>
              <td className="px-4 py-2 text-right">
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(r.id, r.filename, r.transaction_count); }}
                  className="text-slate-400 hover:text-red-600"
                  title="Delete import"
                  data-testid={`stmt-import-delete-${r.id}`}
                >
                  <Trash2 size={14} />
                </button>
                <ChevronRight size={14} className="inline-block ml-2 text-slate-300" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    completed: "bg-emerald-100 text-emerald-800",
    processing: "bg-amber-100 text-amber-800",
    failed: "bg-red-100 text-red-800",
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${map[status] ?? "bg-slate-100 text-slate-700"}`}>
      {status ?? "—"}
    </span>
  );
}
