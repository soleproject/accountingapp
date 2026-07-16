'use client';

import { useActionState } from 'react';
import type { ProductFormState } from '../_actions/products';

/**
 * Submit button for the Stripe link/sync actions, wired through useActionState
 * so a failure (e.g. "Refusing to use sk_live_ outside production") renders
 * inline instead of throwing a full-page server error.
 */
export function StripeSyncButton({
  action,
  id,
  label,
  variant = 'primary',
}: {
  action: (prev: ProductFormState, formData: FormData) => Promise<ProductFormState>;
  id: string;
  label: string;
  variant?: 'primary' | 'secondary';
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const cls =
    variant === 'secondary'
      ? 'rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900'
      : 'rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-60';
  return (
    <form action={formAction} className="flex flex-col gap-1.5">
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={pending} className={cls}>
        {pending ? 'Working…' : label}
      </button>
      {state?.error && <span className="text-xs text-red-600 dark:text-red-400">{state.error}</span>}
      {state?.ok && <span className="text-xs text-emerald-600 dark:text-emerald-400">Done.</span>}
    </form>
  );
}
