'use client';

import { useTransition, useState } from 'react';
import {
  blockDocumentForOrganizationSwitch,
  replaceDocumentAfterOrganizationSwitch,
  unblockDocumentAfterOrganizationSwitchFailure,
} from '@/lib/auth/org-switch-client';

export function SwitchBusinessButton({ orgId }: { orgId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    blockDocumentForOrganizationSwitch();
    startTransition(async () => {
      let r: Response;
      try {
        r = await fetch('/api/orgs/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgId }),
        });
      } catch {
        unblockDocumentAfterOrganizationSwitchFailure();
        setError('Failed to switch');
        return;
      }
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        unblockDocumentAfterOrganizationSwitchFailure();
        setError(e.error ?? 'Failed to switch');
        return;
      }
      replaceDocumentAfterOrganizationSwitch();
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
      >
        {pending ? '…' : 'Switch'}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </>
  );
}
