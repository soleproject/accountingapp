'use client';

import { useEffect, useState, useTransition } from 'react';
import { listUserDocuments } from '../_actions/listUserDocuments';
import type { DocumentListItem } from '@/lib/documents/store';

export interface AttachedDoc {
  id: string;
  title: string;
  source: string;
}

/**
 * "Attach document" dropdown for the compose step. Lazily fetches all of the
 * user's documents (created + uploaded) the first time it's opened, lets the
 * user pick one, and reports it up as an attachment (recorded on the draft +
 * shown as a chip by the parent). Selecting the same doc twice is a no-op.
 */
export function AttachDocumentControl({
  attached,
  onAttach,
  disabled,
}: {
  attached: AttachedDoc[];
  onAttach: (doc: AttachedDoc) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<DocumentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Load once, the first time the menu opens.
  useEffect(() => {
    if (!open || docs !== null) return;
    start(async () => {
      const r = await listUserDocuments();
      if (!r.ok) {
        setError(r.error ?? 'Could not load documents.');
        setDocs([]);
        return;
      }
      setDocs(r.documents);
    });
  }, [open, docs]);

  const attachedIds = new Set(attached.map((a) => a.id));

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-sm font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
        Attach document
      </button>

      {open && (
        <>
          {/* click-away */}
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute bottom-full left-0 z-40 mb-1 max-h-64 w-72 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            {pending && docs === null ? (
              <p className="px-3 py-2 text-xs text-zinc-400">Loading…</p>
            ) : error ? (
              <p className="px-3 py-2 text-xs text-rose-500">{error}</p>
            ) : docs && docs.length === 0 ? (
              <p className="px-3 py-2 text-xs text-zinc-400">No documents yet.</p>
            ) : (
              <ul className="flex flex-col">
                {(docs ?? []).map((d) => {
                  const already = attachedIds.has(d.id);
                  return (
                    <li key={d.id}>
                      <button
                        type="button"
                        disabled={already}
                        onClick={() => {
                          onAttach({ id: d.id, title: d.title || d.originalFilename || 'Untitled', source: d.source });
                          setOpen(false);
                        }}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left text-sm hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800"
                      >
                        <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-200">
                          {d.title || d.originalFilename || 'Untitled'}
                        </span>
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-zinc-400">
                          {d.source === 'uploaded' ? 'Upload' : d.kind}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
