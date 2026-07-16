/**
 * Enterprise white-label Theme Studio token model. Pure (no server-only) so it
 * can be imported by client editors and server layouts alike.
 *
 * Storage: organizations.theme_config is a partial map of tokenKey → hex. Only
 * customized tokens are stored. The injected CSS vars (--th-<key>) are consumed
 * by scoped overrides in globals.css that use `var(--th-...)` WITHOUT a fallback
 * — so any token the firm hasn't set leaves the original RocketBooks Tailwind
 * classes (light + dark) untouched. "Reset" = clear theme_config.
 */

export type ThemeGroup = 'Accents' | 'Sidebar' | 'Topbar' | 'Chat';

export interface ThemeTokenDef {
  key: string;
  label: string;
  group: ThemeGroup;
  /** The current RocketBooks color — shown as the picker's starting value. */
  rocketbooks: string;
}

/** Canonical token list. `key` maps to the CSS var `--th-<key>`. */
export const THEME_TOKENS: ThemeTokenDef[] = [
  // Accents
  { key: 'accentBtn', label: 'Primary button', group: 'Accents', rocketbooks: '#2563eb' },
  { key: 'accentLink', label: 'Links', group: 'Accents', rocketbooks: '#2563eb' },
  { key: 'accentCheckbox', label: 'Checkboxes', group: 'Accents', rocketbooks: '#2563eb' },
  { key: 'accentRing', label: 'Focus ring', group: 'Accents', rocketbooks: '#2563eb' },
  // Sidebar
  { key: 'sidebarBg', label: 'Background', group: 'Sidebar', rocketbooks: '#ffffff' },
  { key: 'sidebarText', label: 'Text', group: 'Sidebar', rocketbooks: '#3f3f46' },
  { key: 'sidebarIcon', label: 'Icons', group: 'Sidebar', rocketbooks: '#2563eb' },
  { key: 'sidebarActiveBg', label: 'Active item bg', group: 'Sidebar', rocketbooks: '#e4e4e7' },
  { key: 'sidebarActiveText', label: 'Active item text', group: 'Sidebar', rocketbooks: '#18181b' },
  // Topbar
  { key: 'topbarBg', label: 'Background', group: 'Topbar', rocketbooks: '#ffffff' },
  { key: 'topbarText', label: 'Text & icons', group: 'Topbar', rocketbooks: '#71717a' },
  // Chat
  { key: 'chatPanelBg', label: 'Panel background', group: 'Chat', rocketbooks: '#ffffff' },
  { key: 'chatUserBubble', label: 'Your message bubble', group: 'Chat', rocketbooks: '#f4f4f5' },
  { key: 'chatText', label: 'Message text', group: 'Chat', rocketbooks: '#27272a' },
];

export const THEME_GROUPS: ThemeGroup[] = ['Accents', 'Sidebar', 'Topbar', 'Chat'];

export type ThemeConfig = Record<string, string>;

const VALID_KEYS = new Set(THEME_TOKENS.map((t) => t.key));
const HEX_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

/** Keep only known token keys with valid hex values. */
export function sanitizeThemeConfig(input: unknown): ThemeConfig {
  const out: ThemeConfig = {};
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (VALID_KEYS.has(k) && typeof v === 'string' && HEX_RE.test(v.trim())) {
        out[k] = v.trim();
      }
    }
  }
  return out;
}

/**
 * CSS variables to inject on the themed wrapper — only for tokens the firm set.
 * accentBtnStrong is derived (for hover/700 shades) when accentBtn is set.
 */
export function themeCssVars(config: ThemeConfig | null | undefined): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!config) return vars;
  const clean = sanitizeThemeConfig(config);
  for (const [k, v] of Object.entries(clean)) vars[`--th-${k}`] = v;
  if (clean.accentBtn) {
    vars['--th-accentBtnStrong'] = `color-mix(in srgb, ${clean.accentBtn} 82%, black)`;
  }
  return vars;
}

/** A preset is a full config map (empty = RocketBooks default / reset). */
export interface ThemePreset {
  name: string;
  config: ThemeConfig;
}

export const THEME_PRESETS: ThemePreset[] = [
  { name: 'RocketBooks (default)', config: {} },
  {
    name: 'Midnight',
    config: {
      accentBtn: '#6366f1',
      accentLink: '#818cf8',
      accentCheckbox: '#6366f1',
      accentRing: '#6366f1',
      sidebarBg: '#0f172a',
      sidebarText: '#cbd5e1',
      sidebarIcon: '#818cf8',
      sidebarActiveBg: '#1e293b',
      sidebarActiveText: '#ffffff',
      topbarBg: '#0f172a',
      topbarText: '#cbd5e1',
      chatPanelBg: '#0f172a',
      chatUserBubble: '#1e293b',
      chatText: '#e2e8f0',
    },
  },
  {
    name: 'Forest',
    config: {
      accentBtn: '#059669',
      accentLink: '#047857',
      accentCheckbox: '#059669',
      accentRing: '#059669',
      sidebarIcon: '#059669',
      sidebarActiveBg: '#d1fae5',
      sidebarActiveText: '#065f46',
    },
  },
  {
    name: 'Violet',
    config: {
      accentBtn: '#7c3aed',
      accentLink: '#7c3aed',
      accentCheckbox: '#7c3aed',
      accentRing: '#7c3aed',
      sidebarIcon: '#7c3aed',
      sidebarActiveBg: '#ede9fe',
      sidebarActiveText: '#5b21b6',
    },
  },
];
