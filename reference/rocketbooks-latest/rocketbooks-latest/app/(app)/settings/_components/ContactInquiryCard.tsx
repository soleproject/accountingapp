'use client';

import { useState, useTransition } from 'react';
import { setContactInquiry } from '../_actions/contactInquiry';

/**
 * Org-level opt-in for the daily "what's this?" contact-inquiry email loop.
 * Requires inbound email to be configured (so the client's reply can route back
 * and be applied); shows a notice when it isn't.
 */
export function ContactInquiryCard({ enabled, inboundReady }: { enabled: boolean; inboundReady: boolean }) {
  const [on, setOn] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const save = (next: boolean) => {
    setError(null);
    startTransition(async () => {
      const r = await setContactInquiry(next);
      if (!r.ok) {
        setError(r.error ?? 'Save failed');
        setOn(!next);
      }
    });
  };

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Ask the Client About New Contacts</h2>
      </header>
      <div className="flex flex-col gap-4 px-4 py-3 text-sm">
        <p className="text-xs text-zinc-500">
          When on, the client gets a daily email about recent transactions whose other party we don&apos;t
          recognize yet. They just reply in plain English (&ldquo;Acme is our supplier, that was raw materials&rdquo;)
          and the AI applies it — categorizing the transaction, saving who the contact is, and optionally making a
          rule so it&apos;s automatic next time.
        </p>

        {!inboundReady && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            Inbound email isn&apos;t configured yet, so replies can&apos;t be received. This feature stays inactive
            until the inbound reply domain + webhook are set up — you can enable it now and it&apos;ll start working
            once that&apos;s done.
          </div>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Status</span>
          <select
            value={on ? 'on' : 'off'}
            onChange={(e) => {
              const next = e.target.value === 'on';
              setOn(next);
              save(next);
            }}
            disabled={isPending}
            className="max-w-xs rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950"
          >
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
        </label>

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        )}
        {isPending && <div className="text-xs text-zinc-500">Saving…</div>}
      </div>
    </section>
  );
}
