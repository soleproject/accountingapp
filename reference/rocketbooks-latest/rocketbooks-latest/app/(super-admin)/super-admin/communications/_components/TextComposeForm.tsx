'use client';

import { useState, useTransition } from 'react';
import { sendAdminSmsAction } from '../_actions/sendAdminSms';

interface Props {
  /** Whether the full Twilio env (SID + token + from number) is set on
   *  the server. When false we still let the operator click Send (the
   *  action records a 'skipped' row), but we surface a warning banner
   *  so they know nothing actually leaves the building. */
  twilioConfigured: boolean;
}

// GSM-7 single-segment cap is 160; UCS-2 (any non-GSM char) is 70.
// We don't try to detect encoding client-side — just warn at the
// safer 160 boundary so the operator knows they're about to be
// billed for multiple segments.
const SINGLE_SEGMENT = 160;

export function TextComposeForm({ twilioConfigured }: Props) {
  const [body, setBody] = useState<string>('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (formData: FormData) => {
    setError(null);
    startTransition(async () => {
      try {
        await sendAdminSmsAction(formData);
      } catch (err) {
        // redirect() from a server action throws NEXT_REDIRECT which
        // we should let propagate — only real errors land here.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('NEXT_REDIRECT')) return;
        setError(msg);
      }
    });
  };

  const hasBody = body.trim().length > 0;
  const len = body.length;
  const estimatedSegments = len === 0 ? 0 : Math.ceil(len / SINGLE_SEGMENT);

  return (
    <form action={handleSubmit} className="flex flex-col gap-4">
      {!twilioConfigured && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <strong>Twilio is not configured.</strong> Sends from this page will be logged as <code>skipped</code>; no text will actually be delivered. Set <code>TWILIO_ACCOUNT_SID</code>, <code>TWILIO_AUTH_TOKEN</code>, and <code>TWILIO_FROM_NUMBER</code> to enable.
        </div>
      )}

      <Field label="To" htmlFor="toPhone" hint="E.164 format (e.g. +15551234567). US 10-digit numbers will auto-prefix +1.">
        <input
          id="toPhone"
          name="toPhone"
          type="tel"
          required
          autoComplete="off"
          placeholder="+15551234567"
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
        />
      </Field>

      <Field label="Message" htmlFor="body">
        <textarea
          id="body"
          name="body"
          required
          rows={5}
          maxLength={1600}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="w-full resize-y rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
        />
        <div className="mt-1 flex justify-between text-xs text-zinc-500">
          <span>
            {len > SINGLE_SEGMENT && (
              <span className="text-amber-600 dark:text-amber-400">
                Will be billed as {estimatedSegments} segments.
              </span>
            )}
          </span>
          <span className="tabular-nums">{len} / 1600</span>
        </div>
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
          {isPending ? 'Sending…' : 'Send text'}
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
