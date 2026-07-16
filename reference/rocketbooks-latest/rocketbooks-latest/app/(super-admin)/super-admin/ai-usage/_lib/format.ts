// Shared formatting + range helpers for the superadmin Usage & Costs pages.

export type RangeKey = '7d' | '30d' | '90d' | 'month';

export const RANGE_LABEL: Record<RangeKey, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  month: 'This month',
};

export const RANGE_KEYS = ['7d', '30d', '90d', 'month'] as const;

/** Validate a raw query param into a RangeKey, defaulting to 30d. */
export function parseRange(raw: string | undefined): RangeKey {
  return (RANGE_KEYS as readonly string[]).includes(raw ?? '') ? (raw as RangeKey) : '30d';
}

export function rangeStartIso(range: RangeKey): string {
  if (range === 'month') {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  }
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function fmtUsd(n: number | null | undefined): string {
  const v = typeof n === 'number' ? n : 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(2)}`;
}

export function fmtNum(n: number | null | undefined): string {
  return (typeof n === 'number' ? n : 0).toLocaleString('en-US');
}

export function fmtQty(n: number | null | undefined): string {
  const v = typeof n === 'number' ? n : 0;
  return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

export function fmtTimeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Effective per-unit rate from actual charges (cost / quantity). For token
 * units we express it per 1M (a per-token figure is unreadable); everything
 * else is per single unit. Returns a display string or '—' when unpriced.
 */
export function fmtEffectiveRate(cost: number, qty: number, unit: string | null | undefined): string {
  if (!qty || cost <= 0) return '—';
  if (unit === 'tokens' || unit === 'characters') {
    return `$${((cost / qty) * 1_000_000).toFixed(2)} / 1M`;
  }
  const per = cost / qty;
  const u = unit ? unit.replace(/s$/, '') : 'unit';
  return `${per < 0.01 ? `$${per.toFixed(6)}` : `$${per.toFixed(4)}`} / ${u}`;
}
