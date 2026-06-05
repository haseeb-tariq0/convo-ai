-- 0001_initial.sql
-- Convo AI initial schema. Mirrors SPEC §5 and the in-memory shape in
-- app/store.py one-for-one so the swap is mechanical.
--
-- Apply this via the Supabase MCP `apply_migration` tool, NOT via psql
-- against the prod project — that's the Momentum convention from
-- CLAUDE.md and we're keeping it for Convo AI too.

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------------
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_email text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- dashboards
-- ---------------------------------------------------------------------------
create table public.dashboards (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null,
  share_token text not null unique,
  sheet_id text,
  sheet_tab_name text not null default 'Sheet1',
  sheet_column_map jsonb not null default '{}'::jsonb,
  field_config jsonb not null default '[]'::jsonb,
  poll_interval_seconds int not null default 30,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index dashboards_client_id_idx     on public.dashboards (client_id);
create index dashboards_share_token_idx   on public.dashboards (share_token);

-- ---------------------------------------------------------------------------
-- chat_rows — cached raw + AI-processed chat data
-- ---------------------------------------------------------------------------
create table public.chat_rows (
  id uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references public.dashboards(id) on delete cascade,
  source_row_index int not null,
  raw jsonb not null,
  ai_sentiment text,
  ai_sentiment_score double precision,
  ai_topics jsonb not null default '[]'::jsonb,
  ai_intent text,
  ai_processed_at timestamptz,
  occurred_at timestamptz,
  unique (dashboard_id, source_row_index)
);
create index chat_rows_dashboard_time_idx
  on public.chat_rows (dashboard_id, occurred_at desc);
-- Partial index so the AI processor's "find unprocessed rows" query is
-- O(unprocessed) instead of O(total rows).
create index chat_rows_unprocessed_idx
  on public.chat_rows (dashboard_id)
  where ai_processed_at is null;

-- ---------------------------------------------------------------------------
-- ga4_integrations
-- ---------------------------------------------------------------------------
create table public.ga4_integrations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references public.clients(id) on delete cascade,
  property_id text not null,
  credentials_json text not null,
  conversion_event_name text not null default 'purchase',
  lookback_days int not null default 30,
  sync_users boolean not null default true,
  sync_pageviews boolean not null default true,
  sync_events boolean not null default false,
  sync_conversions boolean not null default true,
  sync_traffic_sources boolean not null default true,
  sync_devices boolean not null default true,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- ga4_snapshots — one row per (integration, metric_type, date)
-- ---------------------------------------------------------------------------
create table public.ga4_snapshots (
  id uuid primary key default gen_random_uuid(),
  ga4_integration_id uuid not null references public.ga4_integrations(id) on delete cascade,
  metric_type text not null,
  date date not null,
  data jsonb not null,
  unique (ga4_integration_id, metric_type, date)
);
create index ga4_snapshots_integration_date_idx
  on public.ga4_snapshots (ga4_integration_id, date desc);

-- ---------------------------------------------------------------------------
-- sync_logs
-- ---------------------------------------------------------------------------
create table public.sync_logs (
  id uuid primary key default gen_random_uuid(),
  dashboard_id uuid references public.dashboards(id) on delete set null,
  ga4_integration_id uuid references public.ga4_integrations(id) on delete set null,
  source text not null,    -- sheets | ga4 | ai
  status text not null,    -- success | error
  message text not null default '',
  rows_processed int,
  duration_ms int,
  occurred_at timestamptz not null default now()
);
create index sync_logs_dashboard_time_idx on public.sync_logs (dashboard_id, occurred_at desc);
create index sync_logs_time_idx           on public.sync_logs (occurred_at desc);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger clients_set_updated_at
  before update on public.clients
  for each row execute function public.tg_set_updated_at();

create trigger dashboards_set_updated_at
  before update on public.dashboards
  for each row execute function public.tg_set_updated_at();

create trigger ga4_integrations_set_updated_at
  before update on public.ga4_integrations
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — on, but no policies. The FastAPI server uses the service-role key,
-- which bypasses RLS. The anon/publishable key is NEVER used by Convo AI
-- code paths (public dashboards are served by FastAPI, not via PostgREST
-- directly), so locking everything down behind RLS is the right default.
-- If we ever do client-side Supabase access, write per-table policies here.
-- ---------------------------------------------------------------------------
alter table public.clients          enable row level security;
alter table public.dashboards       enable row level security;
alter table public.chat_rows        enable row level security;
alter table public.ga4_integrations enable row level security;
alter table public.ga4_snapshots    enable row level security;
alter table public.sync_logs        enable row level security;
