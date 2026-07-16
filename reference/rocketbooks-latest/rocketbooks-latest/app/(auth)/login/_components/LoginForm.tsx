'use client';

import { type FormEvent, useMemo, useState, useSyncExternalStore } from 'react';
import { createClient } from '@/lib/supabase/browser';
import { signInForBrowser } from '@/lib/auth/login-browser';

interface Props {
  next?: string;
}

function safeNextPath(rawNext: string | undefined): string {
  if (
    rawNext?.startsWith('/') &&
    !rawNext.startsWith('//') &&
    !rawNext.startsWith('/\\')
  ) {
    return rawNext;
  }
  return '/dashboard';
}

function clearDismissalCookie(name: string) {
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

const subscribeToHydration = () => () => {};

export function LoginForm({ next }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const [pending, setPending] = useState(false);
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim().toLowerCase();
    const password = String(form.get('password') ?? '');
    if (!email || !password) {
      setError('Enter your email and password.');
      setPending(false);
      return;
    }

    try {
      const result = await signInForBrowser(supabase, { email, password });
      if (!result.ok) {
        setError(result.message);
        setPending(false);
        return;
      }

      clearDismissalCookie('rs_trial_banner_dismissed');
      clearDismissalCookie('rs_demo_banner_dismissed');
      window.location.assign(safeNextPath(next));
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Sign-in failed. Please try again.');
      setPending(false);
    }
  }

  return (
    <form method="post" onSubmit={onSubmit} className="flex w-full flex-col gap-4">
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
          autoFocus
          placeholder="you@company.com"
          className="rounded-xl border border-zinc-300 bg-white/80 px-3.5 py-2.5 text-sm shadow-sm outline-none transition placeholder:text-zinc-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900/60 dark:placeholder:text-zinc-500"
        />
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
          autoComplete="current-password"
          placeholder="••••••••"
          className="rounded-xl border border-zinc-300 bg-white/80 px-3.5 py-2.5 text-sm shadow-sm outline-none transition placeholder:text-zinc-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900/60 dark:placeholder:text-zinc-500"
        />
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">{error}</p>
      )}
      <button
        type="submit"
        disabled={!hydrated || pending}
        className="mt-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-60"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
