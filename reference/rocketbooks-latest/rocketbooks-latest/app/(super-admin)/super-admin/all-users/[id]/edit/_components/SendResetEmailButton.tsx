'use client';

import { useActionState } from 'react';
import {
  sendPasswordResetAction,
  type SendPasswordResetState,
} from '../../../../_actions/admin';

interface Props {
  userId: string;
  email: string;
}

export function SendResetEmailButton({ userId, email }: Props) {
  const [state, action, pending] = useActionState<SendPasswordResetState, FormData>(
    sendPasswordResetAction,
    undefined,
  );

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="userId" value={userId} />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Send password reset email</p>
        <p className="text-xs text-zinc-500">
          Emails a Supabase password-reset link to <span className="font-mono">{email}</span>. The user
          picks their own new password; you never see it. Link expires per your Supabase Auth
          settings.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          {pending ? 'Sending…' : 'Send reset email'}
        </button>
        {state?.ok === true && (
          <span className="text-sm text-emerald-600">{state.message}</span>
        )}
        {state?.ok === false && (
          <span className="text-sm text-red-600">{state.error}</span>
        )}
      </div>
    </form>
  );
}
