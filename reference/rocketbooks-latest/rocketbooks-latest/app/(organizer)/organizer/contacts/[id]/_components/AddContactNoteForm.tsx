'use client';

import { useActionState, useEffect, useRef } from 'react';
import { createNote, type CreateNoteState } from '@/app/(organizer)/organizer/dashboard/_actions/notes';

interface Props {
  contactId: string;
}

export function AddContactNoteForm({ contactId }: Props) {
  const [state, formAction, pending] = useActionState<CreateNoteState | undefined, FormData>(
    createNote,
    undefined,
  );
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (state?.ok && bodyRef.current) bodyRef.current.value = '';
  }, [state]);

  return (
    <form action={formAction} className="mt-3 flex flex-col gap-2">
      <input type="hidden" name="contactId" value={contactId} />
      <textarea
        ref={bodyRef}
        name="body"
        rows={3}
        required
        maxLength={5000}
        placeholder="Add a note about this contact…"
        className="w-full resize-none rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {pending ? 'Saving…' : 'Add note'}
        </button>
      </div>
      {state?.error && <p className="text-xs text-rose-600 dark:text-rose-400">{state.error}</p>}
    </form>
  );
}
