import 'server-only';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { aiUsageEvents } from '@/db/schema/schema';
import { getRate, type RateKey } from '@/lib/usage/rates';

// $/1M tokens. Keep this list updated as you add models — anything missing
// records token counts but a null cost.
const PRICING: Record<string, { in: number; out: number; cachedIn?: number }> = {
  'gpt-4o':                  { in: 2.50,  out: 10.00, cachedIn: 1.25 },
  'gpt-4o-mini':             { in: 0.15,  out: 0.60,  cachedIn: 0.075 },
  'gpt-4o-realtime-preview': { in: 5.00,  out: 20.00 },
};

// $/1M characters for character-billed audio models. TTS is billed by input
// chars, not tokens, so it uses a separate price table.
const CHAR_PRICING: Record<string, number> = {
  'tts-1':    15.00,
  'tts-1-hd': 30.00,
};

// $/1M tokens for the Realtime API. Realtime prices audio and text tokens at
// very different rates (audio is the expensive part), so it can't use the flat
// PRICING table — it needs per-modality rates. Like the rest of the token
// pricing this lives in code; edit on a model/price change. Approximate GA
// list prices as of 2026-06.
const REALTIME_PRICING: Record<
  string,
  { inText: number; inTextCached: number; inAudio: number; inAudioCached: number; outText: number; outAudio: number }
> = {
  'gpt-realtime':              { inText: 4.0, inTextCached: 0.4, inAudio: 32.0, inAudioCached: 0.4,  outText: 16.0, outAudio: 64.0 },
  'gpt-4o-realtime-preview':   { inText: 5.0, inTextCached: 2.5, inAudio: 40.0, inAudioCached: 2.5,  outText: 20.0, outAudio: 80.0 },
};

function resolveRealtimePricing(model: string) {
  if (REALTIME_PRICING[model]) return REALTIME_PRICING[model];
  const prefix = Object.keys(REALTIME_PRICING)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? REALTIME_PRICING[prefix] : null;
}

function resolvePricing(model: string) {
  if (PRICING[model]) return PRICING[model];
  // OpenAI returns dated variants like 'gpt-4o-2024-08-06'. Fall back to the
  // longest prefix match so we don't lose cost data on a routine model bump.
  const prefix = Object.keys(PRICING)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? PRICING[prefix] : null;
}

function costUsd(model: string, promptT: number, completionT: number, cachedT = 0): number | null {
  const p = resolvePricing(model);
  if (!p) return null;
  const billablePrompt = Math.max(0, promptT - cachedT);
  const cachedRate = p.cachedIn ?? p.in;
  return (billablePrompt * p.in + cachedT * cachedRate + completionT * p.out) / 1_000_000;
}

export type UsageCtx = {
  userId: string | null;
  orgId: string | null;
  actor: string;
  feature: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
};

type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
} | null | undefined;

/**
 * Record a TTS request in the same ai_usage_events table. TTS is billed by
 * input characters rather than tokens — we stash the char count in
 * totalTokens (and metadata.charCount for clarity) and compute cost from
 * CHAR_PRICING. Token columns stay zero.
 */
export function recordTtsUsage(
  ctx: UsageCtx,
  model: string,
  charCount: number,
  latencyMs: number,
) {
  void (async () => {
    try {
      const rate = CHAR_PRICING[model];
      const cost = rate == null ? null : (charCount * rate) / 1_000_000;
      await db.insert(aiUsageEvents).values({
        id: randomUUID(),
        orgId: ctx.orgId,
        userId: ctx.userId,
        actor: ctx.actor,
        feature: ctx.feature,
        provider: 'openai',
        model,
        category: 'tts',
        unit: 'characters',
        quantity: String(charCount),
        promptTokens: 0,
        completionTokens: 0,
        cachedPromptTokens: 0,
        totalTokens: charCount,
        costUsd: cost == null ? null : cost.toFixed(6),
        latencyMs,
        requestId: ctx.requestId ?? null,
        metadata: { ...(ctx.metadata ?? {}), charCount },
      });
    } catch (err) {
      console.error('[ai-usage] tts insert failed', err);
    }
  })();
}

export function recordUsage(
  ctx: UsageCtx,
  model: string,
  usage: OpenAIUsage,
  latencyMs: number,
) {
  if (ctx.metadata?.skipUsage === true) return;
  void (async () => {
    try {
      const prompt = usage?.prompt_tokens ?? 0;
      const completion = usage?.completion_tokens ?? 0;
      const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const total = usage?.total_tokens ?? prompt + completion;
      const cost = costUsd(model, prompt, completion, cached);
      await db.insert(aiUsageEvents).values({
        id: randomUUID(),
        orgId: ctx.orgId,
        userId: ctx.userId,
        actor: ctx.actor,
        feature: ctx.feature,
        provider: 'openai',
        model,
        category: 'llm',
        unit: 'tokens',
        quantity: String(total),
        promptTokens: prompt,
        completionTokens: completion,
        cachedPromptTokens: cached,
        totalTokens: total,
        costUsd: cost == null ? null : cost.toFixed(6),
        latencyMs,
        requestId: ctx.requestId ?? null,
        metadata: ctx.metadata ?? null,
      });
    } catch (err) {
      console.error('[ai-usage] insert failed', err);
    }
  })();
}

export type ServiceUsage = {
  /** Service key — lands in the `provider` column (e.g. 'deepgram', 'twilio'). */
  provider: string;
  /** Coarse grouping for the UI: 'transcription' | 'ocr' | 'sms' | 'email' | 'image' | … */
  category: string;
  /** Billable unit label: 'minutes' | 'segments' | 'documents' | 'emails' | 'images' | … */
  unit: string;
  /** Count of billable units (e.g. 2.5 minutes, 3 segments, 1 document). */
  quantity: number;
  /**
   * Rate-card key used to price `quantity`. Omit to skip pricing (cost null) or
   * when passing an explicit `costUsd`.
   */
  rateKey?: RateKey;
  /** Pre-computed cost; overrides rate-card lookup when provided. */
  costUsd?: number;
  /** Optional sub-type label stored in `model` (e.g. 'nova-3', 'gpt-image-1'). */
  model?: string;
  latencyMs?: number;
};

/**
 * Record one non-token paid-service event (transcription minutes, OCR docs,
 * SMS segments, emails, images, …) in the unified ledger. Cost is computed
 * from the editable rate card (`rateKey`) unless an explicit `costUsd` is
 * given. Fire-and-forget + fully guarded like recordUsage — a logging or
 * pricing failure never propagates into the caller's flow.
 */
export function recordServiceUsage(ctx: UsageCtx, ev: ServiceUsage) {
  void (async () => {
    try {
      let cost: number | null = ev.costUsd ?? null;
      if (cost == null && ev.rateKey) {
        const rate = await getRate(ev.rateKey);
        cost = rate == null ? null : rate * ev.quantity;
      }
      await db.insert(aiUsageEvents).values({
        id: randomUUID(),
        orgId: ctx.orgId,
        userId: ctx.userId,
        actor: ctx.actor,
        feature: ctx.feature,
        provider: ev.provider,
        model: ev.model ?? ev.rateKey ?? ev.provider,
        category: ev.category,
        unit: ev.unit,
        quantity: String(ev.quantity),
        promptTokens: 0,
        completionTokens: 0,
        cachedPromptTokens: 0,
        totalTokens: 0,
        costUsd: cost == null ? null : cost.toFixed(6),
        latencyMs: ev.latencyMs ?? null,
        requestId: ctx.requestId ?? null,
        metadata: ctx.metadata ?? null,
      });
    } catch (err) {
      console.error('[ai-usage] service insert failed', err);
    }
  })();
}

export type RealtimeUsageBreakdown = {
  inputTextTokens: number;
  inputAudioTokens: number;
  /** Cached text/audio input tokens — a subset of the input totals, billed at cached rates. */
  cachedTextTokens: number;
  cachedAudioTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
};

/**
 * Record one Realtime voice session's usage. Realtime audio happens
 * client↔OpenAI directly, so the browser accumulates the per-modality token
 * counts from `response.done` events and reports the session total here; we
 * price it with REALTIME_PRICING. Fire-and-forget + guarded like recordUsage.
 */
export function recordRealtimeUsage(
  ctx: UsageCtx,
  model: string,
  b: RealtimeUsageBreakdown,
  latencyMs?: number,
) {
  void (async () => {
    try {
      const p = resolveRealtimePricing(model);
      const billableInText = Math.max(0, b.inputTextTokens - b.cachedTextTokens);
      const billableInAudio = Math.max(0, b.inputAudioTokens - b.cachedAudioTokens);
      const cost = p
        ? (billableInText * p.inText +
            b.cachedTextTokens * p.inTextCached +
            billableInAudio * p.inAudio +
            b.cachedAudioTokens * p.inAudioCached +
            b.outputTextTokens * p.outText +
            b.outputAudioTokens * p.outAudio) /
          1_000_000
        : null;
      const promptTokens = b.inputTextTokens + b.inputAudioTokens;
      const completionTokens = b.outputTextTokens + b.outputAudioTokens;
      const cached = b.cachedTextTokens + b.cachedAudioTokens;
      const total = promptTokens + completionTokens;
      await db.insert(aiUsageEvents).values({
        id: randomUUID(),
        orgId: ctx.orgId,
        userId: ctx.userId,
        actor: ctx.actor,
        feature: ctx.feature,
        provider: 'openai',
        model,
        category: 'realtime',
        unit: 'tokens',
        quantity: String(total),
        promptTokens,
        completionTokens,
        cachedPromptTokens: cached,
        totalTokens: total,
        costUsd: cost == null ? null : cost.toFixed(6),
        latencyMs: latencyMs ?? null,
        requestId: ctx.requestId ?? null,
        metadata: {
          ...(ctx.metadata ?? {}),
          inputAudioTokens: b.inputAudioTokens,
          inputTextTokens: b.inputTextTokens,
          outputAudioTokens: b.outputAudioTokens,
          outputTextTokens: b.outputTextTokens,
        },
      });
    } catch (err) {
      console.error('[ai-usage] realtime insert failed', err);
    }
  })();
}
