import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Upload, Loader2, FileText, Trash2, ChevronRight, CheckCircle2, RotateCw, X } from "lucide-react";
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
export default function StatementsTab({ companyId, bare = false }) {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState("auto");
  const [uploading, setUploading] = useState([]); // [{tempId, filename, size, status, error}]
  const [imports, setImports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);
  // Pre-upload confirmation modal state. `pending` holds the files the
  // user just dropped/browsed. `skipModal` sticks their per-batch choice
  // so a 20-statement drop from the same account doesn't ask 20 times.
  const [pending, setPending] = useState(null); // { files: File[], defaultChoice: string }
  const [modalChoice, setModalChoice] = useState("auto");
  const [skipModal, setSkipModal] = useState(false);
  // Multi-statement PDF (Veryfi splitter) toggle. Default OFF — users
  // must explicitly confirm they're uploading a combined-statement file
  // to avoid burning splitter credits on regular monthly statements.
  // Auto-forced ON in the modal when the dropped file is a .zip.
  const [modalIsMulti, setModalIsMulti] = useState(false);

  const loadAssets = useCallback(async () => {
    try {
      const r = await api.get(`/companies/${companyId}/accounts`);
      // Include BOTH assets (bank/cash) and liabilities (credit cards,
      // loans, LOCs) — a statement upload may target either side. UI
      // groups them so the user sees "Bank accounts" and "Credit / Loans"
      // in separate optgroups.
      const list = (r.data.accounts || r.data || []).filter(a =>
        (a.type === "asset" || a.type === "liability") && a.active !== false,
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

  const uploadOne = async (file, tempId = null, kindHintOverride = null, isMulti = false) => {
    // Reused for both first-time upload and retry — passing an existing
    // tempId flips the row back to "processing" instead of creating a new
    // one so ordering and any prior error state are preserved.
    // `kindHintOverride` (from the pre-upload modal) forces the resolver
    // to the specified account_kind_hint regardless of the top-of-page
    // dropdown value — used when the user confirms per-file that "this
    // is a credit card" or "this is a bank account".
    // `isMulti` routes the file to Veryfi's async splitter endpoint —
    // used when the user ticks "This PDF contains multiple statements".
    const id = tempId || `${file.name}::${Date.now()}::${Math.random()}`;
    if (tempId) {
      setUploading(u => u.map(x => x.tempId === tempId
        ? { ...x, status: "processing", error: null } : x));
    } else {
      setUploading(u => [...u, {
        tempId: id, filename: file.name, size: file.size,
        // Keep the raw File on the entry so a Retry can re-POST it
        // without asking the user to re-select. This does hold the file
        // in memory until the row is dismissed or the tab is left.
        file, status: "processing", error: null,
      }]);
    }
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (isMulti) fd.append("is_multi_statement", "true");
      // Precedence: per-file modal override > top-of-page dropdown.
      const effectiveAccountId = kindHintOverride ?? accountId;
      if (effectiveAccountId && !String(effectiveAccountId).startsWith("auto")) {
        fd.append("account_id", effectiveAccountId);
      } else if (effectiveAccountId === "auto-asset") {
        fd.append("account_kind_hint", "asset");
      } else if (effectiveAccountId === "auto-liability") {
        fd.append("account_kind_hint", "liability");
      }
      const r = await api.post(
        `/companies/${companyId}/statements/upload`, fd,
        { headers: { "Content-Type": "multipart/form-data" }, timeout: 180_000 },
      );
      // Multi-statement path returns immediately with `status: 'splitting'`
      // and no txn count yet. Individual child statements land later via
      // Veryfi webhook — the imports table polls to surface them.
      if (r.data?.status === "splitting") {
        setUploading(u => u.map(x => x.tempId === id
          ? { ...x, file: null, status: "splitting",
              importId: r.data.import_id }
          : x));
        toast.success(
          `${file.name} → sent to Veryfi splitter. Individual statements will ` +
          `appear below as each finishes (typically 1–3 min).`,
          { duration: 8000 },
        );
        // Poll for children while the splitter runs. Refreshes the
        // imports table every 8s for ~5 min, stops early if the parent
        // row flips off "splitting".
        _startSplitPoll(r.data.import_id);
        loadImports();
        return;
      }
      setUploading(u => u.map(x => x.tempId === id
        ? { ...x, file: null, status: "completed",
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
      // Auto-opening-balance JE feedback — when the first statement for a
      // bank account lands (or a NEWER earliest arrives), the backend
      // upserts a system-managed Opening Balance Equity JE so the ledger
      // baseline matches reality without the user hunting down closing
      // balances by hand.
      const obe = r.data.opening_balance_je;
      if (obe?.ok && obe.action === "upserted" && obe.amount) {
        toast.success(
          `Auto-posted opening balance of $${Math.abs(obe.amount).toLocaleString(
            undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 },
          )} on ${obe.as_of} so your ledger baseline matches the statement.`,
          { duration: 8000 },
        );
      } else if (obe && obe.reason === "closed_period") {
        toast.warning(
          `Couldn't auto-post opening balance — ${obe.target_date} falls in a closed period. Reopen the period or post the JE manually.`,
          { duration: 8000 },
        );
      }
      loadImports();
    } catch (e) {
      const msg = e.response?.data?.detail || e.message;
      setUploading(u => u.map(x => x.tempId === id
        ? { ...x, status: "failed", error: msg } : x));
      toast.error(`${file.name}: ${msg}`);
    }
  };

  const retryUpload = (tempId) => {
    // Look up the row and re-post its stashed File. Guard against the
    // (rare) case where `file` was cleared — e.g. row was somehow
    // completed then reverted — by warning instead of silently failing.
    const row = uploading.find(x => x.tempId === tempId);
    if (!row?.file) {
      toast.error("Can't retry — original file is no longer in memory. Please re-drop it.");
      return;
    }
    uploadOne(row.file, tempId);
  };

  const dismissUpload = (tempId) => {
    setUploading(u => u.filter(x => x.tempId !== tempId));
  };

  const onFiles = async (files) => {
    const arr = Array.from(files || []);
    if (!arr.length) return;
    const oversized = arr.filter(f => f.size > 50 * 1024 * 1024);
    if (oversized.length) {
      toast.error(`Too large (>50 MB): ${oversized.map(f => f.name).join(", ")}`);
      return;
    }
    // If the user pinned a real account via the top-of-page dropdown OR
    // ticked "don't ask again for this batch", skip the modal.
    if ((accountId && !String(accountId).startsWith("auto")) || skipModal) {
      startUploads(arr, accountId, false);
      return;
    }
    // Otherwise raise the confirmation modal — preseed to the current
    // dropdown value so a user who set "credit card or loan" up top sees
    // that pre-selected in the modal and can just hit Start. The plain
    // "auto" default falls back to asset since we removed the "let AI
    // decide" option from the modal (the user must make an explicit
    // choice here to prevent misfires).
    const preseed = accountId === "auto-liability" ? "auto-liability" : "auto-asset";
    setModalChoice(preseed);
    // Multi-statement toggle: default OFF, auto-force ON for .zip files
    // (Veryfi splitter accepts .pdf and .zip; .zip is always multi).
    setModalIsMulti(arr.some(f => (f.name || "").toLowerCase().endsWith(".zip")));
    setPending({ files: arr });
  };

  // Actually kicks off the throttled upload workers. Extracted so both
  // the direct-path (pinned account / skipModal) and the modal-confirmed
  // path can share the exact same throttling logic.
  const startUploads = (arr, hint, isMulti) => {
    (async () => {
      const queue = [...arr];
      const CONCURRENCY = 2;
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (queue.length) {
          const f = queue.shift();
          if (f) await uploadOne(f, null, hint, isMulti);
        }
      });
      await Promise.all(workers);
    })();
  };

  // Polls the imports endpoint every 8s while a splitter parent row is
  // still in ``splitting`` status. Stops once the parent flips to
  // completed / partial / failed OR after ~5 min (safety cap so a
  // stuck webhook doesn't leave a poll running forever).
  const _startSplitPoll = (parentImportId) => {
    const startedAt = Date.now();
    const iv = setInterval(async () => {
      // 5-minute cap.
      if (Date.now() - startedAt > 5 * 60 * 1000) { clearInterval(iv); return; }
      try {
        const r = await api.get(`/companies/${companyId}/statements/imports`);
        setImports(r.data.imports || []);
        const parent = (r.data.imports || []).find(x => x.id === parentImportId);
        if (parent && parent.status !== "splitting") {
          clearInterval(iv);
        }
      } catch { /* keep polling — transient errors */ }
    }, 8000);
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

  const reprocessImport = async (row) => {
    // Prompt for the corrected hint. Uses window.prompt to keep the
    // implementation dependency-free — the pre-upload modal is where the
    // primary "pick the account type" UX lives; this is the escape hatch
    // for after-the-fact fixes.
    const choice = window.prompt(
      `Reprocess "${row.filename}" as which type?\n\n` +
      `  1  = Bank / Cash account (asset)\n` +
      `  2  = Credit Card / Loan / LOC (liability)\n` +
      `  3  = Let AI decide (auto-detect)\n\n` +
      `This will delete the current ${row.transaction_count ?? 0} transactions ` +
      `and re-run the resolver.`,
      "2",
    );
    const map = { "1": "asset", "2": "liability", "3": "auto" };
    const hint = map[String(choice || "").trim()];
    if (!hint) return;
    if (!confirm(
      `Really reprocess ${row.filename}? All ${row.transaction_count ?? 0} ` +
      `transactions from this import will be deleted and re-created against ` +
      `the ${hint === "liability" ? "liability" : hint === "asset" ? "asset" : "auto-detected"} branch.`,
    )) return;
    const fd = new FormData();
    fd.append("account_kind_hint", hint);
    try {
      const r = await api.post(
        `/companies/${companyId}/statements/imports/${row.id}/reprocess`,
        fd, { headers: { "Content-Type": "multipart/form-data" } },
      );
      const d = r.data || {};
      toast.success(
        `Reprocessed as "${d.new_account_name}" (${d.new_account_type}). ` +
        `${d.reinserted} transactions re-created` +
        (d.coa_row_deleted ? `, cleaned up "${d.coa_row_deleted}".` : "."),
        { duration: 8000 },
      );
      loadImports();
    } catch (e) {
      toast.error(`Reprocess failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const activeUploads = uploading.filter(x => x.status === "processing");
  const finishedUploads = uploading.filter(x => x.status !== "processing");

  return (
    <div className="space-y-4" data-testid="statements-tab">
      <div className={bare ? "" : "rounded-xl border bg-white p-5"}>
        <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
          {/* Standalone (Connections → Statements) keeps the heading +
              intro copy for context. When rendered `bare` inside the
              onboarding stepper the parent already provides its own
              heading and a friendlier intro, so we omit ours to avoid
              a duplicated section. */}
          {!bare ? (
            <div>
              <h3 className="font-heading font-semibold text-lg">Upload bank statements</h3>
              <p className="text-sm text-slate-500 mt-1 max-w-2xl">
                Drop PDFs (or images) of bank statements. Our AI extracts every transaction,
                auto-matches (or creates) the target bank account,
                and every line is auto-posted to the ledger.
              </p>
            </div>
          ) : <div />}
          <label className="flex items-center gap-2 text-sm">
            <span className="text-slate-500">Bank account</span>
            <select
              data-testid="stmt-account-select"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm min-w-[280px]"
            >
              <optgroup label="Auto-detect">
                <option value="auto">Auto-detect from statement</option>
                <option value="auto-asset">This is a bank / cash account</option>
                <option value="auto-liability">This is a credit card or loan</option>
              </optgroup>
              {accounts.some(a => a.type === "asset") && (
                <optgroup label="Bank accounts">
                  {accounts.filter(a => a.type === "asset").map(a => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {accounts.some(a => a.type === "liability") && (
                <optgroup label="Credit cards & loans">
                  {accounts.filter(a => a.type === "liability").map(a => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </optgroup>
              )}
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
                <UploadRow key={x.tempId} entry={x}
                  onOpen={(id) => navigate(`/connections/imports/${id}`)}
                  onRetry={retryUpload}
                  onDismiss={dismissUpload} />
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
        onReprocess={reprocessImport}
      />

      {pending && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="stmt-precheck-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50"
          onClick={() => setPending(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-[520px] max-w-[90vw] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm text-slate-500 mb-1">
              About to import <b>{pending.files.length}</b>{" "}
              file{pending.files.length === 1 ? "" : "s"}
            </div>
            <h3 className="text-lg font-semibold mb-1">What kind of statement is this?</h3>
            <p className="text-xs text-slate-500 mb-4">
              Picking correctly here prevents the OCR from creating a wrong-type
              account (e.g. an Amex card mistakenly booked as Checking).
            </p>
            <div className="space-y-2">
              {[
                { v: "auto-asset",     label: "Bank / Cash account",       hint: "Checking, Savings, Money Market — an ASSET" },
                { v: "auto-liability", label: "Credit Card / Loan / LOC",  hint: "Any account that represents money you OWE — a LIABILITY" },
              ].map(o => (
                <label
                  key={o.v}
                  data-testid={`stmt-precheck-opt-${o.v}`}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${modalChoice === o.v ? "border-indigo-500 bg-indigo-50" : "border-slate-200 hover:bg-slate-50"}`}
                >
                  <input
                    type="radio"
                    name="stmt-kind"
                    value={o.v}
                    checked={modalChoice === o.v}
                    onChange={() => setModalChoice(o.v)}
                    className="mt-0.5"
                  />
                  <div className="text-sm leading-snug">
                    <div className="font-medium text-slate-800">{o.label}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{o.hint}</div>
                  </div>
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2 mt-4 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={modalIsMulti}
                onChange={(e) => setModalIsMulti(e.target.checked)}
                data-testid="stmt-precheck-multi-toggle"
              />
              <span>
                <b>This PDF contains multiple statements</b> — use Veryfi&apos;s
                auto-splitter (recommended for year-end catch-up or shoebox
                PDFs). Off by default; auto-on for <code>.zip</code>.
              </span>
            </label>
            <label className="flex items-center gap-2 mt-2 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={skipModal}
                onChange={(e) => setSkipModal(e.target.checked)}
                data-testid="stmt-precheck-skip-toggle"
              />
              Don't ask again for this batch (uses this choice for every file)
            </label>
            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={() => { setPending(null); setSkipModal(false); setModalIsMulti(false); }}
                className="px-3 py-1.5 text-sm rounded-md border border-slate-300 hover:bg-slate-50"
                data-testid="stmt-precheck-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const files = pending.files;
                  const choice = modalChoice;
                  const isMulti = modalIsMulti;
                  setPending(null);
                  setModalIsMulti(false);
                  startUploads(files, choice, isMulti);
                }}
                className="px-4 py-1.5 text-sm rounded-md bg-slate-900 text-white hover:bg-slate-800"
                data-testid="stmt-precheck-confirm"
              >
                Start processing
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function UploadRow({ entry, onOpen, onRetry, onDismiss }) {
  const size = entry.size ? `${(entry.size / 1024).toFixed(0)} KB` : "";
  return (
    <div className="rounded-md border bg-slate-50/50 px-3 py-2 text-sm">
      <div className="flex items-center gap-3">
        <FileText size={16} className="text-slate-400 shrink-0" />
        <div className="flex-1 truncate">{entry.filename}</div>
        <span className="text-xs text-slate-400 font-mono-num">{size}</span>
        {entry.status === "processing" && (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
            <Loader2 size={12} className="animate-spin" /> processing
          </span>
        )}
        {entry.status === "splitting" && (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800">
            <Loader2 size={12} className="animate-spin" /> splitting (multi-statement)
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
          <>
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-800">
              failed
            </span>
            {onRetry && entry.file && (
              <button
                onClick={() => onRetry(entry.tempId)}
                className="inline-flex items-center gap-1 text-xs text-cyan-700 hover:text-cyan-900 hover:underline"
                title="Retry this upload"
                data-testid={`stmt-retry-${entry.tempId}`}
              >
                <RotateCw size={12} /> Retry
              </button>
            )}
            {onDismiss && (
              <button
                onClick={() => onDismiss(entry.tempId)}
                className="text-slate-400 hover:text-slate-700"
                title="Dismiss this row"
                aria-label="Dismiss"
                data-testid={`stmt-dismiss-${entry.tempId}`}
              >
                <X size={14} />
              </button>
            )}
          </>
        )}
      </div>
      {entry.status === "failed" && entry.error && (
        <div className="mt-1 ml-7 text-[11px] text-red-700 leading-snug">
          {entry.error}
        </div>
      )}
    </div>
  );
}

function ImportsTable({ loading, rows, onOpen, onDelete, onReprocess }) {
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
                className={
                  "border-t border-slate-100 hover:bg-slate-50 transition-colors cursor-pointer " +
                  (r.parent_import_id ? "bg-slate-50/40" : "")
                }
                onClick={() => onOpen(r.id)}
                data-testid={`stmt-import-row-${r.id}`}>
              <td className="px-4 py-2 tabular-nums text-slate-700">
                {r.created_at ? new Date(r.created_at).toLocaleDateString() : "—"}
              </td>
              <td className="px-4 py-2 text-slate-700 max-w-[280px] truncate" title={r.filename}>
                {r.parent_import_id && (
                  <span className="text-slate-400 mr-1" title="Split from a multi-statement PDF">↳</span>
                )}
                {r.filename ?? "—"}
                {r.is_multi && (
                  <span
                    className="ml-2 inline-flex items-center rounded-full bg-indigo-100 text-indigo-800 text-[10px] px-2 py-0.5 uppercase tracking-wide"
                    title={`Multi-statement PDF (${(r.child_import_ids || []).length} split statements)`}
                  >
                    multi · {(r.child_import_ids || r.child_document_ids || []).length || "…"}
                  </span>
                )}
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
                {r.status === "completed" && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onReprocess(r); }}
                    className="text-slate-400 hover:text-indigo-600 mr-1"
                    title="Reprocess with a corrected account-type hint"
                    data-testid={`stmt-import-reprocess-${r.id}`}
                  >
                    <RotateCw size={14} />
                  </button>
                )}
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
    splitting:  "bg-indigo-100 text-indigo-800",
    partial:    "bg-yellow-100 text-yellow-800",
    failed:     "bg-red-100 text-red-800",
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${map[status] ?? "bg-slate-100 text-slate-700"}`}>
      {status ?? "—"}
    </span>
  );
}
