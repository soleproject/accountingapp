'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { TRIAL_BANNER_DISMISSED_COOKIE } from '@/app/(app)/_actions/trial-banner-constants';
import { DEMO_BANNER_DISMISSED_COOKIE } from '@/app/(app)/_actions/demo-banner-constants';

const LoginSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1),
});

export type LoginState =
  | { error: string; fieldErrors?: Record<string, string[]> }
  | undefined;

const isAbort = (msg?: string | null) => !!msg && /abort/i.test(msg);

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = LoginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return {
      error: 'Invalid input',
      fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = await createClient();
  const attempt = () =>
    supabase.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });

  // An abort here is almost always a transient cold-connection / network blip
  // (Supabase auth itself is fast). Retry ONCE on abort — a fresh fetch with a
  // warm connection usually succeeds — and only then surface a friendly message.
  // Wrong credentials never abort, so they never trigger a retry.
  let signInResult: Awaited<ReturnType<typeof attempt>> | undefined;
  try {
    signInResult = await attempt();
    if (signInResult.error && isAbort(signInResult.error.message)) {
      signInResult = await attempt();
    }
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || isAbort(err.message))) {
      try {
        signInResult = await attempt();
      } catch {
        return { error: 'Sign-in timed out reaching authentication. Please try again.' };
      }
    } else {
      const message = err instanceof Error ? err.message : String(err);
      return { error: message || 'Sign-in failed. Please try again.' };
    }
  }

  if (!signInResult) return { error: 'Sign-in failed. Please try again.' };
  const { error } = signInResult;
  if (error) {
    if (isAbort(error.message)) {
      return { error: 'Sign-in timed out reaching authentication. Please try again.' };
    }
    return { error: error.message || 'Invalid credentials' };
  }

  // Reset per-session UI dismissals — banners should reappear on every
  // fresh sign-in even when the browser kept the cookies alive.
  const cookieStore = await cookies();
  cookieStore.delete(TRIAL_BANNER_DISMISSED_COOKIE);
  cookieStore.delete(DEMO_BANNER_DISMISSED_COOKIE);

  const rawNext = String(formData.get('next') ?? '/dashboard');
  // Only allow same-origin internal paths. Reject "//evil.com", "/\evil.com",
  // and protocol-relative URLs that browsers would treat as cross-origin.
  const safeNext =
    rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.startsWith('/\\')
      ? rawNext
      : '/dashboard';
  redirect(safeNext);
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
