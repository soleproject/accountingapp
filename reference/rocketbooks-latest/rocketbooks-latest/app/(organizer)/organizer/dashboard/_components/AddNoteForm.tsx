'use client';

import { useActionState, useEffect, useRef } from 'react';
import { createNote, type CreateNoteState } from '../_actions/notes';

interface ContactOption {
  id: string;
  name: string;
}

interface Props {
  contacts: ContactOption[];
}

export function AddNoteForm({ contacts }: Props) {
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
      <textarea
        ref={bodyRef}
        name="body"
        rows={2}
        required
        maxLength={5000}
        placeholder="Quick note…"
        className="w-full resize-none rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
      />
      <div className="flex items-center justify-between gap-2">
        <select
          name="contactId"
          defaultValue=""
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950"
          aria-label="Contact (optional)"
        >
          <option value="">— No contact —</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {pending ? 'Saving…' : 'Add note'}
        </button>
      </div>
      {state?.error && <p className="text-xs text-rose-600 dark:text-rose-400">{state.error}</p>}
    </form>
  );
}
