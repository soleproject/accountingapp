-- Generalize the AI-usage ledger into a unified per-use COST ledger.
--
-- The table keeps its physical name `ai_usage_events` ON PURPOSE: prod code
-- reads/writes that name and migrations apply to the live DB before the new
-- deploy lands, so a RENAME would break the running app during the window.
-- Instead we generalize in place — the same table now holds every billable
-- per-use event (LLM tokens, TTS chars, transcription minutes, OCR docs, SMS
-- segments, emails, …). `provider` is the service key; the three new columns
-- describe the billable unit for non-token services.
--
-- Idempotent — safe to re-run.

-- 1. Generalizing columns.
--    category  — coarse grouping for the UI: 'llm' | 'tts' | 'realtime' |
--                'image' | 'transcription' | 'ocr' | 'sms' | 'email' | 'bank' …
--    quantity  — the billable unit count (minutes, segments, documents,
--                emails, images, items). For LLM rows we mirror total_tokens
--                here so a single column can be summed across services.
--    unit      — human label for `quantity`: 'tokens' | 'characters' |
--                'minutes' | 'segments' | 'documents' | 'emails' | 'images' …
ALTER TABLE public.ai_usage_events
  ADD COLUMN IF NOT EXISTS category varchar,
  ADD COLUMN IF NOT EXISTS quantity numeric(14, 4),
  ADD COLUMN IF NOT EXISTS unit     varchar;

CREATE INDEX IF NOT EXISTS ix_ai_usage_category
  ON public.ai_usage_events (category);
CREATE INDEX IF NOT EXISTS ix_ai_usage_provider
  ON public.ai_usage_events (provider);

-- 2. Backfill existing rows. Everything currently in the table is OpenAI
--    token/char usage. TTS rows stashed the char count in total_tokens (see
--    lib/ai/usage.ts recordTtsUsage); detect them by the tts-* model prefix.
UPDATE public.ai_usage_events
SET category = CASE WHEN model LIKE 'tts-%' THEN 'tts' ELSE 'llm' END,
    unit     = CASE WHEN model LIKE 'tts-%' THEN 'characters' ELSE 'tokens' END,
    quantity = total_tokens
WHERE category IS NULL;

-- 3. Editable per-unit rate card. Surfaced + editable in the superadmin
--    "Usage & Costs" page (per the "expose AI config in UI" rule) rather than
--    hardcoded in code. recordServiceUsage() reads the rate for a given key
--    and computes cost = quantity * rate_usd. LLM token pricing (in/out/cached)
--    keeps its own shape in lib/ai/usage.ts and is NOT in this table.
--
--    key      — stable lookup id, e.g. 'deepgram:minute', 'twilio:segment'.
--    provider — service key matching ai_usage_events.provider.
--    unit     — the billable unit this rate is per (one of the unit labels above).
--    rate_usd — USD per single unit.
CREATE TABLE IF NOT EXISTS public.usage_rates (
  key         varchar PRIMARY KEY,
  provider    varchar NOT NULL,
  label       varchar NOT NULL,
  unit        varchar NOT NULL,
  rate_usd    numeric(14, 8) NOT NULL DEFAULT 0,
  notes       varchar,
  updated_by  varchar,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 4. Seed default rates. ON CONFLICT DO NOTHING so re-runs never clobber an
--    operator's edits. Defaults are best-effort public list prices as of
--    2026-06 — edit them in the UI to match your contracts. Phase-2 services
--    (daily/recall/plaid) are seeded now so the rates are ready before their
--    events start flowing.
INSERT INTO public.usage_rates (key, provider, label, unit, rate_usd, notes) VALUES
  ('deepgram:minute',          'deepgram', 'Deepgram transcription',   'minutes',   0.00430000, 'nova-3 prerecorded, $/audio-minute'),
  ('veryfi:document',          'veryfi',   'Veryfi OCR',               'documents', 0.16000000, '$/document processed'),
  ('twilio:segment',           'twilio',   'Twilio SMS',               'segments',  0.00790000, '$/message segment (US)'),
  ('resend:email',             'resend',   'Resend email',             'emails',    0.00040000, '$/email sent'),
  ('openai-image:low',         'openai',   'OpenAI image (low)',       'images',    0.01100000, 'gpt-image-1 low quality'),
  ('openai-image:medium',      'openai',   'OpenAI image (medium)',    'images',    0.04200000, 'gpt-image-1 medium quality'),
  ('openai-image:high',        'openai',   'OpenAI image (high)',      'images',    0.16700000, 'gpt-image-1 high quality'),
  ('daily:participant-minute', 'daily',    'Daily.co video',           'minutes',   0.00400000, '$/participant-minute (Phase 2)'),
  ('recall:recording-hour',    'recall',   'Recall.ai bot',            'hours',     0.50000000, '$/recording-hour (Phase 2)'),
  ('plaid:item-month',         'plaid',    'Plaid linked item',        'items',     0.30000000, '$/linked item/month (Phase 2)')
ON CONFLICT (key) DO NOTHING;
