"""Lab pipeline v3 — read-only reprocessing on top of stored live data.

Isolation contract (per Feb-2026 spec):
  * NO writes to live collections. All writes go to ``lab_*`` collections.
  * NO modifications to the live Plaid → transactions ingestion path.
  * NO LLM calls on page load. Deterministic first; LLM only fills gaps
    (Phases 2+).

Feature-gated by ``companies.features.lab_pipeline_v3`` (default OFF).
Enabled today ONLY on the picked test companies.
"""
