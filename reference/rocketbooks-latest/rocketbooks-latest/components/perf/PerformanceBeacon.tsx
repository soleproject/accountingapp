'use client';

import { useEffect } from 'react';
import { classifyRoute, isSafeCorrelationId } from '@/lib/perf/request-observability-core';

export function PerformanceBeacon({ requestId, observed }: { requestId?: string; observed: boolean }) {
  useEffect(() => {
    if (!observed || !isSafeCorrelationId(requestId)) return;
    let cancelled = false;
    let frameOne = 0;
    let frameTwo = 0;
    frameOne = requestAnimationFrame(() => {
      frameTwo = requestAnimationFrame(() => {
        if (cancelled) return;
        const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        const payload = JSON.stringify({
          requestId,
          routeClass: classifyRoute(window.location.pathname),
          navigationStartToVisibleMs: performance.now(),
          domContentLoadedMs: navigation?.domContentLoadedEventEnd,
          loadEventMs: navigation?.loadEventEnd,
        });
        navigator.sendBeacon('/api/performance/beacon', new Blob([payload], { type: 'application/json' }));
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameOne);
      cancelAnimationFrame(frameTwo);
    };
  }, [observed, requestId]);
  return null;
}
