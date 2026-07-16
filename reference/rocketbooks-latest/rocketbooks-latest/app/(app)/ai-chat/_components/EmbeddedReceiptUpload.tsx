'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import type { OnboardingReceipt } from './OnboardingPanel';

interface Props {
  receipts: OnboardingReceipt[];
  onChanged: () => void | Promise<void>;
}

interface UploadFile {
  id: string;
  file: File;
  status: 'pending' | 'uploading' | 'processing' | 'completed' | 'failed';
  message?: string;
  receiptId?: string;
  vendorName?: string | null;
  total?: number | null;
}

const ACCEPTED = '.pdf,application/pdf,image/jpeg,image/png,.jpg,.jpeg,.png';

function fmt(n: number | null | undefined): string {
  if (typeof n !== 'number') return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export function EmbeddedReceiptUpload({ receipts, onChanged }: Props) {
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onPick = (picked: FileList | File[]) => {
    const arr = Array.from(picked);
    const next: UploadFile[] = arr.map((f) => ({ id: crypto.randomUUID(), file: f, status: 'pending' }));
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
        setFiles((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: 'processing' } : f)));
        const res = await fetch('/api/receipts/upload', { method: 'POST', body: fd });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          receiptId?: string;
          vendorName?: string | null;
          total?: number | null;
        };
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        setFiles((prev) =>
          prev.map((f) =>
            f.id === item.id
              ? { ...f, status: 'completed', receiptId: body.receiptId, vendorName: body.vendorName, total: body.total }
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
      <p className="text-zinc-600 dark:text-zinc-400">
        Drop receipts (PDF / JPG / PNG) — Veryfi extracts the merchant, total, and date.
      </p>

      <div
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
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
        tabIndex={0}
        className={`flex flex-col items-center justify-center gap-1.5 rounded-md border-2 border-dashed p-6 text-center transition-colors ${
          dragOver
            ? 'cursor-copy border-orange-600 bg-orange-100 text-orange-900 dark:border-orange-300 dark:bg-orange-950/40 dark:text-orange-100'
            : 'cursor-pointer border-orange-400 bg-orange-50/40 text-orange-700 hover:border-orange-500 hover:bg-orange-50 dark:border-orange-700 dark:bg-orange-950/20 dark:text-orange-300'
        }`}
      >
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2H4z" />
          <path d="M8 7h8M8 11h8M8 15h5" />
        </svg>
        <div className="font-medium">{dragOver ? 'Drop to upload' : 'Drop receipts here, or click to browse'}</div>
        <div className="text-[10px] text-zinc-500">PDF · JPG · PNG · up to 10 MB · multiple OK</div>
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
              <span className={`rounded px-1.5 py-0.5 ${
                f.status === 'completed' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300' :
                f.status === 'failed' ? 'bg-red-100 text-red-800 dark:bg-red-950/30 dark:text-red-300' :
                'bg-amber-100 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200'
              }`}>
                {f.status === 'completed'
                  ? `${f.vendorName ?? 'unknown'} · ${fmt(f.total)}`
                  : f.status}
              </span>
              {f.message && <span className="text-zinc-500">{f.message.slice(0, 40)}</span>}
            </div>
          ))}
        </div>
      )}

      {receipts.length > 0 && (
        <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
          <div className="bg-zinc-50 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            Recent receipts ({receipts.length})
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {receipts.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                <Link
                  href={`/receipts/${r.id}`}
                  target="_blank"
                  className="min-w-0 flex-1 truncate font-medium text-zinc-700 hover:underline dark:text-zinc-300"
                >
                  {r.vendorName ?? r.id.slice(0, 8)}
                </Link>
                <span className="text-zinc-500">{r.receiptDate ?? '—'}</span>
                <span className="tabular-nums text-zinc-700 dark:text-zinc-300">{fmt(r.total)}</span>
                <span
                  className={`rounded px-1.5 py-0.5 ${
                    r.posted
                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                      : 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'
                  }`}
                >
                  {r.posted ? 'posted' : (r.status ?? 'draft')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
