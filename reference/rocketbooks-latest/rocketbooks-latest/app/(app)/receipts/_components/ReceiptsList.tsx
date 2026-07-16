'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import Link from 'next/link';
import Image from 'next/image';
import { ReceiptRowActions } from './ReceiptRowActions';

export interface ReceiptRow {
  id: string;
  receiptDate: string | null;
  memo: string | null;
  totalAmount: number;
  status: string;
  posted: boolean;
  vendorLogoUrl: string | null;
  contactName: string | null;
}

interface UploadingRow {
  tempId: string;
  filename: string;
  size: number;
  status: 'uploading' | 'error';
  error?: string;
}

interface Props {
  initialRows: ReceiptRow[];
}

const STATUS_BADGE: Record<string, string> = {
  posted: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  draft: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  uploading: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  error: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  void: 'bg-zinc-200 text-zinc-600 line-through dark:bg-zinc-800 dark:text-zinc-500',
};

const INITIAL_PALETTE = [
  'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200',
  'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-200',
  'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
];

function paletteFor(name: string | null | undefined) {
  if (!name) return INITIAL_PALETTE[0];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return INITIAL_PALETTE[h % INITIAL_PALETTE.length];
}

function formatDate(iso: string | null) {
  if (!iso) return '—';
  // Parse YYYY-MM-DD as a *local* date. `new Date('2026-05-17')` interprets
  // the bare date as UTC midnight, which renders one day earlier west of
  // UTC. The receipt_date column is a calendar date, not a timestamp, so
  // we want the literal date the OCR pulled off the receipt.
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const d = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

const FileIcon = () => (
  <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-blue-500">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="16" y2="17" />
    <line x1="8" y1="9" x2="10" y2="9" />
  </svg>
);

const UploadIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

const Spinner = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" className="animate-spin" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" fill="none" opacity="0.25" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" />
  </svg>
);

export function ReceiptsList({ initialRows }: Props) {
  const router = useRouter();
  const { notifyAssistant } = useAssistant();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<UploadingRow[]>([]);

  const removeUploading = (tempId: string) =>
    setUploading((prev) => prev.filter((u) => u.tempId !== tempId));

  const markError = (tempId: string, error: string) =>
    setUploading((prev) =>
      prev.map((u) => (u.tempId === tempId ? { ...u, status: 'error', error } : u)),
    );

  // Fire one fetch per file. They run in parallel; the dropzone stays
  // interactive because we never block (no awaits in the user-facing
  // path). Each completion triggers a router.refresh() so the new
  // server-rendered row replaces the temporary "Uploading…" placeholder.
  const startUploads = (files: File[]) => {
    if (files.length === 0) return;
    const newRows: UploadingRow[] = files.map((f) => ({
      tempId: `${Date.now()}-${Math.random().toString(36).slice(2)}-${f.name}`,
      filename: f.name,
      size: f.size,
      status: 'uploading',
    }));
    setUploading((prev) => [...newRows, ...prev]);

    const tasks = files.map((file, i) => {
      const tempId = newRows[i].tempId;
      const fd = new FormData();
      fd.append('file', file);
      return fetch('/api/receipts/upload', { method: 'POST', body: fd })
        .then(async (res) => {
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            markError(tempId, body.error ?? `Upload failed (${res.status})`);
            return false;
          }
          removeUploading(tempId);
          router.refresh();
          return true;
        })
        .catch((err: unknown) => {
          markError(tempId, err instanceof Error ? err.message : 'Upload failed');
          return false;
        });
    });
    void Promise.allSettled(tasks).then((results) => {
      const ok = results.filter((r) => r.status === 'fulfilled' && r.value).length;
      if (ok > 0) {
        notifyAssistant(
          `Receipts: uploaded ${ok} receipt${ok === 1 ? '' : 's'} — ${ok === 1 ? 'it is' : 'they are'} extracting now. Next we review the suggested match and post ${ok === 1 ? 'it' : 'them'}.`,
        );
      }
    });
  };

  const onFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    startUploads(Array.from(fileList));
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          onFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-4 py-10 transition-colors ${
          dragOver
            ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/20'
            : 'border-zinc-300 bg-white hover:border-blue-400 hover:bg-blue-50/40 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:border-blue-500 dark:hover:bg-blue-950/10'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          name="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png"
          onChange={(e) => onFiles(e.target.files)}
          className="hidden"
        />

        <FileIcon />

        <div className="text-center">
          <p className="text-base font-medium text-zinc-700 dark:text-zinc-200">
            Click to upload or drag and drop
          </p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            PDF, JPG, or PNG up to 10 MB · multiple files OK
          </p>
        </div>

        <p className="text-xs text-zinc-500 dark:text-zinc-400">PDFs and images are processed automatically using OCR</p>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            inputRef.current?.click();
          }}
          className="mt-1 inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <UploadIcon />
          Choose Files
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Transaction Date</th>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Logo</th>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Vendor</th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Total</th>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Category Summary</th>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Status</th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Actions</th>
            </tr>
          </thead>
          <tbody>
            {uploading.map((u) => {
              const isError = u.status === 'error';
              return (
                <tr key={u.tempId} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">—</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-400 dark:bg-zinc-800">
                      …
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    <span className="block max-w-[260px] truncate" title={u.filename}>
                      {u.filename}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-zinc-400">—</td>
                  <td className="px-4 py-3 text-zinc-400">—</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE[isError ? 'error' : 'uploading']}`}>
                      {isError ? null : <Spinner />}
                      {isError ? (u.error ?? 'Failed') : 'Uploading…'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isError && (
                      <button
                        type="button"
                        onClick={() => removeUploading(u.tempId)}
                        className="rounded p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                        title="Dismiss"
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {initialRows.length === 0 && uploading.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-zinc-500">
                  No receipts uploaded yet. Drop a file above to get started.
                </td>
              </tr>
            )}
            {initialRows.map((r) => {
              const vendor = r.contactName ?? '—';
              const statusKey = r.posted ? 'posted' : (r.status ?? 'draft').toLowerCase();
              const statusLabel = r.posted ? 'Posted' : (r.status ?? 'draft').replace(/^./, (c) => c.toUpperCase());
              const badge = STATUS_BADGE[statusKey] ?? STATUS_BADGE.draft;
              const initials = vendor && vendor !== '—' ? vendor.slice(0, 2).toUpperCase() : '?';
              return (
                <tr key={r.id} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
                  <td className="px-4 py-3 tabular-nums text-zinc-700 dark:text-zinc-300">
                    <Link href={`/receipts/${r.id}`} className="hover:underline">{formatDate(r.receiptDate)}</Link>
                  </td>
                  <td className="px-4 py-3">
                    {r.vendorLogoUrl ? (
                      <Image
                        src={r.vendorLogoUrl}
                        alt={`${vendor} logo`}
                        width={160}
                        height={64}
                        unoptimized
                        className="h-16 w-auto max-w-[160px] object-contain"
                      />
                    ) : (
                      <span className={`inline-flex h-14 w-14 items-center justify-center rounded-full text-sm font-semibold ${paletteFor(vendor)}`}>
                        {initials}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{vendor}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(r.totalAmount))}
                  </td>
                  <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{r.memo ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${badge}`}>
                      {statusLabel}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <ReceiptRowActions receiptId={r.id} receiptLabel={vendor} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
