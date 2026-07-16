'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import type { BillingPayload } from './BillingLoaded';

const BillingLoaded = dynamic(() => import('./BillingLoaded').then((m) => m.BillingLoaded), {
  loading: () => <BillingSkeleton />,
});

export function BillingClient({ query }: { query: string }) {
  const [payload, setPayload] = useState<BillingPayload | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false; setPayload(null); setError(false);
    fetch(`/api/billing/summary${query}`, { headers: { Accept: 'application/json' } })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`)))
      .then((data: BillingPayload) => { if (!cancelled) setPayload(data); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [query]);
  if (error) return <p className="text-sm text-amber-600">Billing is still loading. Refresh if this persists.</p>;
  if (!payload) return <BillingSkeleton />;
  return <BillingLoaded payload={payload} />;
}

function BillingSkeleton() { return <div className="space-y-4"><div className="h-10 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" /><div className="h-32 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" /><div className="h-48 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" /></div>; }
