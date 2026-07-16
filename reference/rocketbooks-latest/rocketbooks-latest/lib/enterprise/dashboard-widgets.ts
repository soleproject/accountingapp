/**
 * Widget catalog + layout helpers for the customizable Enterprise dashboard.
 *
 * This module is intentionally pure (no server-only imports) so both the
 * server page and the client layout editor can import it. v2 supports
 * drag-to-reorder, show/hide, and per-widget width (full / half). Named tabs
 * and AI-generated layouts build on this same shape later.
 */

export type WidgetSize = 'full' | 'half';

export interface DashboardWidgetMeta {
  id: string;
  label: string;
  description: string;
  /** Default column width when the user hasn't overridden it. */
  defaultSize: WidgetSize;
}

/**
 * Canonical widget list, in the default top-to-bottom order. Adding a new
 * dashboard block = add an entry here and provide its rendered node in the
 * page's `nodes` map. New widgets automatically appear at the end of every
 * existing user's saved layout (see resolveLayout).
 */
export const ENTERPRISE_DASHBOARD_WIDGETS: DashboardWidgetMeta[] = [
  { id: 'setup-banner', label: 'Setup prompt', description: 'Finish-setting-up-your-firm banner (auto-hides once complete)', defaultSize: 'full' },
  { id: 'tier', label: 'Plan & earnings', description: 'Tier, client-cap usage, and projected monthly earnings', defaultSize: 'full' },
  { id: 'stats', label: 'Key metrics', description: 'Total clients, needs review, clients with issues, AI handled', defaultSize: 'full' },
  { id: 'attention', label: 'Client work queue', description: 'Search + Needs / Pro / AI / Client attention tabs', defaultSize: 'full' },
  { id: 'recent-activity', label: 'Recent activity', description: 'Latest audit-log events for the firm', defaultSize: 'half' },
  { id: 'enterprise-details', label: 'Firm details', description: 'Name, domain, plan, tier, your role', defaultSize: 'half' },
];

export const ENTERPRISE_WIDGET_IDS = ENTERPRISE_DASHBOARD_WIDGETS.map((w) => w.id);

export function widgetLabel(id: string): string {
  return ENTERPRISE_DASHBOARD_WIDGETS.find((w) => w.id === id)?.label ?? id;
}

export function widgetDescription(id: string): string {
  return ENTERPRISE_DASHBOARD_WIDGETS.find((w) => w.id === id)?.description ?? '';
}

export function defaultSizeFor(id: string): WidgetSize {
  return ENTERPRISE_DASHBOARD_WIDGETS.find((w) => w.id === id)?.defaultSize ?? 'full';
}

/** A named tab grouping. Widget membership lives in DashboardLayout.tabOf. */
export interface DashboardTab {
  id: string;
  name: string;
}

export interface DashboardLayout {
  /** Widget ids in render order. Only ever contains currently-available ids. */
  order: string[];
  /** Widget ids the user has hidden (still occupy a slot in the editor). */
  hidden: string[];
  /** Effective width per widget id. resolveLayout fills this for every id in order. */
  sizes: Record<string, WidgetSize>;
  /** Named tabs. Empty array = flat (untabbed) dashboard. */
  tabs: DashboardTab[];
  /** widgetId → tabId. Only meaningful when tabs is non-empty; resolveLayout
   *  defaults any unassigned-but-available widget to the first tab. */
  tabOf: Record<string, string>;
}

/** A saved layout may be partial (older Phase-1 saves had no `sizes`). */
export type SavedDashboardLayout = Partial<DashboardLayout>;

/**
 * Reconcile a user's saved layout against the widgets actually available this
 * render. Keeps the saved order for known widgets, appends any newly-shipped
 * widgets at the end (so features don't stay invisible), drops anything no
 * longer available, and fills an effective `sizes` map (saved override →
 * widget default). `available` is the set of widget ids that have content to
 * render right now (e.g. the setup banner is only available pre-onboarding).
 */
export function resolveLayout(
  saved: SavedDashboardLayout | null | undefined,
  available: string[],
): DashboardLayout {
  const known = new Set(available);
  const savedOrder = (saved?.order ?? []).filter((id) => known.has(id));
  const seen = new Set(savedOrder);
  // Append newly-available widgets in their canonical order.
  const appended = available
    .filter((id) => !seen.has(id))
    .sort((a, b) => ENTERPRISE_WIDGET_IDS.indexOf(a) - ENTERPRISE_WIDGET_IDS.indexOf(b));
  const order = [...savedOrder, ...appended];
  const hidden = (saved?.hidden ?? []).filter((id) => known.has(id));

  const sizes: Record<string, WidgetSize> = {};
  for (const id of order) {
    const s = saved?.sizes?.[id];
    sizes[id] = s === 'full' || s === 'half' ? s : defaultSizeFor(id);
  }

  // Tabs: keep valid saved tabs; map each available widget to a valid tab,
  // defaulting unassigned widgets to the first tab so nothing goes missing.
  const tabs: DashboardTab[] = Array.isArray(saved?.tabs)
    ? saved!.tabs!
        .filter((t): t is DashboardTab => !!t && typeof t.id === 'string' && typeof t.name === 'string')
        .map((t) => ({ id: t.id, name: t.name }))
    : [];
  const tabOf: Record<string, string> = {};
  if (tabs.length > 0) {
    const tabIds = new Set(tabs.map((t) => t.id));
    for (const id of order) {
      const t = saved?.tabOf?.[id];
      tabOf[id] = t && tabIds.has(t) ? t : tabs[0].id;
    }
  }

  return { order, hidden, sizes, tabs, tabOf };
}

/** The out-of-the-box layout for the given set of available widgets. */
export function defaultLayout(available: string[]): DashboardLayout {
  return resolveLayout(null, available);
}
