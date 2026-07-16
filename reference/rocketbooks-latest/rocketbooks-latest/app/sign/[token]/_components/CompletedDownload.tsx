'use client';

import { useState } from 'react';
import { getCompletedUrlByTokenAction } from '../_actions/sign';

export function CompletedDownload({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    const res = await getCompletedUrlByTokenAction(token);
    setBusy(false);
    if (res.ok && res.url) window.open(res.url, '_blank', 'noopener');
    else setError('Download is not available right now.');
  };

  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-8 dark:border-emerald-900/40 dark:bg-emerald-950/20">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">This document is fully signed</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">Download the completed PDF with all signatures and the certificate of completion.</p>
        <button type="button" onClick={download} disabled={busy} className="mt-5 rounded-full bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
          {busy ? 'Preparing…' : 'Download signed PDF'}
        </button>
        {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
      </div>
    </div>
  );
}
