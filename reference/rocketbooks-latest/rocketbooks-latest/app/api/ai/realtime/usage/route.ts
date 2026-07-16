import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId, isSuperAdmin } from '@/lib/auth/org';
import { REALTIME_MODEL } from '@/lib/ai/realtime-voices';
import { recordRealtimeUsage } from '@/lib/ai/usage';

/**
 * Receives a Realtime voice session's accumulated token usage from the browser
 * (the audio stream is client↔OpenAI, so the server never sees per-response
 * usage — the client tallies it from `response.done` events and reports the
 * session total here on disconnect). We price + record it into the unified
 * ledger. Gated to super-admins, matching the token-mint route (Realtime is
 * super-admin only).
 */

const tok = z.number().int().nonnegative().max(50_000_000).optional();
const Body = z.object({
  model: z.string().max(80).optional(),
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  inputTextTokens: tok,
  inputAudioTokens: tok,
  cachedTextTokens: tok,
  cachedAudioTokens: tok,
  outputTextTokens: tok,
  outputAudioTokens: tok,
});

export async function POST(req: NextRequest) {
  const user = await requireSession();
  if (!(await isSuperAdmin())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const orgId = await getCurrentOrgId();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const b = parsed.data;

  const breakdown = {
    inputTextTokens: b.inputTextTokens ?? 0,
    inputAudioTokens: b.inputAudioTokens ?? 0,
    cachedTextTokens: b.cachedTextTokens ?? 0,
    cachedAudioTokens: b.cachedAudioTokens ?? 0,
    outputTextTokens: b.outputTextTokens ?? 0,
    outputAudioTokens: b.outputAudioTokens ?? 0,
  };

  // Nothing billable → don't write an empty row (e.g. a session that errored
  // before any response completed).
  const total = Object.values(breakdown).reduce((s, n) => s + n, 0);
  if (total === 0) return NextResponse.json({ ok: true, recorded: false });

  recordRealtimeUsage(
    { userId: user.id, orgId, actor: 'voice-mode', feature: 'ai-realtime-voice' },
    b.model || REALTIME_MODEL,
    breakdown,
    b.durationMs,
  );

  return NextResponse.json({ ok: true, recorded: true });
}
