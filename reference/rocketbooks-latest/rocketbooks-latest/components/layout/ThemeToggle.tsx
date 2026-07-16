'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'system';

const ICONS: Record<Theme, React.ReactNode> = {
  light: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  ),
  system: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  ),
};

const LABELS: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' };

// One year — the cookie value mirrors localStorage so the next SSR
// already reflects the user's preference (no pre-paint script needed).
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function writeThemeCookie(value: 'light' | 'dark' | null) {
  if (value === null) {
    document.cookie = 'rs_theme=; path=/; max-age=0; SameSite=Lax';
  } else {
    document.cookie = `rs_theme=${value}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') {
    localStorage.removeItem('rs_theme');
    writeThemeCookie(null);
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', prefersDark);
  } else {
    localStorage.setItem('rs_theme', theme);
    writeThemeCookie(theme);
    root.classList.toggle('dark', theme === 'dark');
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('rs_theme');
    setTheme(saved === 'dark' ? 'dark' : saved === 'light' ? 'light' : 'system');
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    applyTheme(theme);
  }, [theme, mounted]);

  // While in system mode, react to OS theme changes live
  useEffect(() => {
    if (!mounted || theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => {
      document.documentElement.classList.toggle('dark', e.matches);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme, mounted]);

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="inline-flex items-center rounded-md border border-zinc-300 bg-white p-0.5 dark:border-zinc-700 dark:bg-zinc-900"
    >
      {(['light', 'system', 'dark'] as Theme[]).map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={theme === t}
          aria-label={LABELS[t]}
          title={LABELS[t]}
          onClick={() => setTheme(t)}
          className={`flex h-6 w-7 items-center justify-center rounded transition-colors ${
            theme === t
              ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
          }`}
        >
          {ICONS[t]}
        </button>
      ))}
    </div>
  );
}
