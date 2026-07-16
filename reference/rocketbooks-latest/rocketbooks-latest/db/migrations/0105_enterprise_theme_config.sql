-- Enterprise white-label Theme Studio: a JSON map of token → hex overrides on
-- the enterprise org. Only customized tokens are stored; anything absent falls
-- back to the RocketBooks default (so "reset" = clear this). Additive.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS theme_config jsonb;
