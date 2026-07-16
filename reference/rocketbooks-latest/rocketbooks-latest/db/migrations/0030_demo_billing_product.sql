-- Seed: demo_full billing product used by self-serve Enterprise demo
-- signups. Inserted via apply-demo-billing-product.ts because the catalog
-- otherwise lives behind super-admin /products. Free (0 cents), no Stripe
-- IDs -- entitlement checks gate on feature_key + the per-org subscription
-- row's current_period_end, never on Stripe state.
--
-- Idempotent: skipped when a row with feature_key='demo_full' already
-- exists. The unique index on (feature_key, coalesce(period_year, 0)) is
-- the real guard; this WHERE NOT EXISTS just avoids the noisy error.

INSERT INTO public.billing_products (
  id,
  name,
  description,
  kind,
  feature_key,
  period_year,
  unit_amount_cents,
  currency,
  active
)
SELECT
  'demo_full',
  'Demo Trial',
  '7-day full-access trial for self-serve Enterprise demo signups.',
  'subscription',
  'demo_full',
  NULL,
  0,
  'usd',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM public.billing_products WHERE feature_key = 'demo_full'
);
