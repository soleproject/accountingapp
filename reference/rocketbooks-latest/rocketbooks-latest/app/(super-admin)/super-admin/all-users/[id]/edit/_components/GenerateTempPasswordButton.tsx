'use client';

import { useActionState, useState } from 'react';
import {
  generateTempPasswordAction,
  type GenerateTempPasswordState,
} from '../../../../_actions/admin';

interface Props {
  userId: string;
  email: string;
}

export function GenerateTempPasswordButton({ userId, email }: Props) {
  const [state, action, pending] = useActionState<GenerateTempPasswordState, FormData>(
    generateTempPasswordAction,
    undefined,
  );
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    const ok = window.confirm(
      `Generate a new temporary password for ${email}? This immediately overwrites their current password.`,
    );
    if (!ok) {
      e.preventDefault();
      return;
    }
    setCopied(false);
    setDismissed(false);
  }

  async function handleCopy(password: string) {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (insecure context / permissions). The password
      // is already on screen so the admin can still copy by selecting it.
    }
  }

  const showResult = state?.ok === true && !dismissed;

  return (
    <form action={action} onSubmit={handleSubmit} className="flex flex-col gap-3">
      <input type="hidden" name="userId" value={userId} />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Generate temporary password</p>
        <p className="text-xs text-zinc-500">
          Replaces the user&apos;s current password with a random 18-character string. The new password
          is shown once below for you to share with the user; rocketsuite does not store it anywhere
          you can retrieve later.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          {pending ? 'Generating…' : 'Generate temp password'}
        </button>
        {state?.ok === false && (
          <span className="text-sm text-red-600">{state.error}</span>
        )}
      </div>
      {showResult && (
        <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/30">
          <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
            New password (shown once — copy now and share with the user)
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 select-all rounded border border-amber-200 bg-white px-3 py-2 font-mono text-sm dark:border-amber-800 dark:bg-zinc-900">
              {state.password}
            </code>
            <button
              type="button"
              onClick={() => handleCopy(state.password)}
              className="rounded-md border border-amber-300 px-3 py-2 text-xs font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/30"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="rounded-md border border-zinc-300 px-3 py-2 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
