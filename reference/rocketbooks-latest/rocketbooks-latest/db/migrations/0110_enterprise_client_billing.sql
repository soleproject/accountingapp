-- Per-client billing override for enterprises on the "It varies per client"
-- billing mode (organizations.client_billing_mode = 'varies'). Set when the
-- firm adds/imports a client and chooses who pays + the price for that client.
-- NULL = inherit the firm's setting (today's behavior for every other firm).
--
-- Idempotent.

ALTER TABLE public.enterprise_clients
  ADD COLUMN IF NOT EXISTS client_billing_mode varchar,
  ADD COLUMN IF NOT EXISTS client_price_mode varchar;
