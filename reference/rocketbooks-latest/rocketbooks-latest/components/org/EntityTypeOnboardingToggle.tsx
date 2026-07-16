'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  enabled: boolean;
  /** Endpoint that accepts POST `{ enabled: boolean }`. */
  endpoint: string;
}

export function EntityTypeOnboardingToggle({ enabled: initial, endpoint }: Props) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    const next = !enabled;
    setError(null);
    setEnabled(next);
    startTransition(async () => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const msg = (await res.json().catch(() => null))?.error;
        setError(msg ?? 'Failed to save');
        setEnabled(!next);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={toggle}
        disabled={pending}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
          enabled
            ? 'bg-blue-600 dark:bg-blue-500'
            : 'bg-zinc-300 dark:bg-zinc-700'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
            enabled ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
