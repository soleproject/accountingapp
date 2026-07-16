import { AddNoteForm } from './AddNoteForm';
import { NoteRow } from './NoteRow';
import { CollapsibleCard } from './CollapsibleCard';

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
  notes: Note[];
  contacts: ContactOption[];
  /** noteId → number of tasks linked to it (reverse link badge). */
  linkedTaskCounts?: Record<string, number>;
}

export function RecentNotesCard({ notes, contacts, linkedTaskCounts }: Props) {
  const icon = (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-600 shadow-sm dark:bg-blue-900/40 dark:text-blue-300">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    </span>
  );

  return (
    <CollapsibleCard storageKey="rb-dash-collapse:recent-notes" title="Recent notes" icon={icon}>
      {notes.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          No notes yet — jot one below or have the AI log a conversation.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-3">
          {notes.map((n) => (
            <NoteRow key={n.id} note={n} contacts={contacts} linkedTaskCount={linkedTaskCounts?.[n.id] ?? 0} />
          ))}
        </ul>
      )}

      <AddNoteForm contacts={contacts} />
    </CollapsibleCard>
  );
}
