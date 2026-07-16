-- Dashboard "needs a reply" lifecycle for texts. The organizer dashboard's
-- Texts card shows a thread when its latest message is inbound (the contact
-- texted last and is awaiting a reply). A reply auto-clears it (latest becomes
-- outbound); this column lets a user MANUALLY clear a still-unanswered thread
-- ("mark reviewed") without sending a reply. Set on the latest inbound message
-- when dismissed; a newer inbound message (dismissed_at null) brings it back.
-- Viewing a text does NOT set this — only an explicit review. Idempotent.

ALTER TABLE public.text_messages
  ADD COLUMN IF NOT EXISTS dashboard_dismissed_at timestamptz;
