'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addBusinessAction } from '@/app/(app)/businesses/_actions/addBusiness';

/**
 * Compact version of DemoBanner's primary CTA, rendered in the TopBar
 * while the demo banner is dismissed. Same path as the banner button:
 * addBusinessAction creates a fresh org server-side and the response
 * carries the next route (typically /ai-chat?welcome=fresh).
 */
export function CreateWorkspacePill() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    startTransition(async () => {
      const r = await addBusinessAction();
      if (!r.ok || !r.redirectTo) {
        setError(r.error ?? 'Failed to create workspace');
        return;
      }
      if (r.redirectTo.startsWith('http')) {
        window.location.assign(r.redirectTo);
      } else {
        router.push(r.redirectTo);
      }
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      title={error ?? 'Create your own workspace from the demo'}
      className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-amber-600 disabled:opacity-60"
    >
      {pending ? 'Creating…' : 'Create workspace'}
    </button>
  );
}
