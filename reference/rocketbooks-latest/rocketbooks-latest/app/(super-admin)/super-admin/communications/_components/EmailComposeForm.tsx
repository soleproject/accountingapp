'use client';

import dynamic from 'next/dynamic';
import { useState, useTransition } from 'react';
import { sendAdminEmailAction } from '../_actions/sendAdminEmail';

const EmailBodyEditor = dynamic(
  () => import('./EmailBodyEditor').then((mod) => mod.EmailBodyEditor),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-[220px] rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
        Loading email editor…
      </div>
    ),
  },
);

interface Props {
  /** Logged-in super-admin's email — used as the default Reply-To so
   *  replies route to them, not to the no-reply alias. */
  defaultReplyTo: string;
  /** Whether RESEND_API_KEY is set on the server. When false we still
   *  let the operator click Send (the action records a 'skipped' row),
   *  but we surface a warning banner so they know nothing actually
   *  leaves the building. */
  resendConfigured: boolean;
}

/**
 * Client-side composer. Lives outside the page component so Tiptap (a
 * client-only library) can mount, and so we can manage the HTML body
 * as React state and post it via a hidden input on submit.
 */
export function EmailComposeForm({ defaultReplyTo, resendConfigured }: Props) {
  const [bodyHtml, setBodyHtml] = useState<string>('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (formData: FormData) => {
    setError(null);
    // Inject the Tiptap-managed HTML into the form data the server
    // action consumes. We could use a hidden <input value={bodyHtml}>
    // but stashing it here keeps the DOM clean and avoids hydration
    // warnings if the HTML contains characters that need escaping.
    formData.set('bodyHtml', bodyHtml);
    startTransition(async () => {
      try {
        await sendAdminEmailAction(formData);
      } catch (err) {
        // redirect() from a server action throws NEXT_REDIRECT which
        // we should let propagate — only real errors land here.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('NEXT_REDIRECT')) return;
        setError(msg);
      }
    });
  };

  const hasBody = bodyHtml.replace(/<[^>]+>/g, '').trim().length > 0;

  return (
    <form action={handleSubmit} className="flex flex-col gap-4">
      {!resendConfigured && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <strong>RESEND_API_KEY is not configured.</strong> Sends from this page will be logged as <code>skipped</code>; no email will actually be delivered.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="To" htmlFor="toEmail">
          <input
            id="toEmail"
            name="toEmail"
            type="email"
            required
            placeholder="recipient@example.com"
            className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
        </Field>
        <Field label="Reply-to" htmlFor="replyTo" hint="Defaults to your address if blank">
          <input
            id="replyTo"
            name="replyTo"
            type="email"
            defaultValue={defaultReplyTo}
            placeholder={defaultReplyTo}
            className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
        </Field>
      </div>

      <Field label="Subject" htmlFor="subject">
        <input
          id="subject"
          name="subject"
          type="text"
          required
          maxLength={200}
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
        />
      </Field>

      <Field label="Body" htmlFor="bodyHtml">
        <EmailBodyEditor onChange={setBodyHtml} />
      </Field>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="submit"
          disabled={isPending || !hasBody}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? 'Sending…' : 'Send email'}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-zinc-700 dark:text-zinc-300">
        {label}
        {hint && <span className="ml-2 font-normal text-zinc-400">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
