-- Logo variants for theme-aware, collapse-aware branding. The existing
-- organizations.logo_url is the light-mode full wordmark; these add the
-- dark-mode wordmark and the collapsed-sidebar icon (light + dark). All
-- nullable; the sidebar falls back to logo_url, then the default RocketSuite
-- assets. Stored as data URLs like logo_url. Idempotent.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS logo_url_dark       text,
  ADD COLUMN IF NOT EXISTS logo_icon_url       text,
  ADD COLUMN IF NOT EXISTS logo_icon_dark_url  text;
