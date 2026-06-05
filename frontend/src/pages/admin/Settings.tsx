import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { I } from '@/components/admin/icons'
import { admin } from '@/lib/api'

/**
 * Workspace Settings — read-only snapshot of how the backend is wired:
 * storage backend, scheduler health, mock toggles, AI defaults, and
 * workspace-wide counts.
 *
 * Settings here are deliberately READ-ONLY because they live in
 * backend/.env (changing them requires a restart). The page links out
 * to the relevant configuration surfaces (Supabase project, per-client
 * AI keys) so the admin can act on them without copying paths around.
 */
export default function Settings() {
  const sysQ = useQuery({
    queryKey: ['admin-system'],
    queryFn: () => admin.system(),
    refetchInterval: 15_000,  // keep counts live so a new chat row shows up
  })

  if (sysQ.isLoading) {
    return (
      <div className="page-content">
        <div className="page-title-row">
          <div>
            <h1 className="h1">Workspace settings</h1>
          </div>
        </div>
        <div className="empty"><div className="t">Loading…</div></div>
      </div>
    )
  }

  if (sysQ.isError || !sysQ.data) {
    return (
      <div className="page-content">
        <div className="page-title-row">
          <div>
            <h1 className="h1">Workspace settings</h1>
          </div>
        </div>
        <div className="empty">
          <div className="t" style={{ color: 'var(--neg)' }}>Failed to load</div>
          <div className="d">Check the backend is running on port 8000.</div>
        </div>
      </div>
    )
  }

  const sys = sysQ.data
  const isProduction = sys.app_env === 'production'

  return (
    <div className="page-content">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">
            <span>Workspace</span>
            <span className="sep">·</span>
            <span>System configuration</span>
          </div>
          <h1 className="h1">Workspace settings</h1>
          <p className="desc">
            Read-only view of the backend's runtime configuration. Changes
            require editing <span className="mono">backend/.env</span> and
            restarting the service.
          </p>
        </div>
        <div className="actions">
          <a
            className="ghost-btn"
            href="http://127.0.0.1:8000/docs"
            target="_blank"
            rel="noreferrer"
          >
            <I name="ext" />
            API docs
          </a>
        </div>
      </div>

      {/* Workspace counts strip */}
      <div className="stat-strip">
        <div>
          <div className="l">Clients</div>
          <div className="v">{sys.counts.clients}</div>
          <div className="d">
            <Link to="/admin" style={{ color: 'var(--fg-3)' }}>browse →</Link>
          </div>
        </div>
        <div>
          <div className="l">Dashboards</div>
          <div className="v">{sys.counts.dashboards}</div>
          <div className="d">
            <Link to="/admin/dashboards" style={{ color: 'var(--fg-3)' }}>browse →</Link>
          </div>
        </div>
        <div>
          <div className="l">Chat rows</div>
          <div className="v">{sys.counts.chat_rows.toLocaleString()}</div>
          <div className="d">ingested across all dashboards</div>
        </div>
        <div>
          <div className="l">Integrations</div>
          <div className="v">
            {sys.counts.ai_integrations + sys.counts.ga4_integrations}
          </div>
          <div className="d">
            {sys.counts.ai_integrations} AI · {sys.counts.ga4_integrations} GA4
          </div>
        </div>
      </div>

      <div
        // Equal-width 2-col grid. minmax(0, 1fr) is the standard trick to
        // stop grid items from overflowing — without it long values like
        // "live (openai)" or "every 30s [MOCK]" force the column wider
        // than 1fr and break the layout. NOT using `.two-col` because
        // that class is hard-coded to 1fr 320px for the FieldEditor.
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 16,
          marginTop: 16,
        }}
      >
        {/* Storage card */}
        <Card title="Storage">
          <KV
            label="Backend"
            value={
              <span className={'pill-status ' + (sys.storage.backend === 'supabase' ? 'active' : 'draft')}>
                <span className="ps-dot" />
                {sys.storage.backend}
              </span>
            }
          />
          {sys.storage.supabase_url && (
            <KV
              label="Supabase URL"
              value={
                <a
                  className="mono"
                  href={sys.storage.supabase_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: 'var(--accent)', textDecoration: 'none' }}
                >
                  {new URL(sys.storage.supabase_url).host}
                </a>
              }
            />
          )}
          <KV
            label="Encryption at rest"
            value={
              <span className={'pill-status ' + (sys.storage.encryption_configured ? 'active' : 'draft')}>
                <span className="ps-dot" />
                {sys.storage.encryption_configured ? 'Fernet configured' : 'not configured'}
              </span>
            }
          />
        </Card>

        {/* Scheduler card */}
        <Card title="Scheduler">
          <KV
            label="Status"
            value={
              <span className={'pill-status ' + (sys.scheduler.running ? 'active' : 'archived')}>
                <span className="ps-dot" />
                {sys.scheduler.running ? 'running' : 'stopped'}
              </span>
            }
          />
          <KV label="Sheets sync" value={<Cadence s={sys.scheduler.sheets_interval_seconds} mocked={sys.mocks.sheets} />} />
          <KV label="AI labels"  value={<Cadence s={sys.scheduler.ai_interval_seconds}     mocked={sys.mocks.ai} />} />
          <KV label="GA4 sync"   value={<Cadence s={sys.scheduler.ga4_interval_seconds}    mocked={sys.mocks.ga4} />} />
        </Card>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 16,
          marginTop: 16,
        }}
      >
        {/* AI defaults card */}
        <Card title="AI defaults" sub="platform fallback">
          <KV label="Provider" value={<span className="mono">{sys.ai_defaults.provider}</span>} />
          <KV
            label="OpenAI key"
            value={
              <span className={'pill-status ' + (sys.ai_defaults.openai_key_configured ? 'active' : 'archived')}>
                <span className="ps-dot" />
                {sys.ai_defaults.openai_key_configured ? 'configured' : 'not set'}
              </span>
            }
          />
          <KV label="OpenAI model" value={<span className="mono">{sys.ai_defaults.openai_model}</span>} />
          <KV
            label="Anthropic key"
            value={
              <span className={'pill-status ' + (sys.ai_defaults.anthropic_key_configured ? 'active' : 'archived')}>
                <span className="ps-dot" />
                {sys.ai_defaults.anthropic_key_configured ? 'configured' : 'not set'}
              </span>
            }
          />
          <KV label="Anthropic model" value={<span className="mono">{sys.ai_defaults.anthropic_model}</span>} />
          <div style={{ padding: '12px 18px', fontSize: 12.5, color: 'var(--fg-3)', borderTop: '1px solid var(--border-soft)' }}>
            Per-client keys override these defaults.{' '}
            <Link to="/admin" style={{ color: 'var(--accent)' }}>Configure per client →</Link>
          </div>
        </Card>

        {/* Integrations / mocks card */}
        <Card title="Integrations" sub="real vs mocked">
          <KV
            label="Google Sheets"
            value={
              <span className={'pill-status ' + (sys.mocks.sheets ? 'draft' : 'active')}>
                <span className="ps-dot" />
                {sys.mocks.sheets ? 'mocked' : 'live'}
              </span>
            }
          />
          <KV
            label="AI labelling"
            value={
              <span className={'pill-status ' + (sys.mocks.ai ? 'draft' : 'active')}>
                <span className="ps-dot" />
                {sys.mocks.ai ? 'mocked' : 'live (' + sys.ai_defaults.provider + ')'}
              </span>
            }
          />
          <KV
            label="GA4 Analytics"
            value={
              <span className={'pill-status ' + (sys.mocks.ga4 ? 'draft' : 'active')}>
                <span className="ps-dot" />
                {sys.mocks.ga4 ? 'mocked' : 'live'}
              </span>
            }
          />
          <div style={{ padding: '12px 18px', fontSize: 12.5, color: 'var(--fg-3)', borderTop: '1px solid var(--border-soft)' }}>
            Toggle in <span className="mono">backend/.env</span> · USE_MOCK_*. Requires restart.
          </div>
        </Card>
      </div>

      {/* Environment card */}
      <div style={{ marginTop: 16 }}>
        <Card title="Environment">
          <KV
            label="App env"
            value={
              <span className={'pill-status ' + (isProduction ? 'active' : 'draft')}>
                <span className="ps-dot" />
                {sys.app_env}
              </span>
            }
          />
          <KV label="Log level" value={<span className="mono">{sys.log_level}</span>} />
          <KV label="Frontend URL" value={<span className="mono">{sys.frontend_url}</span>} />
          <KV
            label="CORS allowed origins"
            value={
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {sys.cors_origins.map((o) => (
                  <span
                    key={o}
                    className="mono"
                    style={{
                      fontSize: 11.5,
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: 'var(--bg-muted)',
                      border: '1px solid var(--d-border)',
                      color: 'var(--fg-2)',
                    }}
                  >
                    {o}
                  </span>
                ))}
              </div>
            }
          />
        </Card>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Small presentational helpers — kept inline so the file is one screen.
// ─────────────────────────────────────────────────────────────────────

function Card({
  title,
  sub,
  children,
}: {
  title: string
  sub?: string
  children: React.ReactNode
}) {
  return (
    <div className="info-card">
      <div className="info-card-head">
        <span className="t">{title}</span>
        {sub && <span className="sub">{sub}</span>}
      </div>
      <div className="kv-list">{children}</div>
    </div>
  )
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="kv-row">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
    </div>
  )
}

function Cadence({ s, mocked }: { s: number; mocked: boolean }) {
  const label =
    s >= 3600 ? `every ${s / 3600}h` :
    s >= 60   ? `every ${s / 60}m` :
                `every ${s}s`
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        whiteSpace: 'nowrap',  // keep cadence + MOCK chip on one line
      }}
    >
      <span className="mono" style={{ color: 'var(--d-fg)' }}>{label}</span>
      {mocked && (
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: '.06em',
            textTransform: 'uppercase',
            color: 'var(--warn)',
            background: 'var(--warn-soft)',
            border: '1px solid color-mix(in srgb, var(--warn) 24%, transparent)',
            padding: '1px 6px',
            borderRadius: 3,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          mock
        </span>
      )}
    </span>
  )
}
