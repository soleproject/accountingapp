'use client';

import { useActionState } from 'react';
import { saveSubdomainAction, type SubdomainState } from '../_actions/subdomain';

export function SubdomainCard({ current, root }: { current: string | null; root: string }) {
  const [state, action, pending] = useActionState<SubdomainState | undefined, FormData>(saveSubdomainAction, undefined);
  const live = state?.ok ? state.value : current;

  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          name="subdomain"
          defaultValue={current ?? ''}
          placeholder="acme"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="w-44 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
        <span className="text-sm text-zinc-500">.{root}</span>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state?.ok && <p className="text-sm text-emerald-600">Saved.</p>}
      {live && (
        <p className="text-xs text-zinc-500">
          Your clients sign in at <span className="font-medium">https://{live}.{root}</span>
        </p>
      )}
    </form>
  );
}
