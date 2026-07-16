import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { usageRates } from '@/db/schema/schema';

/**
 * Editable per-unit rate card for non-token paid services. The source of
 * truth is the `usage_rates` table (seeded in migration 0100, editable in the
 * superadmin Usage & Costs page). These defaults are the fallback used when a
 * row is missing — they mirror the migration seed so cost still computes if a
 * key was added in code before the row exists.
 *
 * LLM token pricing (in/out/cached, different shape) stays in lib/ai/usage.ts.
 */

export type RateKey =
  | 'deepgram:minute'
  | 'veryfi:document'
  | 'twilio:segment'
  | 'resend:email'
  | 'openai-image:low'
  | 'openai-image:medium'
  | 'openai-image:high'
  | 'daily:participant-minute'
  | 'recall:recording-hour'
  | 'plaid:item-month';

export interface RateDef {
  provider: string;
  label: string;
  unit: string;
  rateUsd: number;
  notes?: string;
}

export const DEFAULT_RATES: Record<RateKey, RateDef> = {
  'deepgram:minute':          { provider: 'deepgram', label: 'Deepgram transcription', unit: 'minutes',   rateUsd: 0.0043,  notes: 'nova-3 prerecorded, $/audio-minute' },
  'veryfi:document':          { provider: 'veryfi',   label: 'Veryfi OCR',             unit: 'documents', rateUsd: 0.16,    notes: '$/document processed' },
  'twilio:segment':           { provider: 'twilio',   label: 'Twilio SMS',             unit: 'segments',  rateUsd: 0.0079,  notes: '$/message segment (US)' },
  'resend:email':             { provider: 'resend',   label: 'Resend email',           unit: 'emails',    rateUsd: 0.0004,  notes: '$/email sent' },
  'openai-image:low':         { provider: 'openai',   label: 'OpenAI image (low)',     unit: 'images',    rateUsd: 0.011,   notes: 'gpt-image-1 low quality' },
  'openai-image:medium':      { provider: 'openai',   label: 'OpenAI image (medium)',  unit: 'images',    rateUsd: 0.042,   notes: 'gpt-image-1 medium quality' },
  'openai-image:high':        { provider: 'openai',   label: 'OpenAI image (high)',    unit: 'images',    rateUsd: 0.167,   notes: 'gpt-image-1 high quality' },
  'daily:participant-minute': { provider: 'daily',    label: 'Daily.co video',         unit: 'minutes',   rateUsd: 0.004,   notes: '$/participant-minute (Phase 2)' },
  'recall:recording-hour':    { provider: 'recall',   label: 'Recall.ai bot',          unit: 'hours',     rateUsd: 0.5,     notes: '$/recording-hour (Phase 2)' },
  'plaid:item-month':         { provider: 'plaid',    label: 'Plaid linked item',      unit: 'items',     rateUsd: 0.3,     notes: '$/linked item/month (Phase 2)' },
};

/**
 * Resolve the USD rate for one key. Reads the DB row; falls back to the
 * compiled default when the row is missing. Returns null only if the key is
 * entirely unknown (so cost is recorded as null and the event still lands).
 */
export async function getRate(key: RateKey): Promise<number | null> {
  try {
    const [row] = await db
      .select({ rateUsd: usageRates.rateUsd })
      .from(usageRates)
      .where(eq(usageRates.key, key))
      .limit(1);
    if (row?.rateUsd != null) return Number(row.rateUsd);
  } catch {
    // fall through to default — never let a rate lookup break the caller
  }
  return DEFAULT_RATES[key]?.rateUsd ?? null;
}

export interface RateRow extends RateDef {
  key: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * Full rate card for the UI: every default key, overlaid with any DB row.
 * Keys present in DB but not in defaults are included too.
 */
export async function listRates(): Promise<RateRow[]> {
  const rows = await db
    .select()
    .from(usageRates);
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const keys = new Set<string>([...Object.keys(DEFAULT_RATES), ...byKey.keys()]);
  return [...keys]
    .map((key) => {
      const def = DEFAULT_RATES[key as RateKey];
      const row = byKey.get(key);
      return {
        key,
        provider: row?.provider ?? def?.provider ?? 'unknown',
        label: row?.label ?? def?.label ?? key,
        unit: row?.unit ?? def?.unit ?? 'unit',
        rateUsd: row?.rateUsd != null ? Number(row.rateUsd) : (def?.rateUsd ?? 0),
        notes: row?.notes ?? def?.notes,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      } satisfies RateRow;
    })
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
}
