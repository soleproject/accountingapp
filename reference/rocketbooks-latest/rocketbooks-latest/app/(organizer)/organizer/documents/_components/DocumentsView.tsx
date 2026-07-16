'use client';

import Link from 'next/link';
import { useActionState, useMemo, useRef, useState, useTransition } from 'react';
import type { DocumentListItem } from '@/lib/documents/store';
import { uploadDocumentAction, type UploadDocumentState } from '../_actions/upload';
import { getDocumentDownloadUrl } from '../_actions/download';
import { deleteDocumentAction } from '../_actions/delete';
import { sendDocumentForSignatureAction } from '@/app/(organizer)/organizer/signatures/_actions/fromDocument';

/** Created docs render to PDF; uploaded docs must already be PDF to sign. */
function isSignable(d: DocumentListItem): boolean {
  return d.source !== 'uploaded' || d.mimeType === 'application/pdf';
}

type Tab = 'all' | 'created' | 'uploaded';

const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All documents' },
  { id: 'created', label: 'Created' },
  { id: 'uploaded', label: 'Uploaded' },
];

const KIND_LABEL: Record<string, string> = {
  letter: 'Letter',
  email: 'Email',
  text: 'Text',
  resolution: 'Resolution',
  deck: 'Deck',
};

/** Friendly label for an uploaded file's MIME type. */
function mimeLabel(mime: string | null): string {
  if (!mime) return 'File';
  if (mime === 'application/pdf') return 'PDF';
  if (mime.includes('wordprocessingml') || mime === 'application/msword') return 'Word';
  if (mime.includes('presentationml') || mime.includes('ms-powerpoint')) return 'PowerPoint';
  if (mime.includes('spreadsheetml') || mime.includes('ms-excel')) return 'Excel';
  if (mime.startsWith('image/')) return 'Image';
  if (mime === 'text/csv') return 'CSV';
  if (mime.startsWith('text/')) return 'Text';
  return 'File';
}

function typeLabel(doc: DocumentListItem): string {
  return doc.source === 'uploaded' ? mimeLabel(doc.mimeType) : KIND_LABEL[doc.kind] ?? doc.kind;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function DocumentsView({ docs }: { docs: DocumentListItem[] }) {
  const [tab, setTab] = useState<Tab>('all');
  const [uploadState, uploadAction, uploading] = useActionState<UploadDocumentState | undefined, FormData>(
    uploadDocumentAction,
    undefined,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const counts = useMemo(
    () => ({
      all: docs.length,
      created: docs.filter((d) => d.source !== 'uploaded').length,
      uploaded: docs.filter((d) => d.source === 'uploaded').length,
    }),
    [docs],
  );

  const visible = useMemo(() => {
    if (tab === 'created') return docs.filter((d) => d.source !== 'uploaded');
    if (tab === 'uploaded') return docs.filter((d) => d.source === 'uploaded');
    return docs;
  }, [docs, tab]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Documents</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Letters, emails, and resolutions you&apos;ve created — plus any files you upload.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Hidden upload form — the file input auto-submits on selection. */}
          <form action={uploadAction} ref={formRef}>
            <input
              ref={fileRef}
              type="file"
              name="file"
              className="hidden"
              accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.csv,.md,.png,.jpg,.jpeg,.gif,.webp"
              onChange={() => formRef.current?.requestSubmit()}
            />
          </form>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200/80 bg-white px-3.5 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition-shadow hover:shadow-md disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 16V4M5 11l7-7 7 7M5 20h14" />
            </svg>
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
          <Link
            href="/organizer/create"
            className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200/70 bg-gradient-to-br from-indigo-50 to-white px-3.5 py-1.5 text-sm font-medium text-indigo-700 shadow-sm transition-shadow hover:shadow-md dark:border-indigo-900/40 dark:from-indigo-950/30 dark:to-zinc-900 dark:text-indigo-300"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New document
          </Link>
        </div>
      </header>

      {uploadState?.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          {uploadState.error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-zinc-200/80 dark:border-zinc-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
            }`}
          >
            {t.label}
            <span className="ml-1.5 text-xs text-zinc-400 dark:text-zinc-500">{counts[t.id]}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="rounded-2xl border border-zinc-200/80 bg-white p-8 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          {tab === 'uploaded' ? (
            <>
              No uploaded files yet. Click <span className="font-medium">Upload</span> to add a PDF, Office doc, or image.
            </>
          ) : tab === 'created' ? (
            <>
              No created documents yet. Click <span className="font-medium">New document</span> to draft one — it&apos;ll autosave here.
            </>
          ) : (
            <>
              No documents yet. <span className="font-medium">Upload</span> a file or click <span className="font-medium">New document</span> to draft one.
            </>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Updated</th>
                <th className="px-4 py-2 font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((d) => (
                <tr key={d.id} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/50">
                  <td className="px-4 py-2">
                    <Link
                      href={`/organizer/documents/${d.id}`}
                      className="font-medium text-zinc-800 hover:text-indigo-600 hover:underline dark:text-zinc-200 dark:hover:text-indigo-400"
                    >
                      {d.title || d.originalFilename || 'Untitled draft'}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-300">{typeLabel(d)}</td>
                  <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{fmt(d.updatedAt)}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-0.5">
                      <Link
                        href={`/organizer/documents/${d.id}`}
                        aria-label="View document"
                        title="View"
                        className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-indigo-600 dark:hover:bg-zinc-800 dark:hover:text-indigo-300"
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      </Link>
                      {d.source === 'uploaded' ? (
                        <DownloadButton id={d.id} />
                      ) : (
                        <Link
                          href={`/organizer/create?doc=${d.id}`}
                          aria-label="Edit document"
                          title="Edit"
                          className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-indigo-600 dark:hover:bg-zinc-800 dark:hover:text-indigo-300"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
                          </svg>
                        </Link>
                      )}
                      {isSignable(d) && (
                        <form action={sendDocumentForSignatureAction.bind(null, d.id)} className="inline-flex">
                          <button
                            type="submit"
                            aria-label="Send for signature"
                            title="Send for signature"
                            className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-indigo-600 dark:hover:bg-zinc-800 dark:hover:text-indigo-300"
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M3 17c3 0 4-9 6-9s2 6 4 6 2-3 5-3" /><path d="M3 21h18" />
                            </svg>
                          </button>
                        </form>
                      )}
                      <DeleteButton id={d.id} title={d.title || d.originalFilename || 'this document'} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Uploaded files open via a short-lived signed URL fetched on click. */
function DownloadButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();

  function open() {
    startTransition(async () => {
      const res = await getDocumentDownloadUrl(id);
      if (res.ok && res.url) window.open(res.url, '_blank', 'noopener');
    });
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={pending}
      aria-label="Download file"
      title="Download"
      className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-indigo-600 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-indigo-300"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
      </svg>
    </button>
  );
}

/** Per-row delete with a confirm step. Removes the storage object too for uploads. */
function DeleteButton({ id, title }: { id: string; title: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function remove() {
    if (!window.confirm(`Delete ${title}? This can't be undone.`)) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteDocumentAction(id);
      if (!res.ok) setError(res.error ?? 'Delete failed');
    });
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button
        type="button"
        onClick={remove}
        disabled={pending}
        aria-label="Delete document"
        title="Delete"
        className="rounded p-1 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950/30 dark:hover:text-red-400"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 5v6m4-6v6" />
        </svg>
      </button>
    </span>
  );
}
