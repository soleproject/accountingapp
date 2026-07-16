'use client';

import { useRef, useState, useTransition } from 'react';
import type { CommentResult } from '@/app/(app)/feedback/_actions/feedback';

interface Props {
  reportId: string;
  action: (formData: FormData) => Promise<CommentResult>;
  placeholder: string;
}

export function CommentForm({ reportId, action, placeholder }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const r = await action(formData);
      if (!r.ok) {
        setError(r.error ?? 'Failed to post comment');
        return;
      }
      formRef.current?.reset();
    });
  }

  return (
    <form
      ref={formRef}
      action={submit}
      className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
    >
      <input type="hidden" name="reportId" value={reportId} />
      <textarea
        name="body"
        rows={3}
        required
        maxLength={8000}
        placeholder={placeholder}
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
      />
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {pending ? 'Posting…' : 'Post comment'}
        </button>
      </div>
    </form>
  );
}
