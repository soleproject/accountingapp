'use client';

import Link from 'next/link';
import { useState } from 'react';
import { NoteEditForm } from './NoteEditForm';
import { NoteDeleteButton } from './NoteDeleteButton';

interface Note {
  id: string;
  body: string;
  source: string;
  createdAt: string;
  contactId: string | null;
  contactName: string | null;
}

interface ContactOption {
  id: string;
  name: string;
}

interface Props {
  note: Note;
  contacts: ContactOption[];
  /**
   * When true, omit the contact link in the metadata line. Used on the
   * contact drill-in page where every note already belongs to the
   * contact shown in the header — repeating it on every row is noise.
   */
  hideContactMetadata?: boolean;
  /** How many tasks link to this note (reverse of the task → note link). */
  linkedTaskCount?: number;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function NoteRow({ note, contacts, hideContactMetadata = false, linkedTaskCount = 0 }: Props) {
  const [editing, setEditing] = useState(false);

  return (
    <li className="border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
      <div className="flex items-start justify-between gap-2">
        <p className="flex-1 whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">
          {note.body}
        </p>
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-label="Edit note"
            aria-expanded={editing}
            title={editing ? 'Cancel edit' : 'Edit this note'}
            className={`inline-flex h-6 w-6 items-center justify-center rounded ${
              editing
                ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-500 dark:hover:bg-zinc-900 dark:hover:text-zinc-200'
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
            </svg>
          </button>
          <NoteDeleteButton noteId={note.id} preview={note.body} />
        </div>
      </div>
      <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-500">
        {timeAgo(note.createdAt)}
        {!hideContactMetadata && note.contactName && (
          <>
            {' · '}
            {note.contactId ? (
              <Link
                href={`/organizer/contacts/${note.contactId}`}
                className="text-zinc-600 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                {note.contactName}
              </Link>
            ) : (
              note.contactName
            )}
          </>
        )}
        {note.source === 'ai' ? ' · AI' : ''}
        {linkedTaskCount > 0 && (
          <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300" title={`${linkedTaskCount} linked task${linkedTaskCount === 1 ? '' : 's'}`}>
            🔗 {linkedTaskCount}
          </span>
        )}
      </p>

      {editing && (
        <NoteEditForm
          noteId={note.id}
          initialBody={note.body}
          initialContactId={note.contactId}
          contacts={contacts}
          onClose={() => setEditing(false)}
        />
      )}
    </li>
  );
}
