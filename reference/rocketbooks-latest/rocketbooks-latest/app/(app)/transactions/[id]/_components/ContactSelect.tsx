'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

interface ContactOption {
  id: string;
  name: string;
}

interface Props {
  /** form field name — a hidden input mirrors `value` so the parent form submits it. */
  name: string;
  value: string;
  onChange: (id: string) => void;
  contacts: ContactOption[];
  required?: boolean;
  placeholder?: string;
}

export function ContactSelect({
  name,
  value,
  onChange,
  contacts,
  required,
  placeholder = '— Select —',
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [focusIdx, setFocusIdx] = useState(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => c.name.toLowerCase().includes(q));
  }, [contacts, query]);

  useEffect(() => {
    if (focusIdx >= filtered.length) setFocusIdx(0);
  }, [filtered.length, focusIdx]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  const selected = useMemo(
    () => contacts.find((c) => c.id === value) ?? null,
    [contacts, value],
  );

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIdx((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIdx((i) => (filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = filtered[focusIdx];
      if (hit) pick(hit.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setQuery('');
    }
  };

  return (
    <div className="relative" ref={wrapperRef}>
      <input type="hidden" name={name} value={value} required={required} />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-left text-sm dark:border-zinc-700 dark:bg-zinc-900"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={selected ? '' : 'text-zinc-400'}>
          {selected ? selected.name : placeholder}
        </span>
        <span aria-hidden className="text-xs text-zinc-400">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-20 mt-1 max-h-80 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-950">
          <div className="border-b border-zinc-100 p-2 dark:border-zinc-800">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setFocusIdx(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search contacts…"
              className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-sm text-zinc-500">No matches</div>
            )}
            {filtered.map((c, idx) => {
              const isFocused = idx === focusIdx;
              const isSelected = c.id === value;
              return (
                <button
                  type="button"
                  key={c.id}
                  onMouseEnter={() => setFocusIdx(idx)}
                  onClick={() => pick(c.id)}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm ${
                    isFocused ? 'bg-blue-50 dark:bg-blue-950/40' : ''
                  } ${isSelected ? 'font-medium text-blue-700 dark:text-blue-300' : ''}`}
                >
                  <span>{c.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
