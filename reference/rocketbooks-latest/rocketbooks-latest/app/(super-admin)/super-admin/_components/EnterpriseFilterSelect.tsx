'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTransition } from 'react';

interface Option {
  id: string;
  name: string;
}

interface Props {
  options: Option[];
  /** Search-param key this select drives. Defaults to 'enterpriseId'. */
  paramName?: string;
}

/**
 * Self-contained select that mirrors the existing filter-chip behavior:
 * picking a value updates the URL (preserving every other query param,
 * resetting 'page' to 1).
 */
export function EnterpriseFilterSelect({ options, paramName = 'enterpriseId' }: Props) {
  const router = useRouter();
  const pathname = usePathname() ?? '/super-admin/all-users';
  const sp = useSearchParams();
  const current = sp?.get(paramName) ?? '';
  const [pending, startTransition] = useTransition();

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = new URLSearchParams(sp?.toString() ?? '');
    if (e.target.value) next.set(paramName, e.target.value);
    else next.delete(paramName);
    next.delete('page'); // any filter change resets pagination
    const qs = next.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  };

  return (
    <select
      value={current}
      onChange={onChange}
      disabled={pending}
      className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950"
    >
      <option value="">All Enterprises</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}
