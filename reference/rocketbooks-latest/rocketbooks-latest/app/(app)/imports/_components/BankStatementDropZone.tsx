'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

interface BankAccount {
  id: string;
  accountNumber: string;
  accountName: string;
}

interface UploadFile {
  id: string;
  file: File;
  status: 'pending' | 'uploading' | 'processing' | 'completed' | 'failed';
  message?: string;
  transactionCount?: number;
  importId?: string;
  coaName?: string;
  coaMatched?: boolean;
}

const AUTO_DETECT = '__auto__';

const ACCEPTED = '.pdf,application/pdf,image/jpeg,image/png,.jpg,.jpeg,.png';

export function BankStatementDropZone({ accounts }: { accounts: BankAccount[] }) {
  const router = useRouter();
  const { notifyAssistant } = useAssistant();
  const [accountId, setAccountId] = useState<string>(AUTO_DETECT);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onPick = (picked: FileList | File[]) => {
    const arr = Array.from(picked);
    const next: UploadFile[] = arr.map((f) => ({
      id: crypto.randomUUID(),
      file: f,
      status: 'pending',
    }));
    setFiles((prev) => [...prev, ...next]);
    void uploadAll(next);
  };

  const uploadAll = async (items: UploadFile[]) => {
    // 2-at-a-time concurrency to be friendly to Veryfi
    const queue = [...items];
    const inflight: Promise<void>[] = [];
    const max = 2;
    const completed: number[] = []; // transaction counts of successfully-extracted files

    const runOne = async (item: UploadFile) => {
      setFiles((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: 'uploading' } : f)));
      try {
        const fd = new FormData();
        fd.append('file', item.file);
        if (accountId !== AUTO_DETECT) fd.append('accountId', accountId);
        setFiles((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: 'processing' } : f)));
        const res = await fetch('/api/imports/bank-statement', { method: 'POST', body: fd });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          status?: string;
          transactionCount?: number;
          importId?: string;
          message?: string;
          coaResolved?: { matched: boolean; accountName: string; accountId: string } | null;
        };
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        if (body.status === 'completed') completed.push(body.transactionCount ?? 0);
        setFiles((prev) =>
          prev.map((f) =>
            f.id === item.id
              ? {
                  ...f,
                  status: body.status === 'completed' ? 'completed' : 'processing',
                  transactionCount: body.transactionCount,
                  importId: body.importId,
                  message: body.message,
                  coaName: body.coaResolved?.accountName,
                  coaMatched: body.coaResolved?.matched,
                }
              : f,
          ),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Upload failed';
        setFiles((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: 'failed', message: msg } : f)));
      }
    };

    while (queue.length > 0 || inflight.length > 0) {
      while (inflight.length < max && queue.length > 0) {
        const item = queue.shift()!;
        const p = runOne(item).finally(() => {
          const i = inflight.indexOf(p);
          if (i >= 0) inflight.splice(i, 1);
        });
        inflight.push(p);
      }
      if (inflight.length > 0) await Promise.race(inflight);
    }
    if (completed.length > 0) {
      const txns = completed.reduce((s, n) => s + n, 0);
      notifyAssistant(
        `Bank statement import: extracted ${txns} transaction${txns === 1 ? '' : 's'} from ${completed.length} statement${completed.length === 1 ? '' : 's'}. Next they get reviewed and promoted into the books.`,
      );
    }
    router.refresh();
  };

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) onPick(e.dataTransfer.files);
  };

  const clearCompleted = () => {
    setFiles((prev) => prev.filter((f) => f.status !== 'completed'));
  };

  // accounts[] can be empty — we'll auto-create a COA from Veryfi metadata.
  const ready = true;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">Upload bank statements</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Drag PDFs (or images) of bank statements. Veryfi extracts every transaction; you review and post on the Plaid Feed–style review screen.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-zinc-500">Bank account</span>
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value={AUTO_DETECT}>Auto-detect from statement</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.accountNumber} · {a.accountName}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        onClick={() => ready && fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (ready && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        onDragEnter={onDragEnter}
        onDragOver={onDragEnter}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        role="button"
        tabIndex={ready ? 0 : -1}
        aria-label="Drop bank statements here, or click to browse"
        className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
          !ready
            ? 'cursor-not-allowed border-zinc-300 bg-zinc-50 text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900'
            : dragOver
              ? 'cursor-copy border-blue-600 bg-blue-100 text-blue-900 dark:border-blue-300 dark:bg-blue-950/40 dark:text-blue-100'
              : 'cursor-pointer border-blue-400 bg-blue-50/40 text-blue-700 hover:border-blue-500 hover:bg-blue-50 dark:border-blue-700 dark:bg-blue-950/20 dark:text-blue-300 dark:hover:border-blue-500 dark:hover:bg-blue-950/30'
        }`}
      >
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <div className="text-base font-medium">
          {dragOver
            ? 'Drop to upload'
            : ready
              ? 'Drop bank statements here, or click to browse'
              : 'Pick a bank account first'}
        </div>
        <div className="text-xs text-zinc-500">PDF · JPG · PNG · up to 25 MB · multiple files OK</div>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED}
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) onPick(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {files.length > 0 && (
        <div className="mt-4 flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Uploads</div>
            {files.some((f) => f.status === 'completed') && (
              <button
                type="button"
                onClick={clearCompleted}
                className="text-xs text-zinc-500 underline hover:text-zinc-700"
              >
                Clear completed
              </button>
            )}
          </div>
          {files.map((f) => (
            <FileRow key={f.id} f={f} />
          ))}
        </div>
      )}
    </div>
  );
}

function FileRow({ f }: { f: UploadFile }) {
  const statusColor: Record<UploadFile['status'], string> = {
    pending: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
    uploading: 'bg-blue-100 text-blue-800 dark:bg-blue-950/30 dark:text-blue-300',
    processing: 'bg-amber-100 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200',
    completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300',
    failed: 'bg-red-100 text-red-800 dark:bg-red-950/30 dark:text-red-300',
  };
  const isAnimating = f.status === 'uploading' || f.status === 'processing';
  return (
    <div className="flex items-center gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="min-w-0 flex-1 truncate">{f.file.name}</div>
      <div className="text-xs text-zinc-500">{(f.file.size / 1024).toFixed(0)} KB</div>
      {f.coaName && (
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            f.coaMatched
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
              : 'bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:text-violet-300'
          }`}
          title={f.coaMatched ? `Matched existing COA: ${f.coaName}` : `Created new COA: ${f.coaName}`}
        >
          {f.coaMatched ? '↳' : '✨'} {f.coaName}
        </span>
      )}
      <span className={`rounded-full px-2 py-0.5 text-xs ${statusColor[f.status]}`}>
        {isAnimating && (
          <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
        )}
        {f.status === 'completed' && f.transactionCount !== undefined
          ? `${f.transactionCount} txns`
          : f.status}
      </span>
      {f.status === 'completed' && f.importId && (
        <a href={`/imports/${f.importId}`} className="text-xs underline">View</a>
      )}
      {f.message && f.status !== 'completed' && (
        <div className="text-xs text-zinc-500" title={f.message}>{f.message.length > 40 ? f.message.slice(0, 40) + '…' : f.message}</div>
      )}
    </div>
  );
}
