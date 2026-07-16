'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DocBranding } from '@/lib/documents/layout';
import { analyzeDocumentAction } from '../_actions/analyze';
import type { DocumentBreakdown } from '@/lib/documents/analyze';

export interface DocumentViewerProps {
  id: string;
  source: string;
  // Created docs:
  kind: string;
  title: string;
  body: string;
  branding: DocBranding;
  // Uploaded docs:
  mimeType: string | null;
  originalFilename: string | null;
  fileSize: number | null;
  signedUrl: string | null;
  /** Saved breakdown (null if never generated) + whether it's out of date. */
  initialBreakdown: DocumentBreakdown | null;
  initialStale: boolean;
  /** Lazily-rendered created-doc preview (passed from the server component). */
  createdPreview?: React.ReactNode;
}

function humanSize(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function UploadedPreview({ mimeType, signedUrl, originalFilename }: { mimeType: string | null; signedUrl: string | null; originalFilename: string | null }) {
  if (!signedUrl) {
    return <p className="p-8 text-center text-sm text-zinc-400">Preview unavailable.</p>;
  }
  if (mimeType === 'application/pdf') {
    return <iframe src={signedUrl} title={originalFilename ?? 'Document'} className="h-[78vh] w-full rounded-lg border border-zinc-200 dark:border-zinc-800" />;
  }
  if (mimeType?.startsWith('image/')) {
    return (
      <div className="flex justify-center p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={signedUrl} alt={originalFilename ?? ''} className="max-h-[78vh] max-w-full rounded-lg object-contain" />
      </div>
    );
  }
  // Office docs etc. — no inline preview; offer to open in a new tab.
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 p-8 text-center">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-400" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
      </svg>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">This file type can&apos;t be previewed inline.</p>
      <a
        href={signedUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200/70 bg-white px-3.5 py-1.5 text-sm font-medium text-indigo-700 shadow-sm hover:shadow-md dark:border-indigo-900/40 dark:bg-zinc-900 dark:text-indigo-300"
      >
        Open / download
      </a>
    </div>
  );
}

function AiBreakdown({
  id,
  source,
  initialBreakdown,
  initialStale,
}: {
  id: string;
  source: string;
  initialBreakdown: DocumentBreakdown | null;
  initialStale: boolean;
}) {
  const [breakdown, setBreakdown] = useState<DocumentBreakdown | null>(initialBreakdown);
  // Only auto-generate when there's nothing saved; otherwise show the saved
  // breakdown immediately (and a rerun prompt if it's stale).
  const [loading, setLoading] = useState(initialBreakdown == null);
  const [stale, setStale] = useState(initialStale);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(() => {
    setLoading(true);
    setError(null);
    analyzeDocumentAction(id)
      .then((res) => {
        if (res.ok && res.breakdown) {
          setBreakdown(res.breakdown);
          setStale(false);
        } else setError(res.error ?? 'Could not analyze this document.');
      })
      .catch(() => setError('Could not analyze this document.'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (initialBreakdown == null) run();
  }, [initialBreakdown, run]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5 10.1 7.6z" />
            </svg>
          </span>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-indigo-700/80 dark:text-indigo-300/80">AI breakdown</h2>
        </div>
        {!loading && breakdown && (
          <button
            type="button"
            onClick={run}
            className="text-xs font-medium text-zinc-400 hover:text-indigo-600 dark:hover:text-indigo-300"
          >
            Regenerate
          </button>
        )}
      </div>

      {!loading && stale && breakdown && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs dark:border-amber-900/40 dark:bg-amber-950/30">
          <span className="text-amber-800 dark:text-amber-300">
            This document changed since this summary was generated.
          </span>
          <button
            type="button"
            onClick={run}
            className="w-fit rounded-full bg-amber-600 px-3 py-1 font-medium text-white hover:bg-amber-700"
          >
            Rerun analysis
          </button>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          <div className="h-3 w-1/3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-3 w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="mt-3 h-3 w-1/4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-3 w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <p className="pt-1 text-xs text-zinc-400">Reading the document…</p>
        </div>
      ) : error ? (
        <p className="text-sm text-rose-500">{error}</p>
      ) : breakdown ? (
        <div className="flex flex-col gap-4 text-sm">
          <span className="inline-flex w-fit items-center rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
            {breakdown.documentType}
          </span>
          <Section label="What it is">{breakdown.summary}</Section>
          <Section label="What it's for">{breakdown.purpose}</Section>
          {breakdown.keyPoints.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Key points</h3>
              <ul className="list-disc space-y-1 pl-4 text-zinc-700 dark:text-zinc-300">
                {breakdown.keyPoints.map((k, i) => (
                  <li key={i}>{k}</li>
                ))}
              </ul>
            </div>
          )}
          {source === 'uploaded' && (
            <p className="border-t border-zinc-100 pt-3 text-xs text-zinc-400 dark:border-zinc-800">
              Inferred from the file name and type — the file contents aren&apos;t read yet.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">{label}</h3>
      <p className="leading-relaxed text-zinc-700 dark:text-zinc-300">{children}</p>
    </div>
  );
}

export function DocumentViewer(props: DocumentViewerProps) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      {/* Left: preview */}
      <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        {props.source === 'uploaded' ? (
          <UploadedPreview mimeType={props.mimeType} signedUrl={props.signedUrl} originalFilename={props.originalFilename} />
        ) : (
          props.createdPreview
        )}
      </div>

      {/* Right: AI breakdown */}
      <aside className="h-fit rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 lg:sticky lg:top-4">
        {props.source === 'uploaded' && (
          <div className="mb-4 border-b border-zinc-100 pb-4 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <div className="font-medium text-zinc-700 dark:text-zinc-200">{props.originalFilename ?? props.title}</div>
            <div className="mt-0.5">{[props.mimeType, humanSize(props.fileSize)].filter(Boolean).join(' · ')}</div>
          </div>
        )}
        <AiBreakdown
          id={props.id}
          source={props.source}
          initialBreakdown={props.initialBreakdown}
          initialStale={props.initialStale}
        />
      </aside>
    </div>
  );
}
