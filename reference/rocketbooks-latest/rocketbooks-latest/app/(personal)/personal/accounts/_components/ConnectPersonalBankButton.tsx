'use client';

import { useState, useCallback } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { useRouter } from 'next/navigation';

export function ConnectPersonalBankButton() {
  const router = useRouter();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleStart = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // The link-token route is user-scoped and works for both business and
      // personal links; only the exchange destination differs.
      const r = await fetch('/api/plaid/link/token', { method: 'POST' });
      const body = (await r.json().catch(() => ({}))) as { linkToken?: string; error?: string; code?: string };
      if (!r.ok) {
        throw new Error(body.error ? `${body.error}${body.code ? ` (${body.code})` : ''}` : `Failed to get link token: HTTP ${r.status}`);
      }
      if (!body.linkToken) throw new Error('No link token in response');
      setLinkToken(body.linkToken);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start');
      setBusy(false);
    }
  }, []);

  const onSuccess = useCallback(
    async (
      publicToken: string,
      metadata: {
        institution: { name: string; institution_id: string } | null;
        accounts: Array<{ id: string; name: string; mask: string; subtype: string; type: string }>;
      },
    ) => {
      try {
        const r = await fetch('/api/plaid/personal/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            publicToken,
            institutionId: metadata.institution?.institution_id,
            institutionName: metadata.institution?.name,
            accounts: metadata.accounts,
          }),
        });
        if (!r.ok) {
          const b = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error ?? `Exchange failed: ${r.status}`);
        }
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Exchange failed');
      } finally {
        setBusy(false);
        setLinkToken(null);
      }
    },
    [router],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => {
      setBusy(false);
      setLinkToken(null);
    },
  });

  if (linkToken && ready) {
    open();
  }

  return (
    <div className="flex items-center gap-3">
      {error && <span className="text-sm text-red-600">{error}</span>}
      <button
        type="button"
        onClick={handleStart}
        disabled={busy}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {busy ? 'Opening Plaid…' : '+ Connect an account'}
      </button>
    </div>
  );
}
