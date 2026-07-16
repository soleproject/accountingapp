'use client';

import { useActionState, useEffect, useRef } from 'react';
import { updatePasswordAction, type UpdatePasswordState } from '../_actions/password';

export function UpdatePasswordForm() {
  const [state, action, pending] = useActionState<UpdatePasswordState, FormData>(
    updatePasswordAction,
    undefined,
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state && 'ok' in state && state.ok) formRef.current?.reset();
  }, [state]);

  const fieldErrors = state && 'fieldErrors' in state ? state.fieldErrors : undefined;
  const errorMsg = state && 'error' in state ? state.error : undefined;
  const success = state && 'ok' in state && state.ok;

  return (
    <form ref={formRef} action={action} className="flex max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="currentPassword" className="text-sm font-medium">
          Current password
        </label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          required
          autoComplete="current-password"
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
        />
        {fieldErrors?.currentPassword && (
          <p className="text-xs text-red-600">{fieldErrors.currentPassword.join(', ')}</p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="newPassword" className="text-sm font-medium">
          New password
        </label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
        />
        {fieldErrors?.newPassword && (
          <p className="text-xs text-red-600">{fieldErrors.newPassword.join(', ')}</p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="confirmPassword" className="text-sm font-medium">
          Confirm new password
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
        />
        {fieldErrors?.confirmPassword && (
          <p className="text-xs text-red-600">{fieldErrors.confirmPassword.join(', ')}</p>
        )}
      </div>
      {errorMsg && !fieldErrors && <p className="text-sm text-red-600">{errorMsg}</p>}
      {success && <p className="text-sm text-emerald-600">Password updated.</p>}
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
      >
        {pending ? 'Updating…' : 'Update password'}
      </button>
    </form>
  );
}
