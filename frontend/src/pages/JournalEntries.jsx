import { useEffect, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { api, fmtMoney, fmtDate } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X, Upload, Loader2, Check, ArrowLeft, History, Undo2, FileSpreadsheet, FileText, Sparkles, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

export default function JournalEntries() {
  const { currentId } = useCompany();
  const [entries, setEntries] = useState([]);
  const [accts, setAccts] = useState([]);
  const [creating, setCreating] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const load = async () => {
    if (!currentId) return;
    const [j, a] = await Promise.all([
      api.get(`/companies/${currentId}/journal-entries`),
      api.get(`/companies/${currentId}/accounts`),
    ]);
    setEntries(j.data.entries || []);
    setAccts(a.data.accounts || []);
  };
  useEffect(() => { load(); }, [currentId]);

  const [params] = useSearchParams();
  const navigate = useNavigate();
  useEffect(() => {
    const hl = params.get("highlight");
    if (!hl || !entries.length) return;
    setTimeout(() => {
      const row = document.querySelector(`[data-je-id="${hl}"]`);
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
      row?.classList.add("bg-amber-50");
      setTimeout(() => row?.classList.remove("bg-amber-50"), 3000);
    }, 200);
  }, [params, entries]);

  const del = async (id) => {
    if (!confirm("Delete this JE?")) return;
    await api.delete(`/companies/${currentId}/journal-entries/${id}`);
    load();
  };

  return (
    <div className="space-y-4">
      {params.get("from") === "gl" && (
        <nav
          aria-label="Breadcrumb"
          data-testid="je-gl-breadcrumb"
          className="text-sm text-slate-500 flex items-center gap-2"
        >
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="hover:text-slate-900 hover:underline"
            data-testid="je-gl-back-link"
          >
            ← General Ledger
          </button>
          <span aria-hidden="true">/</span>
          <span className="text-slate-900 font-medium">Journal Entry</span>
        </nav>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Journal Entries</h1>
          <p className="text-slate-500 text-sm mt-1">Double-entry postings. Debits must equal credits.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setImportOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-indigo-300 bg-indigo-50 text-indigo-800 text-xs hover:bg-indigo-100"
            data-testid="je-import-btn"
          >
            <Upload size={13} /> Import GL
          </button>
          <button data-testid={TID.addBtn} onClick={() => setCreating(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
            <Plus size={13} /> New JE
          </button>
        </div>
      </div>
      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-left">Memo</th>
              <th className="px-3 py-2 text-left">Lines</th>
              <th className="px-3 py-2 text-right">Debit</th>
              <th className="px-3 py-2 text-right">Credit</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map(e => (
              <tr key={e.id} data-je-id={e.id} className="border-b hover:bg-slate-50 transition-colors">
                <td className="px-3 py-2 font-mono-num text-slate-600">{fmtDate(e.date)}</td>
                <td className="px-3 py-2">{e.memo}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{e.lines.length} lines</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(e.total_debit)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(e.total_credit)}</td>
                <td className="px-3 py-2 text-right"><button onClick={() => del(e.id)} className="text-red-500 p-1"><Trash2 size={13} /></button></td>
              </tr>
            ))}
            {!entries.length && <tr><td colSpan={6} className="text-center py-8 text-slate-500">No journal entries yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && <NewJE currentId={currentId} accts={accts} onClose={() => { setCreating(false); load(); }} />}
      {importOpen && <ImportGLModal currentId={currentId} onClose={(r) => { setImportOpen(false); if (r) load(); }} />}
    </div>
  );
}

function NewJE({ currentId, accts, onClose }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState([
    { account_id: "", debit: 0, credit: 0, description: "" },
    { account_id: "", debit: 0, credit: 0, description: "" },
  ]);
  const td = lines.reduce((s, l) => s + parseFloat(l.debit || 0), 0);
  const tc = lines.reduce((s, l) => s + parseFloat(l.credit || 0), 0);
  const balanced = Math.abs(td - tc) < 0.01 && td > 0;
  const save = async () => {
    if (!balanced) { toast.error("Debits must equal credits"); return; }
    await api.post(`/companies/${currentId}/journal-entries`, { date, memo, lines });
    toast.success("Journal entry posted"); onClose();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold">New Journal Entry</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        <div className="flex gap-2">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
          <input placeholder="Memo" value={memo} onChange={(e) => setMemo(e.target.value)} className="flex-1 border rounded px-2 py-1.5 text-sm" />
        </div>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <select value={l.account_id} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, account_id: e.target.value } : x))}
                      className="col-span-5 border rounded px-2 py-1.5 text-sm">
                <option value="">Account…</option>
                {accts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
              </select>
              <input type="number" step="0.01" placeholder="Debit" value={l.debit}
                     onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, debit: e.target.value } : x))}
                     className="col-span-2 border rounded px-2 py-1.5 text-sm font-mono-num" />
              <input type="number" step="0.01" placeholder="Credit" value={l.credit}
                     onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, credit: e.target.value } : x))}
                     className="col-span-2 border rounded px-2 py-1.5 text-sm font-mono-num" />
              <input placeholder="Description" value={l.description}
                     onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, description: e.target.value } : x))}
                     className="col-span-3 border rounded px-2 py-1.5 text-sm" />
            </div>
          ))}
          <button onClick={() => setLines([...lines, { account_id: "", debit: 0, credit: 0, description: "" }])}
                  className="text-xs text-slate-600 border border-dashed rounded px-2 py-1">+ Add line</button>
        </div>
        <div className="flex items-center justify-between border-t pt-3">
          <div className={`text-sm ${balanced ? "text-emerald-600" : "text-red-600"}`}>
            Debits <span className="font-mono-num">{fmtMoney(td)}</span> · Credits <span className="font-mono-num">{fmtMoney(tc)}</span>
          </div>
          <button data-testid={TID.saveBtn} onClick={save} disabled={!balanced}
                  className="px-4 py-1.5 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50">Post JE</button>
        </div>
      </div>
    </div>
  );
}


/**
 * ImportGLModal — bulk-import historical general-ledger entries from
 * Excel / CSV / PDF. Rows are grouped by (date, reference|memo) into
 * balanced journal entries. Only balanced + fully-resolved JEs are
 * eligible for commit; the review screen highlights problems so the
 * CPA can fix them in the source file and re-upload.
 */
function ImportGLModal({ currentId, onClose }) {
  const [step, setStep] = useState("upload"); // upload | review | done
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [entries, setEntries] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [result, setResult] = useState(null);
  const [batches, setBatches] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const inputRef = useRef(null);
  const lastFileRef = useRef(null);

  const loadHistory = async () => {
    try {
      const r = await api.get(`/companies/${currentId}/journal-entries/imports?limit=10`);
      setBatches(r.data?.batches || []);
    } catch { /* advisory */ }
  };
  useEffect(() => { loadHistory(); }, [currentId]);

  const upload = async (file, opts = {}) => {
    if (!file) return;
    lastFileRef.current = file;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (opts.ai) fd.append("ai", "true");
      const r = await api.post(`/companies/${currentId}/journal-entries/import/preview`, fd,
        { headers: { "Content-Type": "multipart/form-data" } });
      setPreview(r.data);
      const ents = r.data?.entries || [];
      setEntries(ents);
      // Only pre-check the JEs that can actually be posted.
      setSelected(new Set(
        ents.map((e, i) => e.balanced && !e.unresolved_accounts ? i : null).filter(i => i !== null)
      ));
      setStep("review");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't parse the file");
    } finally { setBusy(false); }
  };

  const toggleRow = (i) => setSelected(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const eligibleCount = entries.filter(e => e.balanced && !e.unresolved_accounts).length;
  const toggleAllEligible = () => {
    setSelected(prev => {
      const eligible = entries.map((e, i) => e.balanced && !e.unresolved_accounts ? i : null).filter(i => i !== null);
      return prev.size >= eligibleCount ? new Set() : new Set(eligible);
    });
  };

  const commit = async () => {
    const payload = entries.filter((_, i) => selected.has(i));
    if (!payload.length) { toast.error("Nothing selected."); return; }
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/journal-entries/import/commit`, {
        entries: payload, filename: preview?.filename, source: preview?.source,
      });
      setResult(r.data);
      setStep("done");
      loadHistory();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Import failed");
    } finally { setBusy(false); }
  };

  const undoBatch = async (batchId) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm("Undo this GL import? Every journal entry it created will be deleted (blocked for closed periods).")) return;
    try {
      const r = await api.post(`/companies/${currentId}/journal-entries/imports/${batchId}/undo`);
      toast.success(`Undo complete — deleted ${r.data?.deleted || 0} journal entries.`);
      loadHistory();
      onClose(true);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Undo failed");
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col" data-testid="gl-import-modal">
        <div className="px-5 py-3 border-b flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0">
            <Upload size={16} className="text-indigo-700" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-heading font-semibold">Import general ledger</h3>
            <p className="text-xs text-slate-500">Bulk-import historical journal entries. Rows are grouped by date + reference into balanced entries.</p>
          </div>
          <button onClick={() => onClose(false)} className="p-1 rounded hover:bg-slate-100"><X size={16} /></button>
        </div>

        {step === "upload" && (
          <div className="p-5 space-y-4">
            <GLDropZone busy={busy} onFile={(f) => upload(f)} inputRef={inputRef} />
            <div className="text-[11px] text-slate-500 bg-slate-50 border rounded p-3">
              <b>Columns we recognize:</b> Date · Reference (JE#) · Memo · Account Code (or Account Name) · Debit · Credit. Or a single signed Amount column. Rows sharing the same date + reference are grouped into one JE. Every JE must balance (debits == credits) to commit.
            </div>
            {batches.length > 0 && (
              <div className="rounded-lg border bg-white">
                <button onClick={() => setHistoryOpen(o => !o)} className="w-full px-4 py-2 flex items-center gap-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
                  <History size={13} className="text-slate-500" />
                  Import history ({batches.length})
                  <span className="ml-auto text-slate-400">{historyOpen ? "▼" : "▶"}</span>
                </button>
                {historyOpen && (
                  <ul className="divide-y">
                    {batches.map(b => (
                      <li key={b.id} className="px-4 py-2.5 flex items-center gap-3 text-xs">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate text-slate-800">
                            {b.filename}
                            <span className="text-[10px] ml-2 text-slate-400 uppercase">{b.source}</span>
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {new Date(b.at).toLocaleString()} · {b.user_name} · <b>{b.created_count}</b> JEs
                            {b.skipped_count ? <>, skipped <b>{b.skipped_count}</b></> : ""}
                          </div>
                        </div>
                        {b.undone ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-200 uppercase tracking-wide">Undone</span>
                        ) : (
                          <button onClick={() => undoBatch(b.id)} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-rose-200 text-rose-700 hover:bg-rose-50">
                            <Undo2 size={11} /> Undo
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {step === "review" && preview && (
          <>
            <div className="px-5 py-3 border-b bg-slate-50/40 flex items-center gap-3 text-xs flex-wrap">
              <span className="text-slate-700">
                <b>{preview.filename}</b> · {preview.row_count_raw} rows → <b>{entries.length}</b> journal entries
              </span>
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 uppercase tracking-wide">
                <Check size={10} /> {preview.summary.balanced} balanced
              </span>
              {preview.summary.unbalanced > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-rose-50 text-rose-800 border border-rose-200 uppercase tracking-wide">
                  <AlertTriangle size={10} /> {preview.summary.unbalanced} unbalanced
                </span>
              )}
              {preview.summary.unresolved > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 uppercase tracking-wide">
                  <AlertTriangle size={10} /> {preview.summary.unresolved} unresolved accounts
                </span>
              )}
              <button onClick={() => { setStep("upload"); setPreview(null); setEntries([]); }} className="ml-auto text-slate-500 hover:text-slate-900 inline-flex items-center gap-1">
                <ArrowLeft size={12} /> Choose different file
              </button>
            </div>

            <div className="flex-1 overflow-auto p-3 space-y-2">
              {!entries.length && <div className="p-8 text-center text-slate-500 text-sm">No entries parsed.</div>}
              {entries.map((e, i) => {
                const eligible = e.balanced && !e.unresolved_accounts;
                const isChecked = selected.has(i);
                return (
                  <div
                    key={i}
                    className={`border rounded-lg ${eligible ? "bg-white" : "bg-rose-50/40 border-rose-200"} ${!isChecked ? "opacity-60" : ""}`}
                  >
                    <div className="px-3 py-2 flex items-center gap-3 border-b bg-slate-50/60">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleRow(i)}
                        disabled={!eligible}
                        title={eligible ? "" : "Fix balance / unresolved accounts in the source file to enable"}
                      />
                      <span className="font-mono-num text-xs text-slate-600">{e.date}</span>
                      {e.reference && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 font-mono-num">{e.reference}</span>}
                      <span className="text-sm text-slate-800 truncate flex-1">{e.memo || "—"}</span>
                      <span className={`text-[11px] font-mono-num ${e.balanced ? "text-emerald-700" : "text-rose-700"}`}>
                        DR {fmtMoney(e.debit_total)} · CR {fmtMoney(e.credit_total)}
                      </span>
                    </div>
                    <div className="px-3 py-1.5 space-y-1">
                      {e.lines.map((l, li) => (
                        <div key={li} className="grid grid-cols-12 gap-2 text-xs">
                          <div className="col-span-1 font-mono-num text-slate-500">{l.account_code || "—"}</div>
                          <div className={`col-span-6 truncate ${l.account_id ? "" : "text-rose-700"}`}>
                            {l.account_name || <span className="italic text-slate-400">(unresolved)</span>}
                            {!l.account_id && l.account_name && <span className="ml-1 text-[10px] text-rose-600">· not in CoA</span>}
                          </div>
                          <div className="col-span-2 text-right font-mono-num text-slate-700">
                            {l.debit ? fmtMoney(l.debit) : ""}
                          </div>
                          <div className="col-span-2 text-right font-mono-num text-slate-700">
                            {l.credit ? fmtMoney(l.credit) : ""}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="px-5 py-3 border-t bg-slate-50/60 flex items-center gap-3">
              <button onClick={toggleAllEligible} className="text-[11px] text-slate-600 hover:text-slate-900 underline">
                {selected.size >= eligibleCount ? "Deselect all" : `Select all ${eligibleCount} eligible`}
              </button>
              <span className="text-xs text-slate-600">{selected.size} of {eligibleCount} eligible selected</span>
              <button onClick={() => onClose(false)} disabled={busy} className="ml-auto px-3 py-1.5 rounded-md border text-sm">Cancel</button>
              <button onClick={commit} disabled={busy || !selected.size} className="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm inline-flex items-center gap-1.5 disabled:opacity-50">
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Import {selected.size} JE{selected.size !== 1 ? "s" : ""}
              </button>
            </div>
          </>
        )}

        {step === "done" && result && (
          <div className="p-8 text-center space-y-4">
            <div className="w-14 h-14 mx-auto rounded-full bg-emerald-100 flex items-center justify-center">
              <Check size={28} className="text-emerald-700" />
            </div>
            <div>
              <h4 className="text-lg font-semibold">GL import complete</h4>
              <p className="text-sm text-slate-600 mt-1">
                Posted <b>{result.created}</b> journal entries
                {result.skipped ? <>, skipped <b>{result.skipped}</b></> : ""}.
              </p>
            </div>
            <button onClick={() => onClose(true)} className="px-4 py-2 rounded-md bg-slate-900 text-white text-sm">Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

function GLDropZone({ busy, onFile, inputRef }) {
  const [over, setOver] = useState(false);
  const dragCount = useRef(0);
  const onDragEnter = (e) => { e.preventDefault(); e.stopPropagation(); dragCount.current += 1; if (e.dataTransfer?.types?.includes("Files")) setOver(true); };
  const onDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); dragCount.current -= 1; if (dragCount.current <= 0) { dragCount.current = 0; setOver(false); } };
  const onDragOver = (e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; };
  const onDrop = (e) => { e.preventDefault(); e.stopPropagation(); dragCount.current = 0; setOver(false); const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); };
  return (
    <div onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}
         className={`rounded-lg border-2 border-dashed transition-colors p-6 text-center ${over ? "border-indigo-500 bg-indigo-100/70" : "border-slate-300 hover:border-indigo-400 hover:bg-indigo-50/30"}`}>
      <input ref={inputRef} type="file" accept=".xlsx,.xls,.xlsm,.csv,.txt,.pdf" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
      <div className="flex items-center justify-center gap-2 text-slate-400 mb-3 pointer-events-none">
        <FileSpreadsheet size={22} /> <FileText size={22} />
      </div>
      <div className="text-sm font-medium text-slate-700 mb-1 pointer-events-none">
        {over ? "Drop to upload" : "Drop a GL export here"}
      </div>
      <div className="text-xs text-slate-500 mb-3 pointer-events-none">Excel / CSV / PDF · Date, Ref, Account, Debit, Credit</div>
      <button onClick={() => inputRef.current?.click()} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50">
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
        Choose file
      </button>
    </div>
  );
}

