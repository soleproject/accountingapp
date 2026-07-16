'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  PERMISSION_SECTIONS,
  type PermissionItem,
  type ProductSection,
} from '@/lib/permissions/structure';
import { setPermissionSetPermissionsAction } from '../_actions/admin';

interface Props {
  setId: string;
  initialKeys: string[];
}

function flattenSectionItems(section: ProductSection): PermissionItem[] {
  return [
    ...section.groups.flatMap((g) => g.items),
    ...section.unpublished,
  ];
}

function matchesSearch(item: PermissionItem, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  return (
    item.key.toLowerCase().includes(q) ||
    item.label.toLowerCase().includes(q) ||
    (item.path ?? '').toLowerCase().includes(q)
  );
}

function filterSection(section: ProductSection, query: string): ProductSection | null {
  if (!query.trim()) return section;
  const filteredGroups = section.groups
    .map((g) => ({ ...g, items: g.items.filter((i) => matchesSearch(i, query)) }))
    .filter((g) => g.items.length > 0);
  const filteredUnpublished = section.unpublished.filter((i) => matchesSearch(i, query));
  if (filteredGroups.length === 0 && filteredUnpublished.length === 0) return null;
  return { ...section, groups: filteredGroups, unpublished: filteredUnpublished };
}

export function PermissionSetEditor({ setId, initialKeys }: Props) {
  const router = useRouter();
  const [keys, setKeys] = useState<Set<string>>(() => new Set(initialKeys));
  const [savedSnapshot, setSavedSnapshot] = useState<string>(() => JSON.stringify([...initialKeys].sort()));
  const [query, setQuery] = useState('');
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    PERMISSION_SECTIONS.forEach((s) => (init[s.id] = false));
    init['accounting'] = true;
    return init;
  });

  const filtered = useMemo(
    () => PERMISSION_SECTIONS.map((s) => filterSection(s, query)).filter((s): s is ProductSection => s !== null),
    [query],
  );

  const currentSnapshot = useMemo(() => JSON.stringify([...keys].sort()), [keys]);
  const dirty = currentSnapshot !== savedSnapshot;

  const persist = (nextKeys: Set<string>) => {
    setError(null);
    const fd = new FormData();
    fd.set('setId', setId);
    for (const k of nextKeys) fd.append('keys', k);
    startTransition(async () => {
      try {
        await setPermissionSetPermissionsAction(fd);
        setSavedSnapshot(JSON.stringify([...nextKeys].sort()));
        setSavedAt(Date.now());
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Save failed');
      }
    });
  };

  const togglePermission = (key: string) => {
    const next = new Set(keys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setKeys(next);
    persist(next);
  };

  const setManyEnabled = (items: PermissionItem[], enable: boolean) => {
    const next = new Set(keys);
    for (const it of items) {
      if (enable) next.add(it.key);
      else next.delete(it.key);
    }
    setKeys(next);
    persist(next);
  };

  const allChecked = (items: PermissionItem[]) => items.length > 0 && items.every((i) => keys.has(i.key));
  const anyChecked = (items: PermissionItem[]) => items.some((i) => keys.has(i.key));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          type="text"
          placeholder="Search permissions..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full max-w-md rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
        <div className="flex items-center gap-2 text-xs">
          <span className="text-zinc-500">{keys.size} permission{keys.size === 1 ? '' : 's'} active</span>
          {pending ? (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">Saving…</span>
          ) : dirty ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">Unsaved</span>
          ) : savedAt ? (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">Saved</span>
          ) : null}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500 dark:border-zinc-800">
          No permissions match your search.
        </div>
      ) : (
        filtered.map((section) => {
          const open = expanded[section.id] ?? false;
          const sectionItems = flattenSectionItems(section);
          const sectAll = allChecked(sectionItems);
          const sectAny = anyChecked(sectionItems);
          return (
            <section key={section.id} className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50/40 dark:border-zinc-800 dark:bg-zinc-900/30">
              <header className="flex items-center justify-between px-4 py-3">
                <button
                  type="button"
                  onClick={() => setExpanded((s) => ({ ...s, [section.id]: !open }))}
                  className="flex flex-1 items-center gap-2 text-left text-sm font-semibold text-zinc-800 dark:text-zinc-200"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? 'rotate-90' : ''}`}>
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <span>{section.label}</span>
                  <span className="text-xs font-normal text-zinc-500">
                    {sectionItems.filter((i) => keys.has(i.key)).length}/{sectionItems.length}
                  </span>
                </button>
                <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400" onClick={(e) => e.stopPropagation()}>
                  <span>Select all</span>
                  <input
                    type="checkbox"
                    checked={sectAll}
                    ref={(el) => {
                      if (el) el.indeterminate = sectAny && !sectAll;
                    }}
                    onChange={(e) => setManyEnabled(sectionItems, e.target.checked)}
                  />
                </label>
              </header>

              {open && (
                <div className="flex flex-col gap-3 border-t border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                  {section.groups.map((group) => {
                    const gAll = allChecked(group.items);
                    const gAny = anyChecked(group.items);
                    return (
                      <div key={group.id} className="flex flex-col gap-1.5">
                        <label className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                          <input
                            type="checkbox"
                            checked={gAll}
                            ref={(el) => {
                              if (el) el.indeterminate = gAny && !gAll;
                            }}
                            onChange={(e) => setManyEnabled(group.items, e.target.checked)}
                          />
                          <span>{group.label}</span>
                          <span className="text-xs font-normal text-zinc-500">
                            {group.items.filter((i) => keys.has(i.key)).length}/{group.items.length}
                          </span>
                        </label>
                        <ul className="ml-6 flex flex-col gap-1">
                          {group.items.map((item) => {
                            const on = keys.has(item.key);
                            return (
                              <li key={item.key} className={`flex items-center justify-between rounded-md border px-3 py-1.5 text-sm transition-colors ${on ? 'border-emerald-300 bg-emerald-50/40 dark:border-emerald-800 dark:bg-emerald-950/20' : 'border-zinc-200 dark:border-zinc-800'}`}>
                                <label className="flex flex-1 cursor-pointer items-center gap-2">
                                  <input type="checkbox" checked={on} onChange={() => togglePermission(item.key)} />
                                  <div className="min-w-0 flex-1">
                                    <div className="font-medium">{item.label}</div>
                                    {item.path && (
                                      <div className="font-mono text-xs text-zinc-500">{item.path}</div>
                                    )}
                                    <div className="font-mono text-[10px] text-zinc-400">{item.key}</div>
                                  </div>
                                </label>
                                <span className={`ml-3 rounded-full px-2 py-0.5 text-xs font-medium ${on ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400'}`}>
                                  {on ? 'Allowed' : 'Denied'}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}

                  {section.unpublished.length > 0 && (
                    <div className="mt-2 flex flex-col gap-1.5">
                      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Unpublished</div>
                      <ul className="ml-6 flex flex-col gap-1">
                        {section.unpublished.map((item) => {
                          const on = keys.has(item.key);
                          return (
                            <li key={item.key} className={`flex items-center justify-between rounded-md border px-3 py-1.5 text-sm ${on ? 'border-emerald-300 bg-emerald-50/40 dark:border-emerald-800 dark:bg-emerald-950/20' : 'border-zinc-200 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-900/40'}`}>
                              <label className="flex flex-1 cursor-pointer items-center gap-2">
                                <input type="checkbox" checked={on} onChange={() => togglePermission(item.key)} />
                                <div className="min-w-0 flex-1">
                                  <div className="font-medium text-zinc-600 dark:text-zinc-400">{item.label}</div>
                                  <div className="font-mono text-[10px] text-zinc-400">{item.key}</div>
                                </div>
                              </label>
                              <span className={`ml-3 rounded-full px-2 py-0.5 text-xs font-medium ${on ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400'}`}>
                                {on ? 'Allowed' : 'Denied'}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
