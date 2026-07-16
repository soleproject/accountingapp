'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  createCategoryAction,
  updateCategoryAction,
  archiveCategoryAction,
  deleteRuleAction,
} from '../_actions/categories';

interface Category {
  id: string;
  name: string;
  groupName: string;
  rollover: boolean;
  archived: boolean;
}

interface Rule {
  id: string;
  matchField: string;
  matchOp: string;
  matchValue: string;
  categoryName: string;
}

export function CategoriesManager({ categories, rules }: { categories: Category[]; rules: Rule[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [rollover, setRollover] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const run = (fn: () => Promise<unknown>) => startTransition(async () => { await fn(); router.refresh(); });

  const groups = Array.from(new Set(categories.map((c) => c.groupName)));
  const visible = categories.filter((c) => showArchived || !c.archived);
  const byGroup: { group: string; items: Category[] }[] = [];
  for (const c of visible) {
    let g = byGroup.find((x) => x.group === c.groupName);
    if (!g) { g = { group: c.groupName, items: [] }; byGroup.push(g); }
    g.items.push(c);
  }

  const add = () => {
    if (!name.trim()) return;
    run(async () => {
      await createCategoryAction({ name, groupName: group.trim() || 'Other', rollover });
      setName(''); setGroup(''); setRollover(false);
    });
  };

  const saveRename = (id: string) => {
    const n = editName.trim();
    setEditingId(null);
    if (!n) return;
    run(() => updateCategoryAction({ id, name: n }));
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Add category */}
      <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Add category</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Category name"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <input
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder="Group"
            list="personal-category-groups"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <datalist id="personal-category-groups">
            {groups.map((g) => <option key={g} value={g} />)}
          </datalist>
          <label className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
            <input type="checkbox" checked={rollover} onChange={(e) => setRollover(e.target.checked)} /> Rollover
          </label>
          <button
            type="button"
            onClick={add}
            disabled={pending || !name.trim()}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Add
          </button>
        </div>
      </section>

      {/* Categories list */}
      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Categories</h2>
          <label className="flex items-center gap-1.5 text-xs text-zinc-500">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
          </label>
        </header>
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {byGroup.map((g) => (
            <div key={g.group} className="px-4 py-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{g.group}</div>
              <ul className="flex flex-col gap-1">
                {g.items.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 text-sm">
                    {editingId === c.id ? (
                      <input
                        autoFocus
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onBlur={() => saveRename(c.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveRename(c.id); if (e.key === 'Escape') setEditingId(null); }}
                        className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setEditingId(c.id); setEditName(c.name); }}
                        className={`text-left ${c.archived ? 'text-zinc-400 line-through' : 'text-zinc-700 dark:text-zinc-300'}`}
                        title="Click to rename"
                      >
                        {c.name}
                      </button>
                    )}
                    <label className="ml-auto flex items-center gap-1 text-xs text-zinc-500">
                      <input
                        type="checkbox"
                        checked={c.rollover}
                        disabled={pending}
                        onChange={(e) => run(() => updateCategoryAction({ id: c.id, rollover: e.target.checked }))}
                      />
                      rollover
                    </label>
                    <button
                      type="button"
                      onClick={() => run(() => archiveCategoryAction({ id: c.id, archived: !c.archived }))}
                      disabled={pending}
                      className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-900"
                    >
                      {c.archived ? 'Restore' : 'Archive'}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* Rules */}
      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Auto-categorization rules</h2>
        </header>
        {rules.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-zinc-500">
            No rules yet. Recategorize a transaction and choose “apply to all from this merchant” to create one.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                <span className="text-zinc-500">{r.matchField} {r.matchOp}</span>
                <span className="font-medium text-zinc-700 dark:text-zinc-300">“{r.matchValue}”</span>
                <span className="text-zinc-400">→</span>
                <span className="text-zinc-700 dark:text-zinc-300">{r.categoryName}</span>
                <button
                  type="button"
                  onClick={() => run(() => deleteRuleAction({ id: r.id }))}
                  disabled={pending}
                  className="ml-auto rounded px-2 py-0.5 text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:hover:bg-rose-950/30"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
