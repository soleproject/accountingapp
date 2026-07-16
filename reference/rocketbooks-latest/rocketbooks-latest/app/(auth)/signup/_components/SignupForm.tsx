'use client';

import { useActionState } from 'react';
import { trialSignup, type SignupState } from '../_actions/signup';

interface Props {
  enterpriseId: string;
  /** Present when the visitor arrived via ?ref=<slug>. Hidden field is
   *  optional; the action re-resolves the slug server-side anyway. */
  inviteSlug: string | null;
  /** Plan deep-linked from the marketing pricing page (?plan=starter|plus|pro).
   *  Carried so the new org starts the trial on that plan; re-validated server-side. */
  plan?: string | null;
}

export function SignupForm({ enterpriseId, inviteSlug, plan }: Props) {
  const [state, action, pending] = useActionState<SignupState, FormData>(trialSignup, undefined);

  return (
    <form action={action} className="flex w-full flex-col gap-4">
      <input type="hidden" name="enterpriseId" value={enterpriseId} />
      {inviteSlug && <input type="hidden" name="inviteSlug" value={inviteSlug} />}
      {plan && <input type="hidden" name="plan" value={plan} />}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="fullName" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Full name
        </label>
        <input
          id="fullName"
          name="fullName"
          type="text"
          required
          autoComplete="name"
          autoFocus
          className="rounded-xl border border-zinc-300 bg-white/80 px-3.5 py-2.5 text-sm shadow-sm outline-none transition placeholder:text-zinc-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900/60 dark:placeholder:text-zinc-500"
        />
        {state?.fieldErrors?.fullName && (
          <p className="text-xs text-red-600">{state.fieldErrors.fullName.join(', ')}</p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="companyName" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Company name
        </label>
        <input
          id="companyName"
          name="companyName"
          type="text"
          required
          autoComplete="organization"
          className="rounded-xl border border-zinc-300 bg-white/80 px-3.5 py-2.5 text-sm shadow-sm outline-none transition placeholder:text-zinc-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900/60 dark:placeholder:text-zinc-500"
        />
        {state?.fieldErrors?.companyName && (
          <p className="text-xs text-red-600">{state.fieldErrors.companyName.join(', ')}</p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="rounded-xl border border-zinc-300 bg-white/80 px-3.5 py-2.5 text-sm shadow-sm outline-none transition placeholder:text-zinc-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900/60 dark:placeholder:text-zinc-500"
        />
        {state?.fieldErrors?.email && (
          <p className="text-xs text-red-600">{state.fieldErrors.email.join(', ')}</p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="rounded-xl border border-zinc-300 bg-white/80 px-3.5 py-2.5 text-sm shadow-sm outline-none transition placeholder:text-zinc-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900/60 dark:placeholder:text-zinc-500"
        />
        {state?.fieldErrors?.password && (
          <p className="text-xs text-red-600">{state.fieldErrors.password.join(', ')}</p>
        )}
      </div>
      {state?.error && !state.fieldErrors && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">{state.error}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="mt-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-60"
      >
        {pending ? 'Creating account…' : 'Start free 7-day trial'}
      </button>
      <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">
        Card required to start — no charge for 7 days, cancel anytime.
      </p>
    </form>
  );
}
