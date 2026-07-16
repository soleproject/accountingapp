'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  THEME_TOKENS,
  THEME_GROUPS,
  THEME_PRESETS,
  type ThemeConfig,
  type ThemeTokenDef,
} from '@/lib/enterprise/theme';
import { extractLogoThemes, type LogoThemeOption } from '@/lib/enterprise/logo-theme';
import { saveThemeConfigAction, resetThemeConfigAction } from '../_actions/theme';

/** Are two theme configs identical? Drives the active/glow state on theme buttons. */
function sameConfig(a: ThemeConfig, b: ThemeConfig): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

/**
 * A small live mockup of the Accounting app rendered with the current theme,
 * so the firm sees their colors applied before saving. `c(key)` resolves a
 * token to its current color.
 */
function ThemePreview({ c, logoUrl }: { c: (key: string) => string; logoUrl: string | null }) {
  const navItems = ['Dashboard', 'Transactions', 'Reports', 'Settings'];
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 text-[10px] leading-tight shadow-sm dark:border-zinc-800">
      <div className="flex h-72">
        {/* Sidebar */}
        <div className="flex w-[38%] flex-col gap-1 p-2" style={{ backgroundColor: c('sidebarBg') }}>
          <div className="mb-1 flex h-4 items-center">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="" className="h-4 w-auto max-w-full object-contain" />
            ) : (
              <span className="font-bold" style={{ color: c('sidebarText') }}>Acme Books</span>
            )}
          </div>
          {navItems.map((item, i) => (
            <div
              key={item}
              className="flex items-center gap-1 rounded px-1 py-0.5"
              style={i === 1 ? { backgroundColor: c('sidebarActiveBg') } : undefined}
            >
              <span className="inline-block h-1.5 w-1.5 rounded-sm" style={{ backgroundColor: c('sidebarIcon') }} />
              <span style={{ color: i === 1 ? c('sidebarActiveText') : c('sidebarText') }}>{item}</span>
            </div>
          ))}
        </div>
        {/* Main */}
        <div className="flex flex-1 flex-col bg-white dark:bg-zinc-950">
          <div
            className="flex items-center justify-between border-b border-zinc-200 px-2 py-1 dark:border-zinc-800"
            style={{ backgroundColor: c('topbarBg') }}
          >
            <span style={{ color: c('topbarText') }}>Accounting</span>
            <span style={{ color: c('topbarText') }}>● ● ●</span>
          </div>
          <div className="flex flex-1 flex-col gap-1.5 p-2">
            <div className="font-semibold text-zinc-800 dark:text-zinc-200">Profit &amp; Loss</div>
            <div className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-6 flex-1 rounded border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900" />
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="rounded px-1.5 py-0.5 font-medium text-white" style={{ backgroundColor: c('accentBtn') }}>
                New entry
              </span>
              <span className="underline" style={{ color: c('accentLink') }}>View all</span>
              <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: c('accentCheckbox') }} />
            </div>
            <div className="mt-auto rounded p-1" style={{ backgroundColor: c('chatPanelBg') }}>
              <span
                className="inline-block rounded px-1.5 py-0.5"
                style={{ backgroundColor: c('chatUserBubble'), color: c('chatText') }}
              >
                Looks great!
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Theme Studio: presets + per-token color pickers for the firm's white-label
 * theme. Only customized tokens are saved; everything else falls back to the
 * RocketBooks default. "Reset to RocketBooks" clears all overrides.
 */
export function ThemeStudio({
  initial,
  brandColorHex,
  privateLabel,
  logoUrl,
  collapsibleTokens = false,
}: {
  initial: ThemeConfig | null;
  brandColorHex: string | null;
  privateLabel: boolean;
  logoUrl: string | null;
  /** When true, the per-token color grid hides behind a "Customize" toggle
   *  (logo-matched options + presets stay visible). */
  collapsibleTokens?: boolean;
}) {
  const router = useRouter();
  const [config, setConfig] = useState<ThemeConfig>(initial ?? {});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [tokensOpen, setTokensOpen] = useState(false);
  const [logoOptions, setLogoOptions] = useState<LogoThemeOption[] | null>(null);

  useEffect(() => {
    let alive = true;
    if (privateLabel && logoUrl) {
      extractLogoThemes(logoUrl).then((opts) => {
        if (alive) setLogoOptions(opts);
      });
    } else {
      setLogoOptions([]);
    }
    return () => {
      alive = false;
    };
  }, [logoUrl, privateLabel]);

  if (!privateLabel) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Turn on private label in your firm setup to customize your theme. Your clients will then see
        your colors instead of RocketBooks.
      </p>
    );
  }

  const setToken = (k: string, v: string) => {
    setConfig((c) => ({ ...c, [k]: v }));
    setSaved(false);
  };
  const clearToken = (k: string) => {
    setConfig((c) => {
      const n = { ...c };
      delete n[k];
      return n;
    });
    setSaved(false);
  };
  const applyPreset = (cfg: ThemeConfig) => {
    setConfig({ ...cfg });
    setSaved(false);
  };

  async function save() {
    setSaving(true);
    await saveThemeConfigAction(config);
    setSaving(false);
    setSaved(true);
    router.refresh();
  }
  async function resetAll() {
    setSaving(true);
    await resetThemeConfigAction();
    setConfig({});
    setSaving(false);
    setSaved(true);
    router.refresh();
  }

  function displayValue(t: ThemeTokenDef): string {
    if (config[t.key]) return config[t.key];
    if (brandColorHex && t.group === 'Accents') return brandColorHex;
    return t.rocketbooks;
  }

  const tokenByKey = Object.fromEntries(THEME_TOKENS.map((t) => [t.key, t] as const));
  const resolveKey = (key: string) => {
    const t = tokenByKey[key];
    return t ? displayValue(t) : '#000000';
  };

  const glow = 'border-blue-500 ring-2 ring-blue-500 shadow-md shadow-blue-500/40';
  const isActive = (cfg: ThemeConfig) => sameConfig(config, cfg);

  const logoBlock = (
    <div>
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Matched to your logo</div>
      {!logoUrl ? (
        <p className="text-xs text-zinc-400">Upload a logo in Branding above to get theme options matched to it.</p>
      ) : logoOptions === null ? (
        <p className="text-xs text-zinc-400">Reading your logo&hellip;</p>
      ) : logoOptions.length === 0 ? (
        <p className="text-xs text-zinc-400">Couldn&rsquo;t read distinct colors from your logo — try a preset below.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {logoOptions.map((o) => (
            <button
              key={o.name}
              type="button"
              onClick={() => applyPreset(o.config)}
              className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition hover:bg-zinc-100 dark:hover:bg-zinc-900 ${isActive(o.config) ? glow : 'border-zinc-300 dark:border-zinc-700'}`}
            >
              <span className="flex">
                {o.swatches.map((s, i) => (
                  <span
                    key={i}
                    className="-ml-1 h-4 w-4 rounded-full border border-white first:ml-0 dark:border-zinc-900"
                    style={{ backgroundColor: s }}
                  />
                ))}
              </span>
              {o.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const presetsBlock = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Presets</span>
      {THEME_PRESETS.map((p) => (
        <button
          key={p.name}
          type="button"
          onClick={() => applyPreset(p.config)}
          className={`rounded-md border px-2.5 py-1 text-xs transition hover:bg-zinc-100 dark:hover:bg-zinc-900 ${isActive(p.config) ? glow : 'border-zinc-300 dark:border-zinc-700'}`}
        >
          {p.name}
        </button>
      ))}
    </div>
  );

  const tokenGrid = THEME_GROUPS.map((group) => (
    <div key={group}>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{group}</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {THEME_TOKENS.filter((t) => t.group === group).map((t) => {
          const customized = !!config[t.key];
          return (
            <div key={t.key} className="flex items-center gap-2">
              <input
                type="color"
                value={displayValue(t)}
                onChange={(e) => setToken(t.key, e.target.value)}
                className="h-8 w-10 shrink-0 rounded border border-zinc-300 dark:border-zinc-700"
                aria-label={t.label}
              />
              <span className="flex-1 text-sm">{t.label}</span>
              {customized ? (
                <button
                  type="button"
                  onClick={() => clearToken(t.key)}
                  title="Reset this color to the RocketBooks default"
                  className="text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                >
                  reset
                </button>
              ) : (
                <span className="text-[10px] uppercase tracking-wide text-zinc-400">default</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  ));

  const saveResetBlock = (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save theme'}
      </button>
      <button
        type="button"
        onClick={resetAll}
        disabled={saving}
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        Reset to RocketBooks
      </button>
      {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved ✓</span>}
    </div>
  );

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className={`flex min-w-0 flex-col gap-5 ${collapsibleTokens ? 'lg:w-[26rem] lg:shrink-0' : 'lg:flex-1'}`}>
        {logoBlock}
        {!collapsibleTokens && presetsBlock}
        {collapsibleTokens && saveResetBlock}
        {collapsibleTokens && (
          <button
            type="button"
            onClick={() => setTokensOpen((o) => !o)}
            className="self-start text-sm font-medium text-blue-700 dark:text-blue-300"
          >
            {tokensOpen ? 'Hide colors ▾' : 'Customize colors ▸'}
          </button>
        )}
        {(!collapsibleTokens || tokensOpen) && (
          <>
            {collapsibleTokens && presetsBlock}
            {tokenGrid}
          </>
        )}
        {!collapsibleTokens && saveResetBlock}
        <p className="text-xs text-zinc-400">
          Applies to your enterprise area and to your clients&rsquo; app. Custom colors apply in both light and dark mode;
          anything left as &ldquo;default&rdquo; keeps the RocketBooks look.
        </p>
      </div>
      <div className={collapsibleTokens ? 'lg:flex lg:flex-1 lg:justify-center' : 'lg:w-80 lg:shrink-0'}>
        <div className={`lg:sticky lg:top-4 ${collapsibleTokens ? 'w-full max-w-md' : ''}`}>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Live preview</div>
          <ThemePreview c={resolveKey} logoUrl={logoUrl} />
        </div>
      </div>
    </div>
  );
}
