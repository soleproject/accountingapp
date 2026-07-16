'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { PinnedContactCard as PinnedContact } from './AssistantContext';

interface AcceptRuleState { ok?: boolean; verified?: number; error?: string }

/** The "categorize the rest of this contact" card pinned in the sidecar. */
export function ContactPinnedCard({ contact, onDone }: { contact: PinnedContact; onDone: () => void }) {
  const [state, setState] = useState<AcceptRuleState>();
  const [pending, setPending] = useState(false);
  const router = useRouter();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    try {
      const response = await fetch('/api/transactions/accept-contact-categorization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: contact.contactId, categoryAccountId: contact.categoryAccountId, transactionType: contact.transactionType ?? null }),
      });
      const result = await response.json() as AcceptRuleState;
      if (!response.ok && !result.error) result.error = 'Could not categorize those transactions.';
      setState(result);
      if (result.ok) {
        onDone();
        if (contact.returnTo) router.push(contact.returnTo);
        router.refresh();
      }
    } catch {
      setState({ error: 'Could not categorize those transactions.' });
    } finally {
      setPending(false);
    }
  };

  const many = contact.count !== 1;
  return (
    <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Categorize the rest of {contact.contactName}?</div>
        <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
          {contact.count} other {contact.contactName} transaction{many ? 's' : ''} {many ? 'aren’t' : 'isn’t'} categorized as{' '}
          <strong className="text-zinc-800 dark:text-zinc-200">{contact.categoryName}</strong>. Categorize {many ? 'them all' : 'it'} that way and mark reviewed.
        </p>
        {state?.error && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{state.error}</p>}
        <div className="mt-2 flex items-center justify-end gap-2">
          <button type="button" onClick={onDone} className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">Not now</button>
          <form onSubmit={submit}>
            <button type="submit" disabled={pending} className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {pending ? 'Working…' : 'Categorize all & verify'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
