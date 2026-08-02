/**
 * useRegisterChart — declarative hook any report page can call to
 * advertise which charts are currently visible to the Insights chat
 * widget. The registered ids ride along on every ask/stream request as
 * `page_charts`, so the LLM can prefer showing charts the user is
 * literally looking at (or expand on them) without every page needing
 * a backend edit.
 *
 * Global runtime store (window-scoped) so the widget — which lives in
 * Layout, several React trees above — can read the current set without
 * prop-drilling or a heavier context.
 */
import { useEffect } from "react";

const STORE_KEY = "__insightsRegisteredCharts";

function _ensureStore() {
  if (!window[STORE_KEY]) window[STORE_KEY] = new Map();
  return window[STORE_KEY];
}

/**
 * @param {{ id: string, title?: string, description?: string }} chart
 * The `id` MUST match a key in the backend `CHART_REGISTRY` for the
 * fetcher to succeed. Titles / descriptions are metadata only.
 */
export function useRegisterChart(chart) {
  useEffect(() => {
    if (!chart?.id) return;
    const store = _ensureStore();
    store.set(chart.id, { ...chart, at: Date.now() });
    return () => { store.delete(chart.id); };
  }, [chart?.id, chart?.title, chart?.description]);
}

/** Snapshot of the currently-registered chart ids. */
export function getRegisteredChartIds() {
  const store = _ensureStore();
  return Array.from(store.keys());
}
