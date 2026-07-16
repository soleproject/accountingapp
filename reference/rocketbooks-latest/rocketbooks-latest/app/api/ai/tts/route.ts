import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getOpenAI } from '@/lib/ai/openai';
import { recordTtsUsage } from '@/lib/ai/usage';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 30;

const Body = z.object({
  text: z.string().min(1).max(1000),
  voice: z
    .enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'])
    .default('nova'),
});

// Per-user sliding-window rate limiter. In-memory only — survives within a
// single serverless instance and resets on cold start. Acceptable as a first
// line of defense against a leaked session burning OpenAI credit. Persistent
// state would need Redis; revisit if abuse becomes real.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const userHits = new Map<string, number[]>();

function rateLimitOk(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const arr = userHits.get(userId) ?? [];
  const pruned = arr.filter((t) => t > cutoff);
  if (pruned.length >= RATE_LIMIT_MAX) {
    userHits.set(userId, pruned);
    return false;
  }
  pruned.push(now);
  userHits.set(userId, pruned);
  return true;
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  let orgId: string | null = null;
  try {
    orgId = await getCurrentOrgId();
  } catch {
    // Allow no-org users; usage row just records null orgId.
  }

  if (!rateLimitOk(session.id)) {
    return NextResponse.json(
      { error: 'Too many TTS requests — try again in a minute' },
      { status: 429 },
    );
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 503 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { text, voice } = parsed.data;
  const started = Date.now();
  const model = 'tts-1';

  try {
    const speech = await getOpenAI().audio.speech.create({
      model,
      voice,
      input: text,
      response_format: 'mp3',
    });
    const audio = await speech.arrayBuffer();
    recordTtsUsage(
      {
        userId: session.id,
        orgId,
        actor: 'user',
        feature: 'ai-chat-tts',
        metadata: { voice },
      },
      model,
      text.length,
      Date.now() - started,
    );
    return new Response(audio, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, voice, chars: text.length },
      'tts route failed',
    );
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'TTS failed' },
      { status: 502 },
    );
  }
}
