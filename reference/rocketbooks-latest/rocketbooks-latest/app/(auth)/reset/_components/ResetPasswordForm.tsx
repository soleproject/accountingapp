'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/browser';

type Status = 'waiting' | 'ready' | 'submitting' | 'success' | 'invalid';

export function ResetPasswordForm() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('waiting');
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);

  // Supabase parses the recovery token from the URL fragment automatically
  // on the browser client (detectSessionInUrl is true by default) and fires
  // a PASSWORD_RECOVERY event. We wait for that event before showing the
  // form -- if it never arrives, the link is invalid or expired.
  useEffect(() => {
    const supabase = createClient();
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setStatus('ready');
    });

    // Fallback: if the hash had no recovery token, the event won't fire.
    // Give it a beat, then mark the link invalid.
    const timeout = setTimeout(() => {
      setStatus((s) => (s === 'waiting' ? 'invalid' : s));
    }, 2500);

    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setStatus('submitting');
    setError(null);
    const supabase = createClient();
    const { error: updateErr } = await supabase.auth.updateUser({ password });
    if (updateErr) {
      setError(updateErr.message);
      setStatus('ready');
      return;
    }
    setStatus('success');
    // Sign out so the next sign-in uses the new password explicitly, then go to login.
    await supabase.auth.signOut();
    router.replace('/login');
  }

  if (status === 'waiting') {
    return <p className="text-center text-sm text-zinc-500">Verifying link…</p>;
  }

  if (status === 'invalid') {
    return (
      <div className="flex flex-col gap-3 text-center">
        <p className="text-sm text-red-600">This password reset link is invalid or has expired.</p>
        <a href="/login" className="text-sm text-blue-600 hover:underline">Back to sign in</a>
      </div>
    );
  }

  if (status === 'success') {
    return <p className="text-center text-sm text-emerald-600">Password updated. Redirecting…</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">New password</label>
        <div className="relative">
          <input
            id="password"
            type={visible ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            autoFocus
            placeholder="••••••••"
            className="w-full rounded-xl border border-zinc-300 bg-white/80 px-3.5 py-2.5 pr-16 text-sm shadow-sm outline-none transition placeholder:text-zinc-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900/60 dark:placeholder:text-zinc-500"
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
            aria-label={visible ? 'Hide password' : 'Show password'}
          >
            {visible ? 'Hide' : 'Show'}
          </button>
        </div>
        <p className="text-xs text-zinc-500">Minimum 8 characters.</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={status === 'submitting'}
        className="mt-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-60"
      >
        {status === 'submitting' ? 'Updating…' : 'Update password'}
      </button>
    </form>
  );
}
