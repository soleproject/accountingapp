// Canonical catalog of every cost category we track, in display order. The
// per-user (and future per-org) breakdowns enumerate THIS list and left-join
// each user's actual usage, so unused categories still show as $0 — giving a
// complete cost picture rather than only what a user happened to touch.
//
// `category` matches the ai_usage_events.category column. `rateKey` points at a
// representative usage_rates row for the configured per-unit rate (used to show
// the rate on zero-usage rows). `codePriced` marks token-billed categories
// whose rates live in lib/ai/usage.ts (no single editable rate), so a
// zero-usage row shows no rate.

import { fmtEffectiveRate } from './format';

export interface CostCategory {
  category: string;
  label: string;
  unit: string;
  rateKey?: string;
  codePriced?: boolean;
}

export const COST_CATEGORIES: CostCategory[] = [
  { category: 'llm', label: 'OpenAI — LLM tokens', unit: 'tokens', codePriced: true },
  { category: 'realtime', label: 'OpenAI — Realtime voice', unit: 'tokens', codePriced: true },
  { category: 'tts', label: 'OpenAI — TTS', unit: 'characters', codePriced: true },
  { category: 'image', label: 'OpenAI — Images', unit: 'images', rateKey: 'openai-image:medium' },
  { category: 'transcription', label: 'Deepgram transcription', unit: 'minutes', rateKey: 'deepgram:minute' },
  { category: 'ocr', label: 'Veryfi OCR', unit: 'documents', rateKey: 'veryfi:document' },
  { category: 'video', label: 'Daily.co video', unit: 'minutes', rateKey: 'daily:participant-minute' },
  { category: 'recording', label: 'Recall.ai bot', unit: 'hours', rateKey: 'recall:recording-hour' },
  { category: 'sms', label: 'Twilio SMS', unit: 'segments', rateKey: 'twilio:segment' },
  { category: 'email', label: 'Resend email', unit: 'emails', rateKey: 'resend:email' },
  { category: 'bank', label: 'Plaid linked items', unit: 'items', rateKey: 'plaid:item-month' },
];

export interface CostRow {
  label: string;
  unit: string;
  events: number;
  qty: number;
  /** Pre-formatted rate string (effective when used, else the configured rate). */
  rate: string;
  cost: number;
}

type CategoryAgg = { category: string | null; usd: number | string; qty: number | string; events: number };

/**
 * Merge per-category usage with the full catalog → one row per cost category,
 * zero-filled where unused, with quantity, an effective/configured unit rate,
 * and cost. Any category seen in the data but missing from the catalog is
 * appended so nothing is hidden. Shared by the main + per-user usage pages.
 */
export function buildCostRows(
  byCategory: CategoryAgg[],
  rates: { key: string; rateUsd: number }[],
): CostRow[] {
  const rateByKey = new Map(rates.map((r) => [r.key, Number(r.rateUsd)]));
  const usageByCat = new Map(byCategory.map((c) => [c.category ?? 'uncategorized', c]));
  const catalogCats = new Set(COST_CATEGORIES.map((c) => c.category));
  const extraCats = [...usageByCat.keys()].filter((c) => !catalogCats.has(c));

  return [
    ...COST_CATEGORIES.map((cat) => {
      const u = usageByCat.get(cat.category);
      const cost = Number(u?.usd ?? 0);
      const qty = Number(u?.qty ?? 0);
      const rate =
        cost > 0 && qty > 0
          ? fmtEffectiveRate(cost, qty, cat.unit)
          : cat.rateKey
            ? fmtEffectiveRate(rateByKey.get(cat.rateKey) ?? 0, 1, cat.unit)
            : '—';
      return { label: cat.label, unit: cat.unit, events: Number(u?.events ?? 0), qty, rate, cost };
    }),
    ...extraCats.map((c) => {
      const u = usageByCat.get(c)!;
      const cost = Number(u.usd);
      const qty = Number(u.qty);
      return { label: c, unit: '', events: Number(u.events), qty, rate: fmtEffectiveRate(cost, qty, null), cost };
    }),
  ];
}
