// Mirror of Pydantic schemas in backend/app/schemas/. Keep in lockstep.

export interface ClientOut {
  id: string
  name: string
  contact_email: string | null
  is_active: boolean
  // Client-level branding defaults — inherited by every dashboard that
  // doesn't override them. brand_logo_url accepts either an https://…
  // URL or an inline data: URI from the file uploader.
  brand_name: string | null
  brand_logo_url: string | null
  brand_primary_color: string | null
  brand_accent_color: string | null
  created_at: string
  updated_at: string
}

export interface DashboardOut {
  id: string
  client_id: string
  name: string
  share_token: string
  sheet_id: string | null
  sheet_tab_name: string
  sheet_column_map: Record<string, string>
  field_config: FieldConfig[]
  poll_interval_seconds: number
  is_active: boolean
  brand_name: string | null
  brand_logo_url: string | null
  brand_primary_color: string | null
  brand_accent_color: string | null
  layout_config: LayoutConfig | null
  created_at: string
  updated_at: string
}

// Per-dashboard magazine layout config: section order + visibility. Null →
// the full default magazine layout. `hiddenCards` lists card ids hidden
// within a section (e.g. 'escalation' inside the 'conversion' section).
export interface LayoutSectionConfig {
  id: string
  visible: boolean
  hiddenCards: string[]
}
// Per-magazine-card grid placement for the card-level Layout editor. When
// `blocks` is present the public page + editor position each magazine card
// (kpi, chart, gauge, revenue, …) from these coords; absent → the default
// magazine arrangement. `hidden` removes a card from the layout.
export interface BlockLayout {
  id: string
  x: number
  y: number
  w: number
  h: number
  hidden?: boolean
}
export interface LayoutConfig {
  sections: LayoutSectionConfig[]
  blocks?: BlockLayout[]
}

export interface SyncLogOut {
  id: string
  source: 'sheets' | 'ai' | 'ga4' | string
  status: 'success' | 'error' | string
  message: string
  rows_processed: number | null
  duration_ms: number | null
  occurred_at: string
}

export interface GA4ConfigOut {
  id: string
  client_id: string
  property_id: string
  conversion_event_name: string
  lookback_days: number
  sync_users: boolean
  sync_pageviews: boolean
  sync_events: boolean
  sync_conversions: boolean
  sync_traffic_sources: boolean
  sync_devices: boolean
  last_synced_at: string | null
}

// ---- per-client AI integration --------------------------------------------
// Mirrors backend/app/schemas/ai_integration.py. The plaintext API key only
// ever flows OUT-of-band (server-side encrypted at rest, never returned).
// The GET response gives back `api_key_masked` for display.

export type AIProvider = 'openai' | 'claude'

export interface AIIntegrationIn {
  provider: AIProvider
  api_key: string          // plaintext on the way in; server encrypts before storing
  model?: string | null    // optional override (e.g. "gpt-4o-mini")
  is_active?: boolean
}

export interface AIIntegrationOut {
  id: string
  client_id: string
  provider: AIProvider
  api_key_masked: string   // e.g. "sk-proj…AAAA" — NEVER the full key
  model: string | null
  is_active: boolean
  last_used_at: string | null
  created_at: string
  updated_at: string
}

export interface AITestResult {
  ok: boolean
  provider: AIProvider
  model: string
  latency_ms: number
  error: string | null
  sample_sentiment?: string | null
  sample_topics?: string[] | null
}

// ---- admin user management ------------------------------------------------
// Mirrors backend/app/schemas/admin_user.py. The Users page renders these.
// Plaintext email + role (`super_admin` | `admin`); avatars / names come
// from Supabase auth.users.user_metadata, enriched server-side.

export type AdminRole = 'super_admin' | 'admin'

export interface AdminUserIn {
  email: string
  role?: AdminRole
  notes?: string | null
}

export interface AdminUserUpdate {
  role?: AdminRole
  is_active?: boolean
  notes?: string | null
}

export interface AdminUserOut {
  id: string
  email: string
  role: AdminRole
  supabase_user_id: string | null
  invited_by_email: string | null
  invited_at: string
  last_signed_in_at: string | null
  is_active: boolean
  notes: string | null
  // Enriched display fields — null until the user signs in once.
  name: string | null
  avatar_url: string | null
  // "Currently online" — has a Supabase session active in the last hour.
  is_online: boolean
  created_at: string
  updated_at: string
}

export interface AdminMe {
  kind: 'user' | 'token' | null
  email: string | null
  role: AdminRole | null
  user_id: string | null
}

export interface AdminAuditLogEntry {
  id: string
  actor_email: string
  actor_role: string | null
  action: string         // dot-namespaced: client.create, dashboard.delete, …
  target_type: string | null
  target_id: string | null
  details: Record<string, unknown>
  occurred_at: string
}

// ---- workspace system info ------------------------------------------------
// Read-only snapshot of how the backend is configured at runtime. Powers
// the admin Settings page. Mirrors backend/app/schemas/system.py.

export interface SystemInfo {
  app_env: string
  log_level: string
  frontend_url: string
  cors_origins: string[]
  storage: {
    backend: 'supabase' | 'in-memory' | 'sqlalchemy' | string
    supabase_url: string
    encryption_configured: boolean
  }
  scheduler: {
    running: boolean
    sheets_interval_seconds: number
    ai_interval_seconds: number
    ga4_interval_seconds: number
  }
  mocks: {
    sheets: boolean
    ai: boolean
    ga4: boolean
  }
  ai_defaults: {
    provider: string
    openai_model: string
    openai_key_configured: boolean
    anthropic_model: string
    anthropic_key_configured: boolean
  }
  counts: {
    clients: number
    dashboards: number
    chat_rows: number
    ga4_integrations: number
    ai_integrations: number
  }
}

export type FieldType =
  | 'metric'
  | 'gauge'
  | 'line'
  | 'bar'
  | 'pie'
  | 'tag_cloud'
  | 'table'
  | 'map'
  | 'big_number'
  | 'donut'
  | 'funnel'
  | 'progress_bar'

/** Optional react-grid-layout coordinates carried alongside each widget.
 *  When present, the public dashboard positions the widget at (x, y) on
 *  a 12-column grid with size (w, h) in row units. When absent, a
 *  sensible default is generated per widget type. Saved as plain keys
 *  inside `field_config` (JSONB) — no schema migration needed. */
export interface FieldLayout {
  x: number
  y: number
  w: number
  h: number
  /** Lock layout for this widget (admin can still drag it, but the
   *  collision algorithm avoids displacing it). Optional. */
  static?: boolean
}

export interface FieldConfig {
  id: string
  type: FieldType | string
  label: string
  /** Grid placement on the dashboard. Optional — falls back to
   *  `defaultLayoutFor(type, idx)` when not set so old dashboards
   *  keep rendering. */
  layout?: FieldLayout
  // Discriminated union would be safer; staying loose matches the SPEC's
  // "JSONB array of field definitions" + "unknown types render as
  // 'Unsupported field type'" rule.
  [key: string]: unknown
}

export interface PublicDashboardConfig {
  /** Internal UUID — exposed publicly because (a) the share_token in
   *  the URL is no less sensitive and (b) the admin-only layout editor
   *  needs to call PATCH /api/admin/dashboards/{id} from the public
   *  view. Mutations still require the admin bearer. */
  id: string
  name: string
  field_config: FieldConfig[]
  last_updated_at: string | null
  brand_name: string | null
  brand_logo_url: string | null
  brand_primary_color: string | null
  brand_accent_color: string | null
  layout_config: LayoutConfig | null
}

export interface PublicFieldValue {
  id: string
  type: string
  label: string
  value: unknown
}

export interface PublicDashboardData {
  fields: PublicFieldValue[]
  generated_at: string
}

// ---- value shapes per field type (what `PublicFieldValue.value` looks like)

export interface MetricValue {
  value: number
  unit?: string
  sublabel?: string
  window_days?: number | null
  /** Same metric computed for the immediately-preceding window (if any).
   *  Powers the `▲ +N% vs prev Xd` line under each KPI in the public
   *  dashboard's KPI ribbon. Null when no previous-period data exists. */
  previous_value?: number | null
  /** Pre-computed percentage delta = (value - previous) / previous × 100.
   *  Null when the previous value is 0 (infinite growth — UI decides how
   *  to render). */
  delta_pct?: number | null
}

export interface GaugeValue {
  value: number
  min: number
  max: number
}

export interface LinePoint {
  x: string
  y: number
}
export interface LineValue {
  points: LinePoint[]
  /** Same line aggregation for the previous period (same length, shifted
   *  back). Powers the dashed comparison line on the volume chart. */
  previous_points?: LinePoint[]
}

export interface BarValue {
  bars: { label: string; value: number }[]
}

export interface PieSlice {
  label: string
  value: number
  pct: number
}
export interface PieValue {
  slices: PieSlice[]
}

export interface TagCloudValue {
  tags: { label: string; weight: number }[]
}

export interface TableValue {
  columns: string[]
  rows: Record<string, unknown>[]
}

export interface MapValue {
  // Embed mode — single Google Maps pin from a place query string.
  q?: string
  zoom?: number | null
  // Bubble mode — list of countries with values, plotted as scaled markers
  // on a world map (sourced from GA4 country snapshots).
  points?: { country: string; value: number }[]
  total?: number
}

export interface BigNumberValue {
  value: number
  unit?: string
  sublabel?: string
  window_days?: number | null
  previous_value?: number | null
  delta_pct?: number | null
  sparkline?: number[]
}

export interface DonutValue {
  slices: { label: string; value: number; pct: number }[]
  total: number
  center_label?: string
}

export interface FunnelStage {
  label: string
  value: number
  pct_of_top: number
}
export interface FunnelValue {
  stages: FunnelStage[]
}

export interface ProgressBarValue {
  value: number
  target: number
  unit?: string
  pct: number
  direction?: 'higher_is_better' | 'lower_is_better'
}

export interface ErrorValue {
  error: string
}
