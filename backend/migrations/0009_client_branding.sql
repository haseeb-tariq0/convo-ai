-- Client-level branding defaults. Mirrors the per-dashboard brand_*
-- columns added in 0006_dashboard_branding, but at the CLIENT level so
-- the admin can set a default logo/name/colors once and have every new
-- dashboard inherit it. Per-dashboard values still override per-client.
--
-- Apply via the Supabase MCP `apply_migration` tool.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS brand_name           text,
  ADD COLUMN IF NOT EXISTS brand_logo_url       text,
  ADD COLUMN IF NOT EXISTS brand_primary_color  text,
  ADD COLUMN IF NOT EXISTS brand_accent_color   text;

NOTIFY pgrst, 'reload schema';
