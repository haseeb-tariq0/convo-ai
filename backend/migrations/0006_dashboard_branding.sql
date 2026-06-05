-- 0006_dashboard_branding.sql
-- Per-dashboard branding so each client's public view shows their own
-- logo / name / colors. Asked for in the May 20 meeting:
--   "the branding needs to match the whole nexa colors thing"
--   "[admin should be able to configure all of this]"
--
-- All four columns are nullable — null falls back to the editorial defaults
-- baked into the Tailwind theme, so existing dashboards keep working with
-- zero migration of their field_config.

alter table public.dashboards
  add column if not exists brand_name text,
  add column if not exists brand_logo_url text,
  add column if not exists brand_primary_color text,
  add column if not exists brand_accent_color text;
