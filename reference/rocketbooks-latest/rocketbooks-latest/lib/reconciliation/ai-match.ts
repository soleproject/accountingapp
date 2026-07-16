import 'server-only';
import { chatCompletion } from '@/lib/ai/openai';
import type { UsageCtx } from '@/lib/ai/usage';
import type { SourceLine, LedgerTxn, Match } from './types';

const MODEL = 'gpt-4o-mini';

export interface AiMatchResult {
  matches: Match[];
  explanation: string;
}

/**
 * LLM pass over the residual unmatched lines: suggests confident pairings the
 * heuristics missed (fuzzy/transfer) and writes a plain-language explanation of
 * the reconciliation result. Returns no matches + empty explanation on any
 * failure (engine then falls back to a templated explanation). Suggestions are
 * validated against the actual unmatched sets — a hallucinated id is dropped.
 */
export async function aiMatchAndExplain(args: {
  ctx: UsageCtx;
  accountName: string;
  period: string;
  sourceKind: 'statement' | 'plaid';
  unmatchedSource: SourceLine[];
  unmatchedLedger: LedgerTxn[];
  difference: number | null;
  matchedCount: number;
}): Promise<AiMatchResult> {
  const src = args.unmatchedSource.slice(0, 40).map((s) => ({
    externalId: s.externalId,
    date: s.date,
    amount: s.signedAmount,
    desc: (s.description ?? '').slice(0, 60),
  }));
  const led = args.unmatchedLedger.slice(0, 40).map((t) => ({
    id: t.id,
    date: t.date,
    amount: t.signedAmount,
    desc: (t.description ?? '').slice(0, 60),
    manual: t.isManual,
  }));

  const sys = `You are a bookkeeping reconciliation assistant. You compare a bank ${args.sourceKind}'s transactions ("source") against the accounting ledger for one bank account and month. Amounts are SIGNED: positive = money into the account, negative = out. Return ONLY JSON.`;
  const user = [
    `Account: ${args.accountName}. Period: ${args.period}. ${args.matchedCount} lines already matched automatically.`,
    `Closing-balance difference (source minus ledger): ${args.difference ?? 'unknown'}.`,
    `UNMATCHED SOURCE lines: ${JSON.stringify(src)}`,
    `UNMATCHED LEDGER transactions: ${JSON.stringify(led)}`,
    `Do two things:`,
    `1) Suggest pairings where an unmatched SOURCE line and an unmatched LEDGER transaction are clearly the SAME real transaction (same amount, near date, similar description). Only confident ones; use the exact externalId / id given.`,
    `2) Write a SHORT (2-4 sentence) plain-language explanation of why this account does or does not reconcile. Name likely causes using the data: outstanding/uncleared items, timing differences, a missing entry, a duplicate, or a manual entry not on the bank ${args.sourceKind}.`,
    `Return ONLY: {"matches":[{"externalId":string,"transactionId":string,"matchType":"FUZZY"|"TRANSFER","confidence":number}],"explanation":string}`,
  ].join('\n');

  let parsed: {
    matches?: Array<{ externalId?: string; transactionId?: string; matchType?: string; confidence?: number }>;
    explanation?: string;
  } = {};
  try {
    const res = await chatCompletion(
      { ...args.ctx, feature: 'reconcile-ai-match' },
      {
        model: MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
      },
    );
    parsed = JSON.parse(res.choices[0]?.message?.content ?? '{}');
  } catch {
    return { matches: [], explanation: '' };
  }

  const srcIds = new Set(args.unmatchedSource.map((s) => s.externalId));
  const ledIds = new Set(args.unmatchedLedger.map((t) => t.id));
  const usedS = new Set<string>();
  const usedT = new Set<string>();
  const matches: Match[] = [];
  for (const m of parsed.matches ?? []) {
    if (!m.externalId || !m.transactionId) continue;
    if (!srcIds.has(m.externalId) || !ledIds.has(m.transactionId)) continue; // anti-hallucination
    if (usedS.has(m.externalId) || usedT.has(m.transactionId)) continue;
    const conf = typeof m.confidence === 'number' ? m.confidence : 0;
    if (conf < 0.6) continue;
    usedS.add(m.externalId);
    usedT.add(m.transactionId);
    matches.push({
      sourceExternalId: m.externalId,
      transactionId: m.transactionId,
      matchType: m.matchType === 'TRANSFER' ? 'TRANSFER' : 'FUZZY',
      score: conf,
      createdBy: 'ai',
    });
  }

  return { matches, explanation: (parsed.explanation ?? '').slice(0, 1200) };
}
