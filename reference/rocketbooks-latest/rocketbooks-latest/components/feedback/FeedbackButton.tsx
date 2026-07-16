'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { submitFeedbackAction, type FeedbackKind } from '@/app/(app)/feedback/_actions/feedback';

export function FeedbackButton() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [pending, startTransition] = useTransition();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setTimeout(() => {
          setKind('bug');
          setTitle('');
          setDescription('');
          setError(null);
          setSubmitted(false);
        }, 150);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  function reset() {
    setKind('bug');
    setTitle('');
    setDescription('');
    setError(null);
    setSubmitted(false);
  }

  function close() {
    setOpen(false);
    // Reset on close so the next open is fresh, but delay so the closing
    // animation doesn't show the form snapping back.
    setTimeout(reset, 150);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const r = await submitFeedbackAction({
        kind,
        title,
        description,
        pageUrl: pathname ?? undefined,
      });
      if (!r.ok) {
        setError(r.error ?? 'Failed to submit');
        return;
      }
      setSubmitted(true);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        aria-haspopup="dialog"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
        Feedback
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-24"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-dialog-title"
            className="w-full max-w-lg rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 id="feedback-dialog-title" className="text-base font-semibold">
                  {submitted ? 'Thanks for the report' : 'Report a bug or recommendation'}
                </h2>
                {!submitted && (
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    You&apos;ll be able to track its status in your <Link href="/feedback" className="underline">feedback inbox</Link>.
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="rounded p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {submitted ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-zinc-700 dark:text-zinc-300">
                  We&apos;ve logged your report. A super admin will triage it; replies will appear in your{' '}
                  <Link href="/feedback" className="underline" onClick={close}>
                    feedback inbox
                  </Link>
                  .
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={reset}
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                  >
                    Submit another
                  </button>
                  <button
                    type="button"
                    onClick={close}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
                className="flex flex-col gap-3"
              >
                <fieldset className="flex gap-2" aria-label="Report type">
                  <KindRadio current={kind} value="bug" label="Bug" onChange={setKind} />
                  <KindRadio current={kind} value="recommendation" label="Recommendation" onChange={setKind} />
                </fieldset>

                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-medium uppercase text-zinc-500">Title</span>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={200}
                    required
                    placeholder={kind === 'bug' ? 'What went wrong?' : 'What would you like to see?'}
                    className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </label>

                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-medium uppercase text-zinc-500">Description</span>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={8000}
                    required
                    rows={6}
                    placeholder={
                      kind === 'bug'
                        ? 'What did you expect to happen? What happened instead? Steps to reproduce?'
                        : 'Describe the recommendation and the problem it solves.'
                    }
                    className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </label>

                {pathname && (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Submitted from <code className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-900">{pathname}</code>
                  </p>
                )}

                {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

                <div className="mt-1 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={close}
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={pending}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                  >
                    {pending ? 'Submitting…' : 'Submit'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function KindRadio({
  current,
  value,
  label,
  onChange,
}: {
  current: FeedbackKind;
  value: FeedbackKind;
  label: string;
  onChange: (k: FeedbackKind) => void;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
        active
          ? 'border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950/40 dark:text-blue-300'
          : 'border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900'
      }`}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}
