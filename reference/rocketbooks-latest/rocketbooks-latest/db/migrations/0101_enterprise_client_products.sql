-- Per-enterprise allowlist of GATED billing products (custom SKUs) that an
-- enterprise exposes to its client orgs on /billing.
--
-- A "gated" product is any billing_product whose feature_key is NOT one of the
-- built-ins (base_seat, qbo_mirroring, demo_full, the year unlocks, the
-- enterprise_seat_* tiers). Gated products are hidden from client billing pages
-- by default; a superadmin or the enterprise owner opts a client into seeing
-- one by adding a row here. Built-in products keep their existing global
-- visibility — this table never restricts them.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.enterprise_client_products (
  id                 varchar PRIMARY KEY,
  enterprise_id      varchar NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  billing_product_id varchar NOT NULL REFERENCES public.billing_products(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- One row per (enterprise, product) — toggling is add/remove of this pair.
CREATE UNIQUE INDEX IF NOT EXISTS ix_ent_client_products_unique
  ON public.enterprise_client_products (enterprise_id, billing_product_id);

CREATE INDEX IF NOT EXISTS ix_ent_client_products_enterprise
  ON public.enterprise_client_products (enterprise_id);
