'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { recategorizeAction } from '../_actions/recategorize';

export interface CategoryOption {
  name: string;
  groupName: string;
}

interface Props {
  txnId: string;
  merchant: string | null;
  current: string | null;
  categories: CategoryOption[];
}

export function CategoryCell({ txnId, merchant, current, categories }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [applyAll, setApplyAll] = useState(false);
  const [pending, startTransition] = useTransition();
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Group the flat category list for the menu, preserving incoming order.
  const groups: { group: string; items: CategoryOption[] }[] = [];
  for (const c of categories) {
    let g = groups.find((x) => x.group === c.groupName);
    if (!g) { g = { group: c.groupName, items: [] }; groups.push(g); }
    g.items.push(c);
  }

  const choose = (name: string) => {
    setOpen(false);
    startTransition(async () => {
      await recategorizeAction({ txnId, categoryName: name, applyToMerchant: applyAll && !!merchant });
      router.refresh();
    });
  };

  return (
    <div className="relative inline-block" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={pending}
        className={`rounded px-1.5 py-0.5 text-xs transition-colors disabled:opacity-50 ${
          current
            ? 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
            : 'border border-dashed border-zinc-300 text-zinc-400 hover:border-zinc-400 dark:border-zinc-700'
        }`}
      >
        {pending ? '…' : current ?? 'Uncategorized'}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-80 w-60 overflow-y-auto rounded-md border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
          {merchant && (
            <label className="flex cursor-pointer items-center gap-2 border-b border-zinc-100 px-2 py-1.5 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
              <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} className="h-3.5 w-3.5" />
              <span className="truncate">Apply to all from “{merchant}”</span>
            </label>
          )}
          {groups.map((g) => (
            <div key={g.group}>
              <div className="px-2 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{g.group}</div>
              {g.items.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => choose(c.name)}
                  className={`flex w-full items-center rounded px-2 py-1 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900 ${
                    c.name === current ? 'font-medium text-zinc-900 dark:text-zinc-100' : 'text-zinc-700 dark:text-zinc-300'
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
