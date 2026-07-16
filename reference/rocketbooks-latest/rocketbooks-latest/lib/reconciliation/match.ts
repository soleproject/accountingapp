import { daysBetween, round2 } from './dates';
import type { SourceLine, LedgerTxn, Match, MatchResult } from './types';

// Pure matching heuristics: source statement/Plaid lines ↔ ledger transactions.
// No DB access — unit-testable. Greedy one-to-one across three passes.

function normDesc(s: string): Set<string> {
  return new Set(
    (s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function matchSourceToLedger(source: SourceLine[], ledger: LedgerTxn[]): MatchResult {
  const matches: Match[] = [];
  const usedSrc = new Set<string>();
  const usedLed = new Set<string>();
  const ledgerById = new Map(ledger.map((t) => [t.id, t]));
  const ledgerByRef = new Map(ledger.filter((t) => t.reference).map((t) => [t.reference as string, t]));

  const add = (s: SourceLine, t: LedgerTxn, matchType: Match['matchType'], score: number) => {
    matches.push({ sourceExternalId: s.externalId, transactionId: t.id, matchType, score, createdBy: 'engine' });
    usedSrc.add(s.externalId);
    usedLed.add(t.id);
  };

  // Pass 0 — direct hints: statement promote-link (txn id) or Plaid reference.
  for (const s of source) {
    if (usedSrc.has(s.externalId)) continue;
    let t: LedgerTxn | undefined;
    if (s.matchHintTxnId) {
      const cand = ledgerById.get(s.matchHintTxnId);
      if (cand && !usedLed.has(cand.id)) t = cand;
    }
    if (!t && s.matchHintRef) {
      const cand = ledgerByRef.get(s.matchHintRef);
      if (cand && !usedLed.has(cand.id)) t = cand;
    }
    if (t) add(s, t, 'EXACT', 1);
  }

  // Pass 1 — exact amount (±$0.01), date window 0 then widened to ±3 days
  // (clearing/timing differences between when an entry was booked vs cleared).
  for (const window of [0, 3]) {
    for (const s of source) {
      if (usedSrc.has(s.externalId)) continue;
      const cand = ledger.find(
        (t) =>
          !usedLed.has(t.id) &&
          Math.abs(t.signedAmount - s.signedAmount) < 0.01 &&
          daysBetween(s.date, t.date) <= window,
      );
      if (cand) add(s, cand, 'EXACT', window === 0 ? 0.99 : 0.95);
    }
  }

  // Pass 2 — fuzzy: near-amount (±$0.02), within ±5 days, weighted by amount,
  // date proximity, and description token overlap. Greedy by descending score.
  const candidates: { s: SourceLine; t: LedgerTxn; score: number }[] = [];
  for (const s of source) {
    if (usedSrc.has(s.externalId)) continue;
    const sd = normDesc(s.description);
    for (const t of ledger) {
      if (usedLed.has(t.id)) continue;
      const amtDiff = Math.abs(t.signedAmount - s.signedAmount);
      if (amtDiff > 0.02) continue;
      const days = daysBetween(s.date, t.date);
      if (days > 5) continue;
      const score = 0.4 * (1 - amtDiff / 0.02) + 0.3 * (1 - days / 5) + 0.3 * jaccard(sd, normDesc(t.description));
      candidates.push({ s, t, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (usedSrc.has(c.s.externalId) || usedLed.has(c.t.id)) continue;
    if (c.score < 0.7) break;
    add(c.s, c.t, 'FUZZY', round2(c.score));
  }

  return {
    matches,
    unmatchedSource: source.filter((s) => !usedSrc.has(s.externalId)),
    unmatchedLedger: ledger.filter((t) => !usedLed.has(t.id)),
  };
}
