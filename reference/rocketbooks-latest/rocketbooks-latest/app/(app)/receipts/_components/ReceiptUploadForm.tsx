'use client';

import { useActionState, useState } from 'react';
import { uploadReceipt, type UploadReceiptState } from '../_actions/uploadReceipt';

export function ReceiptUploadForm() {
  const [state, action, pending] = useActionState<UploadReceiptState | undefined, FormData>(uploadReceipt, undefined);
  const [filename, setFilename] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);

  return (
    <form action={action} className="flex max-w-xl flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Receipt file</label>
        <input
          type="file"
          name="file"
          accept=".pdf,.jpg,.jpeg,.png"
          required
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              setFilename(f.name);
              setSize(f.size);
            }
          }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-zinc-200 file:px-3 file:py-1 file:text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:file:bg-zinc-700 dark:file:text-zinc-100"
        />
        {filename && size != null && (
          <p className="text-xs text-zinc-500">
            {filename} · {(size / 1024).toFixed(1)} KB
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending || !filename} className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
          {pending ? 'Extracting via Veryfi…' : 'Upload & extract'}
        </button>
        {state?.error && <span className="text-sm text-red-600">{state.error}</span>}
      </div>

      <p className="text-xs text-zinc-500">
        Requires <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">VERYFI_CLIENT_ID</code>,{' '}
        <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">VERYFI_USERNAME</code>,{' '}
        <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">VERYFI_API_KEY</code> on Vercel.
      </p>
    </form>
  );
}
