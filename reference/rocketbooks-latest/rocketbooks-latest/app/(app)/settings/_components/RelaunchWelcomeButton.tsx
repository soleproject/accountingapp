'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { resetWelcomeAction } from '@/app/(app)/dashboard/_actions/welcome';

/**
 * Settings-side replay of the dashboard welcome takeover. Clears
 * users.welcome_dismissed_at and navigates to /dashboard?welcome=fresh so
 * the full Hello → 3-chip experience runs again (typewriter, TTS, chip
 * options, including the cool tour and the spotlight tour). Mirrors the
 * TopBar Tour button but lives in Settings for users who want to find it
 * via the deliberate-settings path rather than the always-visible header.
 */
export function RelaunchWelcomeButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          await resetWelcomeAction();
          router.push('/dashboard?welcome=fresh');
        });
      }}
      className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
      </svg>
      {pending ? 'Opening…' : 'Replay welcome'}
    </button>
  );
}
