/**
 * Review v2 transform — reshape the existing 11-item batch data into
 * the three-stage flow proposed in the redesign (Account pairs →
 * $-sorted pattern groups → one-offs), computing dollar-based
 * progress along the way.
 *
 * Pure function. Never mutates the input. Anything the existing batch
 * shape does not support gets appended to `unsupported_flags` so the
 * lab UI can surface a banner instead of silently faking data.
 *
 * Batch item shape (from /app/backend/client_review.py):
 *   {
 *     item_id, item_type,           // 1..14 — see ITEM_* constants
 *     source_id, source_collection,
 *     prompt,                       // AI-composed question
 *     context: {
 *       date, amount, description, merchant, account,
 *       // type-specific keys inside meta / etc.
 *     },
 *     answered_at, answer, deferred, action_taken,
 *   }
 */

// Item type IDs mirror ITEM_* constants in client_review.py. Keep in
// sync if new types are added there.
export const IT = {
  UNCATEGORIZED:      1,
  VENDOR_MEMO:        2,
  MISSING_RECEIPT:    3,
  W9_NEEDED:          4,
  AMBIGUOUS_TRANSFER: 5,
  RECURRING:          6,
  SETUP:              7,
  SPLIT:              8,
  LIABILITY_SPLIT:    9,
  IRS_MEALS:         10,
  OWNER_DRAW:        11,
  DEPOSIT:           12,
  CHECK_NO_CONTACT:  13,
  IRS_TRAVEL:        14,
};

// Stage 2 = "confirm patterns" — pattern-shaped items.
const PATTERN_ITEMS   = new Set([IT.UNCATEGORIZED, IT.VENDOR_MEMO, IT.SPLIT, IT.RECURRING]);
// Stage 3 = "one-offs" — checks, single-txn compliance flags, etc.
const ONEOFF_ITEMS    = new Set([
  IT.CHECK_NO_CONTACT, IT.MISSING_RECEIPT, IT.W9_NEEDED,
  IT.LIABILITY_SPLIT, IT.IRS_MEALS, IT.IRS_TRAVEL,
  IT.OWNER_DRAW, IT.DEPOSIT, IT.SETUP,
]);

// -------- Merchant name cleaner ---------------------------------------
// Turns bank-feed noise ("PAYPAL DES:INST XFER ID:CREDIT REPAYMEN
// INDN:EIMORLAIN UGALI CO ID:PAYPALSI77 WEB") into something a client
// can read ("Eimorlain Ugali" or "PayPal transfer"). Non-destructive:
// callers still show the raw description underneath.
const _NOISE_TOKENS = [
  /\bDES:[A-Z0-9 ]+/g,
  /\bID:[A-Z0-9]+/g,
  /\bINDN:/g, /\bCO ID:/g, /\bWEB\b/g, /\bPPD\b/g, /\bACH\b/g,
  /\bXFER\b/g, /\bTRANSFER\b/gi,
  /\s{2,}/g,
  /\bREF:?\s*\w+/gi,
  /#\s*\d+/g,
];
export function cleanMerchant(raw) {
  if (!raw) return "Unknown";
  let s = String(raw);
  // Grab INDN:XXXX first — that's the counterparty on ACH pulls
  const indn = s.match(/INDN:([A-Z][A-Z\s]+?)(?:\s+CO ID|\s+ID:|$)/i);
  if (indn) {
    return _titleCase(indn[1].trim());
  }
  // PayPal / Venmo / Zelle — call it out but preserve the memo tail
  const paypal = s.match(/PAYPAL.*?(?:CREDIT|DEBIT|REPAYMENT|PAYMENT)/i);
  if (paypal) return "PayPal transfer";
  for (const re of _NOISE_TOKENS) s = s.replace(re, " ");
  // Strip trailing store/city codes ("STORE 1234 SAN FRANCISCO CA")
  s = s.replace(/\s+\d{2,6}\s+[A-Z][A-Z\s]+[A-Z]{2}\s*$/i, "");
  s = s.replace(/[^A-Za-z0-9 \-&.'’]/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!s || s.length > 60) return _titleCase(String(raw).split(/\s+/).slice(0, 3).join(" "));
  return _titleCase(s);
}
function _titleCase(s) {
  return s.toLowerCase().split(" ").map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ").trim();
}

const abs = (n) => Math.abs(Number(n) || 0);
const isAnswered = (it) => !!it.answered_at || !!it.deferred;
const groupKey = (ctx) => {
  const raw = (ctx?.merchant || ctx?.description || "Unknown").toString().trim() || "Unknown";
  return cleanMerchant(raw);
};

// -------- Stage 1: account-pair transfer confirmations -----------------
function buildAccountPairs(items, unsupported) {
  const transfers = items.filter(i => i.item_type === IT.AMBIGUOUS_TRANSFER);
  if (transfers.length === 0) return [];

  // Try to key by `from_account` / `to_account` on the item context. If
  // the existing batch generator doesn't stamp those fields yet, fall
  // back to the single `account` string and flag the gap.
  const pairs = new Map();
  let missingPairMeta = 0;
  for (const t of transfers) {
    const ctx = t.context || {};
    const from = ctx.from_account || ctx.source_account || ctx.account || null;
    const to   = ctx.to_account   || ctx.dest_account   || null;
    if (!from || !to) missingPairMeta += 1;
    const key = `${from || "?"} ⇄ ${to || "?"}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        pair_id:        `pair-${pairs.size}`,
        from, to,
        transfer_count: 0,
        total_dollars:  0,
        samples:        [],
        items:          [],
      });
    }
    const p = pairs.get(key);
    p.transfer_count += 1;
    p.total_dollars  += abs(ctx.amount);
    if (p.samples.length < 3) {
      p.samples.push({
        date:   ctx.date,
        amount: abs(ctx.amount),
        from, to,
      });
    }
    p.items.push(t);
  }

  if (missingPairMeta > 0) {
    unsupported.push(
      `${missingPairMeta} ambiguous-transfer item(s) lack from/to account metadata — ` +
      `stage 1 pair questions will show placeholder account labels. Enrich the batch ` +
      `generator to stamp \`context.from_account\` and \`context.to_account\`.`
    );
  }

  return Array.from(pairs.values())
    .sort((a, b) => b.total_dollars - a.total_dollars);
}

// -------- Stage 2: $-sorted pattern groups (contact/vendor/desc) -------
function buildPatternGroups(items, unsupported) {
  const groups = new Map();
  for (const it of items) {
    if (!PATTERN_ITEMS.has(it.item_type)) continue;
    const ctx = it.context || {};
    const key = groupKey(ctx);
    if (!groups.has(key)) {
      groups.set(key, {
        group_id:         `grp-${groups.size}`,
        label:            key,
        money_in_count:   0, money_out_count:   0,
        money_in_total:   0, money_out_total:   0,
        samples_in:       [], samples_out:      [],
        ai_suggestion:    null, confidence:      null,
        outliers:         [],
        items:            [],
      });
    }
    const g = groups.get(key);
    const amt = Number(ctx.amount) || 0;
    const isIn = amt > 0;
    if (isIn) {
      g.money_in_count += 1;
      g.money_in_total += abs(amt);
      if (g.samples_in.length < 3) {
        g.samples_in.push({ date: ctx.date, amount: abs(amt), desc: ctx.description });
      }
    } else {
      g.money_out_count += 1;
      g.money_out_total += abs(amt);
      if (g.samples_out.length < 3) {
        g.samples_out.push({ date: ctx.date, amount: abs(amt), desc: ctx.description });
      }
    }
    g.items.push(it);

    // Bubble up the AI's proposed category, if any. Existing batch
    // items don't consistently expose confidence, so fall back to a
    // heuristic (any suggestion → 0.7, none → null → asks a question).
    if (!g.ai_suggestion) {
      g.ai_suggestion = ctx.proposed_category || ctx.suggested_category || null;
      if (g.ai_suggestion) g.confidence = 0.75;
    }
  }

  // Flag outliers per group — a $1 payment inside a $6k pattern, a
  // singleton on the minority side, etc.
  for (const g of groups.values()) {
    const minority = g.money_in_count > g.money_out_count ? "out" : "in";
    const minCount = minority === "out" ? g.money_out_count : g.money_in_count;
    if (minCount > 0 && minCount <= 2 && g.items.length >= 5) {
      // The minority side is 1-2 rows in an otherwise consistent
      // pattern → likely test payment, refund, or reimbursement.
      const samples = minority === "out" ? g.samples_out : g.samples_in;
      for (const s of samples) {
        if (s.amount < 5) {
          g.outliers.push({
            reason: "test_payment",
            side:   minority,
            date:   s.date, amount: s.amount,
          });
        }
      }
    }
  }

  if (items.some(i => PATTERN_ITEMS.has(i.item_type) &&
                       !(i.context?.proposed_category || i.context?.suggested_category))) {
    unsupported.push(
      "Some pattern items don't carry an AI-proposed category (existing batch " +
      "doesn't expose one). Those groups will ask a relationship question " +
      "instead of showing a one-tap confirm."
    );
  }

  return Array.from(groups.values())
    .map(g => ({
      ...g,
      total_dollars: g.money_in_total + g.money_out_total,
      is_mixed:      g.money_in_count > 0 && g.money_out_count > 0,
    }))
    .sort((a, b) => b.total_dollars - a.total_dollars);
}

// -------- Stage 3: one-offs (checks + flags) ---------------------------
function buildOneOffs(items, unsupported) {
  const out = [];
  for (const it of items) {
    if (!ONEOFF_ITEMS.has(it.item_type)) continue;
    const ctx = it.context || {};
    out.push({
      one_off_id: it.item_id,
      kind:       _oneOffKind(it.item_type),
      item_type:  it.item_type,
      date:       ctx.date || ctx.meta?.date,
      amount:     abs(ctx.amount ?? ctx.meta?.amount),
      description: ctx.description || ctx.meta?.description || ctx.title || it.prompt,
      check_number: ctx.check_number || ctx.meta?.check_number,
      recent_payees: ctx.meta?.recent_payees || [],
      prompt:     it.prompt,
      raw_item:   it,
    });
  }
  // Anything left that we didn't classify
  const known = new Set([
    ...PATTERN_ITEMS, ...ONEOFF_ITEMS, IT.AMBIGUOUS_TRANSFER,
  ]);
  for (const it of items) {
    if (!known.has(it.item_type)) {
      unsupported.push(
        `Item type ${it.item_type} is not mapped into any v2 stage — skipping.`
      );
    }
  }
  return out.sort((a, b) => (b.amount || 0) - (a.amount || 0));
}

function _oneOffKind(t) {
  if (t === IT.CHECK_NO_CONTACT) return "check";
  if (t === IT.MISSING_RECEIPT)  return "missing_receipt";
  if (t === IT.W9_NEEDED)        return "w9";
  if (t === IT.LIABILITY_SPLIT)  return "liability_split";
  if (t === IT.IRS_MEALS)        return "irs_meals";
  if (t === IT.IRS_TRAVEL)       return "irs_travel";
  if (t === IT.OWNER_DRAW)       return "owner_draw";
  if (t === IT.DEPOSIT)          return "deposit";
  return "flag";
}

// -------- Progress: dollars, not rows ---------------------------------
function computeProgress(items, stages) {
  const totalDollars = items.reduce((s, i) => s + abs(i.context?.amount), 0);
  const answeredDollars = items
    .filter(isAnswered)
    .reduce((s, i) => s + abs(i.context?.amount), 0);

  const questionsLeft =
      stages.stage1_accounts.length
    + stages.stage2_patterns.length
    + stages.stage3_oneoffs.length;

  const pct = totalDollars > 0
    ? Math.round((answeredDollars / totalDollars) * 100)
    : 0;

  return {
    dollars_confirmed: answeredDollars,
    dollars_total:     totalDollars,
    pct_confirmed:     pct,
    questions_left:    questionsLeft,
  };
}

/**
 * Main entry — takes a batch document and produces the v2 shape.
 * If `batch` is null/empty, returns an empty scaffold so the lab UI
 * can render "no pending batch" gracefully.
 *
 * `extraStage1Pairs` (optional) is the ledger-derived transfer-pair
 * list from GET /companies/{cid}/reviewv2/account-pairs. It's merged
 * IN FRONT of any type-5 items surfaced by the batch itself so
 * Stage 1 still lights up on companies whose transfers auto-match
 * (no ambiguous ones ever land in the batch).
 */
export function transformBatchToV2(batch, extraStage1Pairs = []) {
  const items = (batch?.items || []).filter(i => !isAnswered(i));
  const unsupported_flags = [];

  const ledgerPairs = (extraStage1Pairs || []).map(p => ({
    pair_id:        p.pair_id,
    from:           p.from,
    to:             p.to,
    from_id:        p.from_id,
    to_id:          p.to_id,
    transfer_count: p.transfer_count,
    total_dollars:  p.total_dollars,
    samples:        (p.samples || []).map(s => ({ ...s, from: p.from, to: p.to })),
    items:          [],
    source:         "ledger",
  }));
  const batchPairs = buildAccountPairs(items, unsupported_flags).map(p => ({ ...p, source: "batch" }));
  const stage1_accounts = [...ledgerPairs, ...batchPairs];

  const rawPatterns = buildPatternGroups(items, unsupported_flags);
  // Single-transaction groups get promoted to Stage 3 — the client
  // shouldn't hit a "pattern" card for something with only one row.
  const stage2_patterns = rawPatterns.filter(g => g.items.length >= 2);
  const singletonItems = rawPatterns
    .filter(g => g.items.length < 2)
    .flatMap(g => g.items);

  const oneOffs = buildOneOffs(items, unsupported_flags);
  // Fold promoted singletons into stage 3 as generic "what was this for?"
  // cards. They share the same rendered shape.
  for (const it of singletonItems) {
    const ctx = it.context || {};
    oneOffs.push({
      one_off_id:   it.item_id,
      kind:         "singleton",
      item_type:    it.item_type,
      date:         ctx.date,
      amount:       abs(ctx.amount),
      direction:    (Number(ctx.amount) || 0) >= 0 ? "in" : "out",
      merchant:     cleanMerchant(ctx.merchant || ctx.description || ""),
      description:  ctx.description || ctx.merchant || "",
      prompt:       it.prompt,
      raw_item:     it,
    });
  }
  const stage3_oneoffs = oneOffs.sort((a, b) => (b.amount || 0) - (a.amount || 0));

  // Enrich stage 3 items with cleaned merchant + direction if missing.
  for (const o of stage3_oneoffs) {
    if (!o.direction) {
      const raw = o.raw_item?.context?.amount ?? o.amount;
      o.direction = Number(raw) >= 0 ? "in" : "out";
    }
    if (!o.merchant) {
      o.merchant = cleanMerchant(o.raw_item?.context?.merchant || o.raw_item?.context?.description || o.description || "");
    }
  }

  const progress = computeProgress(batch?.items || [], {
    stage1_accounts, stage2_patterns, stage3_oneoffs,
  });

  return {
    batch_id:       batch?.id || null,
    stage1_accounts,
    stage2_patterns,
    stage3_oneoffs,
    progress,
    // Lab-only mock — never shown on the client route. The banner is
    // strictly aspirational until the real auto-post + undo log lands.
    ai_handled_rows: 1412,
    unsupported_flags,
  };
}
