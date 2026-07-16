'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import {
  getTaskLinksAction,
  listLinkableEntitiesAction,
  addTaskLinkAction,
  removeTaskLinkAction,
} from '../_actions/links';
import {
  TASK_LINK_TYPES,
  TASK_LINK_META,
  type LinkableEntityOption,
  type ResolvedTaskLink,
  type TaskLinkEntityType,
} from '@/lib/task-links/types';

interface Props {
  taskId: string;
}

// Static Tailwind classes per accent (kept literal so they aren't purged).
const ACCENT: Record<string, { chip: string; dot: string }> = {
  pink: { chip: 'border-pink-200 bg-pink-50 text-pink-700 dark:border-pink-900/50 dark:bg-pink-950/30 dark:text-pink-300', dot: 'bg-pink-400' },
  blue: { chip: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300', dot: 'bg-blue-400' },
  sky: { chip: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-300', dot: 'bg-sky-400' },
  amber: { chip: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300', dot: 'bg-amber-400' },
  emerald: { chip: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300', dot: 'bg-emerald-400' },
};

function fmtSub(type: TaskLinkEntityType, sub: string | null): string | null {
  if (!sub) return null;
  if (type === 'appointment') {
    const d = new Date(sub);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  return sub;
}

export function LinkedItemsManager({ taskId }: Props) {
  const [links, setLinks] = useState<ResolvedTaskLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingType, setAddingType] = useState<TaskLinkEntityType | null>(null);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<LinkableEntityOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [pending, startTransition] = useTransition();

  const reload = useCallback(() => {
    getTaskLinksAction(taskId)
      .then(setLinks)
      .catch(() => setError('Could not load links.'));
  }, [taskId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Load picker options on demand (from the type buttons / search box) rather
  // than in an effect, so we never setState synchronously during render.
  const loadOptions = useCallback((type: TaskLinkEntityType, q: string) => {
    setOptionsLoading(true);
    listLinkableEntitiesAction(type, q)
      .then(setOptions)
      .catch(() => setOptions([]))
      .finally(() => setOptionsLoading(false));
  }, []);

  const onQueryChange = (q: string) => {
    setQuery(q);
    if (addingType) loadOptions(addingType, q);
  };

  const openPicker = (type: TaskLinkEntityType) => {
    setError(null);
    setQuery('');
    if (addingType === type) {
      setAddingType(null);
      return;
    }
    setAddingType(type);
    setOptions([]);
    loadOptions(type, '');
  };

  const add = (type: TaskLinkEntityType, entityId: string) => {
    startTransition(async () => {
      try {
        const res = await addTaskLinkAction(taskId, type, entityId);
        if (res.error) {
          setError(res.error);
          return;
        }
        setAddingType(null);
        setQuery('');
        reload();
      } catch {
        setError("Couldn't add that link.");
      }
    });
  };

  const remove = (link: ResolvedTaskLink) => {
    startTransition(async () => {
      try {
        const res = await removeTaskLinkAction(taskId, link.type, link.id);
        if (res.error) {
          setError(res.error);
          return;
        }
        reload();
      } catch {
        setError("Couldn't remove that link.");
      }
    });
  };

  const linkedIds = new Set(links?.map((l) => `${l.type}:${l.id}`) ?? []);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Linked items</div>

      {/* Current links */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {links === null ? (
          <span className="text-xs text-zinc-400">Loading…</span>
        ) : links.length === 0 ? (
          <span className="text-xs text-zinc-400">Nothing linked yet.</span>
        ) : (
          links.map((l) => {
            const accent = ACCENT[TASK_LINK_META[l.type].accent] ?? ACCENT.blue;
            const sub = fmtSub(l.type, l.sublabel);
            return (
              <span
                key={`${l.type}:${l.id}`}
                className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${accent.chip}`}
                title={`${TASK_LINK_META[l.type].label}: ${l.label}${sub ? ` · ${sub}` : ''}`}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${accent.dot}`} aria-hidden="true" />
                <span className="truncate">{l.label}</span>
                <button
                  type="button"
                  onClick={() => remove(l)}
                  disabled={pending}
                  aria-label={`Unlink ${l.label}`}
                  className="shrink-0 rounded-full text-current/60 hover:text-current disabled:opacity-50"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </span>
            );
          })
        )}
      </div>

      {/* Add link: type buttons */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-zinc-400">Link to:</span>
        {TASK_LINK_TYPES.map((type) => {
          const isOpen = addingType === type;
          return (
            <button
              key={type}
              type="button"
              onClick={() => openPicker(type)}
              className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                isOpen
                  ? 'border-zinc-400 bg-zinc-100 text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100'
                  : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900'
              }`}
            >
              + {TASK_LINK_META[type].label}
            </button>
          );
        })}
      </div>

      {/* Picker */}
      {addingType && (
        <div className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900">
          <input
            autoFocus
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={`Search ${TASK_LINK_META[addingType].plural.toLowerCase()}…`}
            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950"
          />
          <ul className="mt-1.5 max-h-44 overflow-y-auto">
            {optionsLoading ? (
              <li className="px-1 py-1.5 text-xs text-zinc-400">Searching…</li>
            ) : options.length === 0 ? (
              <li className="px-1 py-1.5 text-xs text-zinc-400">No matches.</li>
            ) : (
              options.map((o) => {
                const already = linkedIds.has(`${addingType}:${o.id}`);
                const sub = fmtSub(addingType, o.sublabel);
                return (
                  <li key={o.id}>
                    <button
                      type="button"
                      disabled={already || pending}
                      onClick={() => add(addingType, o.id)}
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-zinc-800 dark:text-zinc-200">{o.label}</span>
                        {sub && <span className="block truncate text-[10px] text-zinc-400">{sub}</span>}
                      </span>
                      {already && <span className="shrink-0 text-[10px] text-zinc-400">linked</span>}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
}
