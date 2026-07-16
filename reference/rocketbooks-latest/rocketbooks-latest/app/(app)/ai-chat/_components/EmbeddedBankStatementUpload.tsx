'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import type { OnboardingImport } from './OnboardingPanel';

interface BankAccount {
  id: string;
  accountNumber: string;
  accountName: string;
}

interface Props {
  accounts: BankAccount[];
  imports: OnboardingImport[];
  onChanged: () => void | Promise<void>;
}

interface UploadFile {
  id: string;
  file: File;
  status: 'pending' | 'uploading' | 'processing' | 'completed' | 'failed';
  message?: string;
  importId?: string;
  transactionCount?: number;
  coaName?: string;
  coaMatched?: boolean;
}

const ACCEPTED = '.pdf,application/pdf,image/jpeg,image/png,.jpg,.jpeg,.png';
const AUTO_DETECT = '__auto__';

export function EmbeddedBankStatementUpload({ accounts, imports, onChanged }: Props) {
  const [accountId, setAccountId] = useState<string>(AUTO_DETECT);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const ready = true; // accountId is now optional — server will resolve from Veryfi

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
    const queue = [...items];
    const inflight: Promise<void>[] = [];
    const max = 2;

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
          coaResolved?: { matched: boolean; accountName: string; accountId: string } | null;
        };
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        setFiles((prev) =>
          prev.map((f) =>
            f.id === item.id
              ? {
                  ...f,
                  status: 'completed',
                  importId: body.importId,
                  transactionCount: body.transactionCount,
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
    await onChanged();
  };

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-zinc-600 dark:text-zinc-400">
          Drop bank statement PDFs (or images) — Veryfi extracts every transaction.
        </p>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-zinc-500">Bank account</span>
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value={AUTO_DETECT}>Auto-detect from statement ✨</option>
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
        onDragEnter={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) onPick(e.dataTransfer.files);
        }}
        role="button"
        tabIndex={ready ? 0 : -1}
        className={`flex flex-col items-center justify-center gap-1.5 rounded-md border-2 border-dashed p-6 text-center transition-colors ${
          dragOver
            ? 'cursor-copy border-blue-600 bg-blue-100 text-blue-900 dark:border-blue-300 dark:bg-blue-950/40 dark:text-blue-100'
            : 'cursor-pointer border-blue-400 bg-blue-50/40 text-blue-700 hover:border-blue-500 hover:bg-blue-50 dark:border-blue-700 dark:bg-blue-950/20 dark:text-blue-300'
        }`}
      >
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <div className="font-medium">{dragOver ? 'Drop to upload' : 'Drop statements here, or click to browse'}</div>
        <div className="text-[10px] text-zinc-500">PDF · JPG · PNG · up to 25 MB · multiple OK</div>
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
        <div className="flex flex-col gap-1">
          {files.map((f) => (
            <div key={f.id} className="flex items-center gap-2 rounded border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-900">
              <div className="min-w-0 flex-1 truncate">{f.file.name}</div>
              {f.coaName && (
                <span
                  className={`rounded px-1.5 py-0.5 ${
                    f.coaMatched
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                      : 'bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:text-violet-300'
                  }`}
                  title={f.coaMatched ? 'Matched existing COA' : 'Auto-created COA'}
                >
                  {f.coaMatched ? '↳' : '✨'} {f.coaName}
                </span>
              )}
              <span className={`rounded px-1.5 py-0.5 ${
                f.status === 'completed' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300' :
                f.status === 'failed' ? 'bg-red-100 text-red-800 dark:bg-red-950/30 dark:text-red-300' :
                'bg-amber-100 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200'
              }`}>
                {f.status === 'completed' ? `${f.transactionCount ?? 0} txns` : f.status}
              </span>
              {f.message && <span className="text-zinc-500">{f.message.slice(0, 40)}</span>}
            </div>
          ))}
        </div>
      )}

      {imports.length > 0 && (
        <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
          <div className="bg-zinc-50 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            Recent statements ({imports.length})
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {imports.map((imp) => (
              <li key={imp.id} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                <Link
                  href={`/imports/${imp.id}`}
                  target="_blank"
                  className="min-w-0 flex-1 truncate font-medium text-zinc-700 hover:underline dark:text-zinc-300"
                >
                  {imp.filename ?? imp.id.slice(0, 8)}
                </Link>
                <span className="text-zinc-500">
                  {imp.startDate && imp.endDate ? `${imp.startDate} → ${imp.endDate}` : '—'}
                </span>
                <span className="tabular-nums text-zinc-700 dark:text-zinc-300">{imp.transactionCount ?? '—'} txns</span>
                <span
                  className={`rounded px-1.5 py-0.5 ${
                    imp.status === 'completed' || imp.status === 'success'
                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                      : imp.status === 'failed' || imp.status === 'error'
                        ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                        : 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'
                  }`}
                >
                  {imp.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
