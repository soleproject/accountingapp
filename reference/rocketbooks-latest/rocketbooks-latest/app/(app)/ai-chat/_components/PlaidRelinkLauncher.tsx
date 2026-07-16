'use client';

import { useEffect, useRef, useState } from 'react';
import { usePlaidLink } from 'react-plaid-link';

interface Props {
  plaidItemId: string;
  onClose: () => void;
}

/**
 * Mounts when the cards panel triggers a Plaid reconnect. Fetches an
 * update-mode link token (no `products`, requires existing access_token —
 * server-side at /api/plaid/link/update-token) and opens Plaid Link.
 *
 * Update mode refreshes the existing access_token in place — no public token
 * exchange is required on success. Cards refresh on the next 15s poll cycle.
 */
export function PlaidRelinkLauncher({ plaidItemId, onClose }: Props) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/plaid/link/update-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plaidItemId }),
        });
        const body = (await r.json().catch(() => ({}))) as { linkToken?: string; error?: string; code?: string };
        if (cancelled) return;
        if (!r.ok || !body.linkToken) {
          setError(
            body.error ? `${body.error}${body.code ? ` (${body.code})` : ''}` : `Token mint failed: HTTP ${r.status}`,
          );
          return;
        }
        setLinkToken(body.linkToken);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Token mint failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [plaidItemId]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: () => onClose(),
    onExit: () => onClose(),
  });

  // Open the modal exactly once per token. Calling open() during render would
  // fire on every re-render of this component (voice transcripts cause many)
  // and Plaid's body-overflow toggling would leave the page un-scrollable.
  const openedTokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (linkToken && ready && openedTokenRef.current !== linkToken) {
      openedTokenRef.current = linkToken;
      open();
    }
  }, [linkToken, ready, open]);

  // Defensive: restore body overflow if Plaid's own cleanup is incomplete.
  useEffect(() => {
    return () => {
      if (typeof document !== 'undefined') {
        document.body.style.overflow = '';
      }
    };
  }, []);

  if (error) {
    return (
      <div
        role="alert"
        className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 shadow-lg dark:border-red-900 dark:bg-red-950/60 dark:text-red-200"
      >
        Plaid reconnect failed: {error}
        <button
          type="button"
          onClick={onClose}
          className="ml-2 underline hover:no-underline"
        >
          Dismiss
        </button>
      </div>
    );
  }
  return null;
}
