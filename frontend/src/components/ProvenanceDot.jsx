import React from "react";

// ProvenanceDot — 4px colored dot next to a transaction's category
// that indicates WHICH tier of the categorization cascade decided
// the answer. Hover reveals the full source label + confidence.
//
// Visible ONLY when the company setting
// `show_categorization_source_badges` is true (default OFF). This
// keeps the transactions page uncluttered for non-CPA users while
// giving CPAs at-a-glance provenance information during review.
//
// Color legend:
//   emerald  → tenant's own decision (Custom Rule / Rules Miner / Merchant Memory)
//   blue     → Standard+ Global Vendor Rule
//   cyan     → Plaid PFC fallback (from PFC taxonomy)
//   amber    → LLM guess (Standard's AI cascade OR AI-First)
//   gray     → uncategorized / manual / unknown

const SOURCE_META = {
  // Tenant-tier (highest priority)
  rule:          { color: "bg-emerald-500", label: "Your custom rule" },
  rules_miner:   { color: "bg-emerald-500", label: "Learned from your prior corrections" },
  memory:        { color: "bg-emerald-500", label: "Your merchant memory" },
  user:          { color: "bg-emerald-500", label: "Manual override" },
  human_reviewed:{ color: "bg-emerald-500", label: "Reviewed by you" },

  // Standard+ Global Rules
  standard_plus_directory: { color: "bg-violet-500", label: "Standard+ Global Contact Directory" },
  standard_plus_rule:      { color: "bg-blue-500",   label: "Standard+ Global Vendor Rule" },
  standard_plus_pfc:       { color: "bg-cyan-500",   label: "Plaid PFC (Standard+ fallback)" },

  // Standard's built-in PFC (pre-Standard+)
  pfc_business:  { color: "bg-cyan-500",  label: "Plaid PFC (business)" },
  pfc_personal:  { color: "bg-cyan-500",  label: "Plaid PFC (personal)" },
  pfc:           { color: "bg-cyan-500",  label: "Plaid PFC" },

  // LLM cascade
  ai:                      { color: "bg-amber-500", label: "AI (Standard LLM)" },
  llm:                     { color: "bg-amber-500", label: "AI (LLM)" },
  ai_first:                { color: "bg-slate-400", label: "AI-First (legacy — retired)" },
  ai_first_propagated:     { color: "bg-slate-400", label: "AI-First cluster (legacy — retired)" },
  ai_first_fallback:       { color: "bg-slate-400", label: "AI-First fallback (legacy — retired)" },
  liability_paydown_guard: { color: "bg-amber-500", label: "Liability paydown guard" },
};

export function ProvenanceDot({ source, matched, semantic, confidence, bucket }) {
  const meta = SOURCE_META[source] || { color: "bg-slate-400", label: source || "Unknown source" };
  const tip = [
    meta.label,
    matched ? `→ ${matched}` : null,
    bucket ? `bucket: ${bucket}` : null,
    semantic ? `semantic: ${semantic}` : null,
    typeof confidence === "number" ? `conf ${confidence.toFixed(2)}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${meta.color} flex-none`}
      title={tip}
      data-testid="provenance-dot"
      data-source={source || ""}
      aria-label={tip}
    />
  );
}

export default ProvenanceDot;
