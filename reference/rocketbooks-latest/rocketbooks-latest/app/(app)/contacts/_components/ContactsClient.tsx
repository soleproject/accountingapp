'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import type { ContactsPayload } from './ContactsLoaded';

const ContactsLoaded = dynamic(() => import('./ContactsLoaded').then((m) => m.ContactsLoaded), {
  loading: () => <ContactsSkeleton />,
});

export function ContactsClient({ query }: { query: string }) {
  const [payload, setPayload] = useState<ContactsPayload | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPayload(null); setError(false);
    fetch(`/api/contacts/summary${query}`, { headers: { Accept: 'application/json' } })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`)))
      .then((data: ContactsPayload) => { if (!cancelled) setPayload(data); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [query]);
  if (error) return <p className="text-sm text-amber-600">Contacts are still loading. Refresh if this persists.</p>;
  if (!payload) return <ContactsSkeleton />;
  return <ContactsLoaded payload={payload} />;
}

function ContactsSkeleton() { return <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" />)}</div>; }
