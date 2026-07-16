'use client';

import { useActionState, useEffect } from 'react';
import { updateNoteAction, type UpdateNoteState } from '../_actions/notes';

interface ContactOption {
  id: string;
  name: string;
}

interface Props {
  noteId: string;
  initialBody: string;
  initialContactId: string | null;
  contacts: ContactOption[];
  onClose: () => void;
}

export function NoteEditForm({
  noteId,
  initialBody,
  initialContactId,
  contacts,
  onClose,
}: Props) {
  const [state, formAction, pending] = useActionState<UpdateNoteState | undefined, FormData>(
    updateNoteAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok) onClose();
  }, [state, onClose]);

  return (
    <form action={formAction} className="mt-2 flex flex-col gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <input type="hidden" name="id" value={noteId} />
      <textarea
        name="body"
        rows={3}
        required
        maxLength={5000}
        defaultValue={initialBody}
        className="w-full resize-none rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
      />
      <div className="flex items-center justify-between gap-2">
        <select
          name="contactId"
          defaultValue={initialContactId ?? ''}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950"
          aria-label="Contact (optional)"
        >
          <option value="">— No contact —</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      {state?.error && <p className="text-xs text-rose-600 dark:text-rose-400">{state.error}</p>}
    </form>
  );
}
