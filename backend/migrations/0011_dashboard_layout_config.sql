-- 0011_dashboard_layout_config.sql
-- Per-dashboard layout config: section order + visibility for the public
-- "magazine" dashboard. Null/absent → the full default magazine layout.
alter table public.dashboards
  add column if not exists layout_config jsonb;
