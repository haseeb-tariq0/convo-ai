import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type CSSProperties } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import BrandLogo, { brandKeyFor, BRAND_PRESETS } from '@/components/admin/BrandLogo'
import { I } from '@/components/admin/icons'
import LogoUploader from '@/components/admin/LogoUploader'
import { confirm as confirmDialog } from '@/components/admin/useConfirm'
import { admin, ApiError } from '@/lib/api'
import type { AIIntegrationOut, AIProvider, AITestResult, DashboardOut } from '@/types'

type Tab = 'overview' | 'dashboards' | 'ga4' | 'ai' | 'branding' | 'activity'

type AccentStyle = CSSProperties & Record<`--${string}`, string>

function accentStyleFor(name: string): AccentStyle {
  const brand = brandKeyFor(name)
  const preset = BRAND_PRESETS[brand]
  return {
    '--accent': preset.primary,
    '--accent-soft': preset.primary + '14',
    '--accent-fg': preset.fg_on,
  }
}

export default function ClientDetail() {
  const { clientId } = useParams<{ clientId: string }>()
  const qc = useQueryClient()

  const clientQ = useQuery({
    queryKey: ['client', clientId],
    queryFn: () => admin.getClient(clientId!),
    enabled: !!clientId,
  })
  const dashboardsQ = useQuery({
    queryKey: ['client-dashboards', clientId],
    queryFn: () => admin.listDashboards(clientId!),
    enabled: !!clientId,
  })
  const ga4Q = useQuery({
    queryKey: ['client-ga4', clientId],
    queryFn: () => admin.getGA4(clientId!),
    enabled: !!clientId,
    retry: false,
  })
  // Per-client AI key (PUT/GET/DELETE /api/admin/clients/:id/ai). Returns
  // 404 when the client hasn't configured one — we treat that as "use
  // platform fallback" rather than an error, so retry: false.
  const aiQ = useQuery({
    queryKey: ['client-ai', clientId],
    queryFn: () => admin.getAI(clientId!),
    enabled: !!clientId,
    retry: false,
  })

  const [tab, setTab] = useState<Tab>('overview')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(false)
  const createMutation = useMutation({
    mutationFn: (name: string) =>
      admin.createDashboard(clientId!, {
        name,
        sheet_tab_name: 'Sheet1',
        sheet_column_map: {},
        field_config: [],
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client-dashboards', clientId] })
      setCreating(false)
    },
  })
  const editMutation = useMutation({
    mutationFn: (body: { name: string; contact_email: string | null; is_active: boolean }) =>
      admin.updateClient(clientId!, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client', clientId] })
      // Other views (client list, activity) read the same client — refresh them too.
      qc.invalidateQueries({ queryKey: ['admin-clients'] })
      setEditing(false)
    },
  })

  if (clientQ.isLoading) {
    return <div className="page-content" style={{ color: 'var(--fg-3)' }}>Loading…</div>
  }
  if (clientQ.isError || !clientQ.data) {
    return <div className="page-content" style={{ color: 'var(--neg)' }}>Client not found.</div>
  }

  const c = clientQ.data
  const brand = brandKeyFor(c.name)
  const dashboards = dashboardsQ.data ?? []
  const ga4 = ga4Q.data ?? null
  const accentStyle = accentStyleFor(c.name)

  return (
    <div className="page-content" style={accentStyle}>
      {/* Identity banner */}
      <div className="identity">
        <div className="stripe" />
        <div className="identity-body">
          <BrandLogo brand={brand} size="lg" />
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>
              <span>Client</span>
              <span className="sep">·</span>
              <span className="mono">{c.id.slice(0, 8)}…{c.id.slice(-4)}</span>
            </div>
            <h1 className="h1" style={{ fontSize: 24, marginBottom: 6 }}>{c.name}</h1>
            <div className="identity-meta">
              <span>
                <span className="lbl">Contact</span>
                <span className="v mono">{c.contact_email || '—'}</span>
              </span>
              <span>
                <span className="lbl">Status</span>
                <span className={'pill-status ' + (c.is_active ? 'active' : 'archived')}>
                  <span className="ps-dot" />
                  {c.is_active ? 'active' : 'archived'}
                </span>
              </span>
              <span>
                <span className="lbl">Created</span>
                <span className="v mono">
                  {new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
              </span>
              <span>
                <span className="lbl">Dashboards</span>
                <span className="v mono">{dashboards.length}</span>
              </span>
            </div>
          </div>
          <div className="identity-actions">
            {dashboards[0] && (
              <a className="ghost-btn" href={`/d/${dashboards[0].share_token}`} target="_blank" rel="noreferrer">
                <I name="ext" />
                Open public view
              </a>
            )}
            <button className="ghost-btn" onClick={() => setEditing(true)}>
              <I name="edit" />
              Edit
            </button>
            <button className="ghost-btn primary" onClick={() => setCreating(true)}>
              <I name="plus" />
              New dashboard
            </button>
          </div>
        </div>
        <div className="tabs">
          {(
            [
              ['overview', 'Overview'],
              ['dashboards', 'Dashboards', dashboards.length],
              ['ga4', 'GA4'],
              ['ai', 'AI key'],
              ['branding', 'Branding'],
              ['activity', 'Activity'],
            ] as [Tab, string, number?][]
          ).map(([id, label, ct]) => (
            <button key={id} className={'tab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>
              {label}
              {ct != null && <span className="ct">{ct}</span>}
            </button>
          ))}
        </div>
      </div>

      <div style={{ height: 24 }} />

      {creating && (
        <NewDashboardForm
          onCancel={() => setCreating(false)}
          onSubmit={(n) => createMutation.mutate(n)}
          busy={createMutation.isPending}
        />
      )}

      {editing && (
        <EditClientForm
          client={c}
          onCancel={() => setEditing(false)}
          onSubmit={(body) => editMutation.mutate(body)}
          busy={editMutation.isPending}
          error={editMutation.error instanceof Error ? editMutation.error.message : null}
        />
      )}

      {tab === 'overview' && (
        <OverviewTab dashboards={dashboards} ga4={ga4} setTab={setTab} clientId={c.id} />
      )}
      {tab === 'dashboards' && (
        <DashboardsTab clientId={c.id} dashboards={dashboards} onCreate={() => setCreating(true)} />
      )}
      {tab === 'ga4' && <GA4Tab ga4={ga4} clientId={c.id} onChange={() => ga4Q.refetch()} />}
      {tab === 'ai' && (
        <AITab
          clientId={c.id}
          integration={aiQ.data ?? null}
          isLoading={aiQ.isLoading}
          notFound={aiQ.isError && aiQ.error instanceof ApiError && aiQ.error.status === 404}
          onChange={() => aiQ.refetch()}
        />
      )}
      {tab === 'branding' && (
        <BrandingTab
          client={c}
          onSaved={() => clientQ.refetch()}
        />
      )}
      {tab === 'activity' && <ActivityTab />}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Overview tab
// ─────────────────────────────────────────────────────────────────────

function OverviewTab({
  dashboards,
  ga4,
  setTab,
  clientId,
}: {
  dashboards: DashboardOut[]
  ga4: { property_id: string; last_synced_at: string | null } | null
  setTab: (t: Tab) => void
  clientId: string
}) {
  const active = dashboards.filter((d) => d.is_active)
  return (
    <>
      <div className="stat-strip">
        <div>
          <div className="l">Dashboards</div>
          <div className="v num">{dashboards.length}</div>
          <div className="d">
            {active.length} active · {dashboards.length - active.length} archived
          </div>
        </div>
        <div>
          <div className="l">GA4</div>
          <div className="v" style={{ fontSize: 16, fontWeight: 600, paddingTop: 6 }}>
            {ga4 ? <span style={{ color: 'var(--pos)' }}>Connected</span> : <span style={{ color: 'var(--fg-3)' }}>Not configured</span>}
          </div>
          <div className="d">{ga4 ? `property ${ga4.property_id}` : 'Sheets only — no revenue yet'}</div>
        </div>
        <div>
          <div className="l">Last GA4 sync</div>
          <div className="v" style={{ fontSize: 18 }}>
            {ga4?.last_synced_at
              ? new Date(ga4.last_synced_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
              : '—'}
          </div>
          <div className="d">
            {ga4?.last_synced_at
              ? new Date(ga4.last_synced_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
              : 'no syncs yet'}
          </div>
        </div>
        <div>
          <div className="l">Share links</div>
          <div className="v num">{active.length}</div>
          <div className="d">live URLs · one per active dashboard</div>
        </div>
      </div>

      {/* Dashboards preview */}
      <div className="info-card" style={{ marginBottom: 16 }}>
        <div className="info-card-head">
          <span className="t">Dashboards</span>
          <span className="sub">{dashboards.length} total</span>
          <button className="ghost-btn" style={{ marginLeft: 'auto' }} onClick={() => setTab('dashboards')}>
            View all
            <I name="right" />
          </button>
        </div>
        {dashboards.length === 0 ? (
          <div style={{ padding: 32 }}>
            <div className="empty">
              <div className="t">No dashboards yet</div>
              <div className="d">Create one to start syncing chats from a Google Sheet.</div>
            </div>
          </div>
        ) : (
          <DashboardsTable dashboards={dashboards.slice(0, 5)} clientId={clientId} compact />
        )}
      </div>

      {/* GA4 nudge */}
      {!ga4 && (
        <div className="info-card" style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 14 }}>
          <span
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: 'var(--warn-soft)',
              color: 'var(--warn)',
              display: 'inline-grid',
              placeItems: 'center',
            }}
          >
            <I name="ga4" />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>Add GA4 to unlock revenue + traffic widgets</div>
            <div style={{ fontSize: 12.5, color: 'var(--fg-3)', marginTop: 2 }}>
              Paste the service-account JSON and we'll start pulling daily.
            </div>
          </div>
          <button className="ghost-btn primary" onClick={() => setTab('ga4')}>
            <I name="plus" />
            Configure GA4
          </button>
        </div>
      )}
    </>
  )
}

function DashboardsTable({
  dashboards,
  clientId,
  compact,
}: {
  dashboards: DashboardOut[]
  clientId: string
  compact?: boolean
}) {
  const navigate = useNavigate()
  return (
    <table className="activity-table">
      <thead>
        <tr>
          <th>Dashboard</th>
          <th>Sheet</th>
          <th>Widgets</th>
          <th>Poll</th>
          <th>Share link</th>
          {!compact && <th>Status</th>}
          <th></th>
        </tr>
      </thead>
      <tbody>
        {dashboards.map((d) => (
          <tr
            key={d.id}
            onClick={() => navigate(`/admin/dashboards/${d.id}`)}
            style={{ cursor: 'pointer' }}
          >
            <td>
              <div style={{ fontWeight: 500, color: 'var(--d-fg)' }}>{d.name}</div>
              <div className="ts" style={{ marginTop: 2 }}>poll · {d.poll_interval_seconds}s</div>
            </td>
            <td>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <I name="sheets" size={13} />
                <span className="ts">{d.sheet_id ? `${d.sheet_id.slice(0, 14)}…` : '—'} · {d.sheet_tab_name}</span>
              </div>
            </td>
            <td className="ts">{d.field_config.length}</td>
            <td className="ts">{d.poll_interval_seconds}s</td>
            <td className="ts">
              <span style={{ background: 'var(--bg-muted)', border: '1px solid var(--d-border)', borderRadius: 4, padding: '2px 7px', fontFamily: 'var(--d-font-mono)' }}>
                /d/{d.share_token.slice(0, 6)}…
              </span>
            </td>
            {!compact && (
              <td>
                <span className={'pill-status ' + (d.is_active ? 'active' : 'archived')}>
                  <span className="ps-dot" />
                  {d.is_active ? 'active' : 'archived'}
                </span>
              </td>
            )}
            <td className="actions-cell" onClick={(e) => e.stopPropagation()}>
              <a
                className="icon-btn"
                href={`/d/${d.share_token}`}
                target="_blank"
                rel="noreferrer"
              >
                <I name="ext" />
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
  void clientId
}

// ─────────────────────────────────────────────────────────────────────
// Dashboards tab
// ─────────────────────────────────────────────────────────────────────

function DashboardsTab({
  dashboards,
  clientId,
  onCreate,
}: {
  dashboards: DashboardOut[]
  clientId: string
  onCreate: () => void
}) {
  return (
    <div className="info-card">
      <div className="info-card-head">
        <span className="t">All dashboards</span>
        <span className="sub">{dashboards.length} total</span>
        <button className="ghost-btn primary" style={{ marginLeft: 'auto' }} onClick={onCreate}>
          <I name="plus" />
          New dashboard
        </button>
      </div>
      {dashboards.length === 0 ? (
        <div style={{ padding: 32 }}>
          <div className="empty">
            <div className="t">No dashboards yet</div>
            <div className="d">Create one to start syncing chats from a Google Sheet.</div>
            <button className="ghost-btn primary" onClick={onCreate}>
              <I name="plus" />
              New dashboard
            </button>
          </div>
        </div>
      ) : (
        <DashboardsTable dashboards={dashboards} clientId={clientId} />
      )}
    </div>
  )
}

function NewDashboardForm({
  onCancel,
  onSubmit,
  busy,
}: {
  onCancel: () => void
  onSubmit: (name: string) => void
  busy: boolean
}) {
  const [name, setName] = useState('')
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(name.trim())
      }}
      className="info-card"
      style={{ marginBottom: 18 }}
    >
      <div className="info-card-head">
        <span className="t">New dashboard</span>
        <button type="button" className="icon-btn" onClick={onCancel} style={{ marginLeft: 'auto' }}>
          <I name="x" />
        </button>
      </div>
      <div className="editor-body">
        <div className="form-row">
          <span className="l">Name</span>
          <input
            className="form-input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Nest — Guest Conversations"
          />
          <span className="help">You'll wire up the Sheet + widgets on the next page.</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="ghost-btn primary" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create dashboard'}
          </button>
          <button type="button" className="ghost-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  )
}

function EditClientForm({
  client,
  onCancel,
  onSubmit,
  busy,
  error,
}: {
  client: { name: string; contact_email: string | null; is_active: boolean }
  onCancel: () => void
  onSubmit: (body: { name: string; contact_email: string | null; is_active: boolean }) => void
  busy: boolean
  error: string | null
}) {
  const [name, setName] = useState(client.name)
  const [email, setEmail] = useState(client.contact_email ?? '')
  const [isActive, setIsActive] = useState(client.is_active)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({
          name: name.trim(),
          contact_email: email.trim() || null,
          is_active: isActive,
        })
      }}
      className="info-card"
      style={{ marginBottom: 18 }}
    >
      <div className="info-card-head">
        <span className="t">Edit client</span>
        <button type="button" className="icon-btn" onClick={onCancel} style={{ marginLeft: 'auto' }}>
          <I name="x" />
        </button>
      </div>
      <div className="editor-body">
        <div className="form-row">
          <span className="l">Name</span>
          <input
            className="form-input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Client name"
          />
        </div>
        <div className="form-row">
          <span className="l">Contact email</span>
          <input
            className="form-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ops@client.example"
          />
          <span className="help">Optional — leave blank to clear.</span>
        </div>
        <div className="form-row">
          <span className="l">Status</span>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            <span>{isActive ? 'Active' : 'Archived'}</span>
          </label>
        </div>
        {error && (
          <div style={{ color: 'var(--neg)', fontSize: 12.5 }}>{error}</div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="ghost-btn primary" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" className="ghost-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  )
}

// ─────────────────────────────────────────────────────────────────────
// GA4 tab
// ─────────────────────────────────────────────────────────────────────

function GA4Tab({
  ga4,
  clientId,
  onChange,
}: {
  ga4: {
    property_id: string
    conversion_event_name: string
    lookback_days: number
    last_synced_at: string | null
  } | null
  clientId: string
  onChange: () => void
}) {
  const [editing, setEditing] = useState(!ga4)
  const [propId, setPropId] = useState(ga4?.property_id ?? '')
  const [convEvent, setConvEvent] = useState(ga4?.conversion_event_name ?? 'purchase')
  const [lookback, setLookback] = useState(ga4?.lookback_days ?? 30)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      // No credentials_json — GA4 uses the global Nexa service account (set in
      // the backend env). Clients never touch the admin, so there's no per-
      // dashboard key to manage.
      const body: Record<string, unknown> = {
        property_id: propId.trim(),
        conversion_event_name: convEvent.trim() || 'purchase',
        lookback_days: Number(lookback) || 30,
      }
      await admin.upsertGA4(clientId, body)
      setEditing(false)
      onChange()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  if (!editing && ga4) {
    return (
      <div className="info-card">
        <div className="info-card-head">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                background: 'var(--warn-soft)',
                color: 'var(--warn)',
                display: 'inline-grid',
                placeItems: 'center',
              }}
            >
              <I name="ga4" size={14} />
            </span>
            <span className="t">GA4 integration</span>
          </span>
          <span className="pill-status active" style={{ marginLeft: 'auto' }}>
            <span className="ps-dot" />
            connected
          </span>
        </div>
        <div className="kv-list">
          <div className="kv-row">
            <div className="k">Property ID</div>
            <div className="v mono">{ga4.property_id}</div>
          </div>
          <div className="kv-row">
            <div className="k">Conversion event</div>
            <div className="v mono">{ga4.conversion_event_name}</div>
          </div>
          <div className="kv-row">
            <div className="k">Lookback window</div>
            <div className="v mono">{ga4.lookback_days} days</div>
          </div>
          <div className="kv-row">
            <div className="k">Last synced</div>
            <div className="v mono">
              {ga4.last_synced_at ? new Date(ga4.last_synced_at).toLocaleString() : 'never'}
            </div>
          </div>
        </div>
        <div style={{ padding: 16, borderTop: '1px solid var(--d-border)', display: 'flex', gap: 8 }}>
          <button
            className="ghost-btn primary"
            onClick={() => admin.syncGA4(clientId).then(onChange)}
          >
            <I name="refresh" />
            Sync now
          </button>
          <button className="ghost-btn" onClick={() => setEditing(true)}>
            <I name="edit" />
            Edit
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="info-card">
      <div className="info-card-head">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              background: 'var(--warn-soft)',
              color: 'var(--warn)',
              display: 'inline-grid',
              placeItems: 'center',
            }}
          >
            <I name="ga4" size={14} />
          </span>
          <span className="t">Configure GA4</span>
        </span>
      </div>
      <div className="editor-body">
        <div className="form-row">
          <span className="l">Property ID</span>
          <input
            className="form-input mono"
            placeholder="e.g. 123456789"
            value={propId}
            onChange={(e) => setPropId(e.target.value)}
          />
          <span className="help">Numeric ID, not the measurement ID (G-XXX). GA4 → Admin → Property Settings.</span>
        </div>
        <span className="help" style={{ display: 'block', marginTop: -4 }}>
          GA4 connects with the Nexa service account automatically — just add its
          email as a <strong>Viewer</strong> on the client’s GA4 property. No key to paste.
        </span>
        <div className="form-grid-2">
          <div className="form-row">
            <span className="l">Conversion event</span>
            <input
              className="form-input mono"
              value={convEvent}
              onChange={(e) => setConvEvent(e.target.value)}
            />
          </div>
          <div className="form-row">
            <span className="l">Lookback days</span>
            <input
              className="form-input mono"
              type="number"
              value={lookback}
              onChange={(e) => setLookback(Number(e.target.value))}
            />
          </div>
        </div>
        {err && <div style={{ color: 'var(--neg)', fontSize: 12.5 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, paddingTop: 6 }}>
          {ga4 && (
            <button type="button" className="ghost-btn" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="ghost-btn primary"
            disabled={busy || !propId.trim()}
            onClick={save}
            style={{ marginLeft: ga4 ? 'auto' : undefined }}
          >
            <I name="check" />
            {busy ? 'Saving…' : ga4 ? 'Save changes' : 'Connect GA4'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// AI key tab — per-client OpenAI/Claude credentials, encrypted at rest.
// Three render states:
//   1. Configured: status chip + masked key + Test/Edit/Delete actions.
//   2. Editing:    provider dropdown, password-style key input, model.
//   3. Not configured: "Using platform default" notice + Configure CTA.
// ─────────────────────────────────────────────────────────────────────

const PROVIDER_PRESETS: Record<AIProvider, { label: string; defaultModel: string; modelOptions: string[]; keyPlaceholder: string }> = {
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    modelOptions: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
    keyPlaceholder: 'sk-... or sk-proj-...',
  },
  claude: {
    label: 'Anthropic Claude',
    defaultModel: 'claude-haiku-4-5-20251001',
    modelOptions: [
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5-20251001',
      'claude-opus-4-5-20251001',
    ],
    keyPlaceholder: 'sk-ant-...',
  },
}

function AITab({
  clientId,
  integration,
  isLoading,
  notFound,
  onChange,
}: {
  clientId: string
  integration: AIIntegrationOut | null
  isLoading: boolean
  notFound: boolean
  onChange: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [provider, setProvider] = useState<AIProvider>(integration?.provider ?? 'openai')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(integration?.model ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<AITestResult | null>(null)

  async function save() {
    setBusy(true)
    setErr(null)
    setTestResult(null)
    try {
      if (!apiKey.trim()) {
        throw new Error('API key is required')
      }
      await admin.upsertAI(clientId, {
        provider,
        api_key: apiKey.trim(),
        model: model.trim() || null,
        is_active: true,
      })
      setApiKey('')   // never keep plaintext in state after save
      setEditing(false)
      onChange()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function runTest() {
    setBusy(true)
    setErr(null)
    setTestResult(null)
    try {
      const r = await admin.testAI(clientId)
      setTestResult(r)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Test failed')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: 'Remove this client\'s AI key?',
      message: 'Future labelling will fall back to the platform default OpenAI key (the cost will move back to your account). The encrypted key will be deleted from Supabase — to re-enable per-client billing you\'ll need to paste a fresh key.',
      confirmLabel: 'Remove key',
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      await admin.deleteAI(clientId)
      setEditing(false)
      onChange()
    } finally {
      setBusy(false)
    }
  }

  if (isLoading) {
    return (
      <div className="info-card">
        <div className="info-card-head"><span className="t">AI key</span></div>
        <div style={{ padding: 24, color: 'var(--fg-3)', fontSize: 13 }}>Loading…</div>
      </div>
    )
  }

  // Display mode — integration exists and we're not editing it.
  if (integration && !editing) {
    const last = integration.last_used_at
      ? new Date(integration.last_used_at).toLocaleString()
      : 'never'
    return (
      <div className="info-card">
        <div className="info-card-head">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 28, height: 28, borderRadius: 6,
                background: 'var(--accent-soft)', color: 'var(--accent)',
                display: 'inline-grid', placeItems: 'center',
                fontFamily: 'var(--d-font-mono)', fontSize: 11, fontWeight: 700,
              }}
            >
              AI
            </span>
            <span className="t">{PROVIDER_PRESETS[integration.provider].label}</span>
          </span>
          <span className="pill-status active" style={{ marginLeft: 'auto' }}>
            <span className="ps-dot" />
            configured
          </span>
        </div>
        <div className="kv-list">
          <div className="kv-row">
            <div className="k">Provider</div>
            <div className="v">{PROVIDER_PRESETS[integration.provider].label}</div>
          </div>
          <div className="kv-row">
            <div className="k">API key</div>
            <div className="v mono">{integration.api_key_masked}</div>
          </div>
          <div className="kv-row">
            <div className="k">Model</div>
            <div className="v mono">{integration.model || `(default · ${PROVIDER_PRESETS[integration.provider].defaultModel})`}</div>
          </div>
          <div className="kv-row">
            <div className="k">Last used</div>
            <div className="v mono">{last}</div>
          </div>
        </div>
        {testResult && (
          <div
            style={{
              margin: '0 16px 16px',
              padding: '10px 12px',
              borderRadius: 6,
              fontSize: 12.5,
              fontFamily: 'var(--d-font-mono)',
              background: testResult.ok ? 'var(--pos-soft)' : 'var(--neg-soft)',
              color: testResult.ok ? 'var(--pos)' : 'var(--neg)',
              border: '1px solid ' + (testResult.ok
                ? 'color-mix(in srgb, var(--pos) 24%, transparent)'
                : 'color-mix(in srgb, var(--neg) 24%, transparent)'),
            }}
          >
            {testResult.ok ? (
              <>
                ✓ Test passed · {testResult.latency_ms}ms · sample sentiment:{' '}
                <strong>{testResult.sample_sentiment}</strong> · topics:{' '}
                <strong>{(testResult.sample_topics ?? []).join(', ')}</strong>
              </>
            ) : (
              <>✗ Test failed: {testResult.error}</>
            )}
          </div>
        )}
        {err && (
          <div style={{ margin: '0 16px 16px', color: 'var(--neg)', fontSize: 12.5 }}>{err}</div>
        )}
        <div style={{ padding: 16, borderTop: '1px solid var(--d-border)', display: 'flex', gap: 8 }}>
          <button className="ghost-btn primary" onClick={runTest} disabled={busy}>
            <I name="ext" />
            {busy ? 'Testing…' : 'Test'}
          </button>
          <button className="ghost-btn" onClick={() => setEditing(true)} disabled={busy}>
            <I name="edit" />
            Rotate / edit
          </button>
          <button
            className="btn-danger"
            style={{ marginLeft: 'auto' }}
            onClick={remove}
            disabled={busy}
          >
            Remove
          </button>
        </div>
      </div>
    )
  }

  // Edit / first-time configure mode.
  const showFallbackNotice = notFound && !editing
  if (showFallbackNotice) {
    return (
      <div className="info-card">
        <div className="info-card-head">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 28, height: 28, borderRadius: 6,
                background: 'var(--bg-muted)', color: 'var(--fg-3)',
                display: 'inline-grid', placeItems: 'center',
                fontFamily: 'var(--d-font-mono)', fontSize: 11, fontWeight: 700,
              }}
            >
              AI
            </span>
            <span className="t">AI key</span>
          </span>
          <span className="pill-status archived" style={{ marginLeft: 'auto' }}>
            <span className="ps-dot" />
            using platform default
          </span>
        </div>
        <div style={{ padding: 24, fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.6 }}>
          <p style={{ marginTop: 0 }}>
            This client has no dedicated AI key. Sentiment / intent / topic
            labels are currently being generated using the <strong>platform
            default key</strong> from the backend's <span className="mono">.env</span> —
            <strong> the cost is billed to your platform account</strong>, not the client.
          </p>
          <p>
            Configure a per-client key below to bill OpenAI / Anthropic usage
            directly to this client. The key is stored encrypted at rest
            (Fernet) and never returned in plaintext.
          </p>
          <button className="ghost-btn primary" onClick={() => setEditing(true)} style={{ marginTop: 4 }}>
            <I name="plus" />
            Configure client key
          </button>
        </div>
      </div>
    )
  }

  const preset = PROVIDER_PRESETS[provider]
  return (
    <div className="info-card">
      <div className="info-card-head">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 28, height: 28, borderRadius: 6,
              background: 'var(--accent-soft)', color: 'var(--accent)',
              display: 'inline-grid', placeItems: 'center',
              fontFamily: 'var(--d-font-mono)', fontSize: 11, fontWeight: 700,
            }}
          >
            AI
          </span>
          <span className="t">
            {integration ? `Rotate ${preset.label} key` : `Configure ${preset.label}`}
          </span>
        </span>
        {integration && (
          <button
            className="ghost-btn"
            style={{ marginLeft: 'auto' }}
            onClick={() => { setEditing(false); setApiKey(''); setErr(null) }}
          >
            Cancel
          </button>
        )}
      </div>
      <div className="editor-body">
        <div className="form-grid-2">
          <div className="form-row">
            <span className="l">Provider</span>
            <select
              className="form-input"
              value={provider}
              onChange={(e) => {
                const next = e.target.value as AIProvider
                setProvider(next)
                // Clear the model if the user switches providers — gpt-4o-mini
                // wouldn't make sense as a Claude model and vice versa.
                if (integration?.provider !== next) setModel('')
              }}
            >
              <option value="openai">OpenAI</option>
              <option value="claude">Anthropic Claude</option>
            </select>
          </div>
          <div className="form-row">
            <span className="l">Model (optional)</span>
            <select
              className="form-input mono"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">(default · {preset.defaultModel})</option>
              {preset.modelOptions.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="form-row">
          <span className="l">
            API key
            {integration && (
              <span style={{ color: 'var(--fg-4)', textTransform: 'none' }}>
                {' '}— paste a new key to rotate
              </span>
            )}
          </span>
          <input
            type="password"
            className="form-input mono"
            placeholder={preset.keyPlaceholder}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="help">
            Stored encrypted at rest with Fernet — never returned plaintext.
            Get your key from {provider === 'openai'
              ? 'platform.openai.com → API keys'
              : 'console.anthropic.com → API keys'}.
          </span>
        </div>
        {err && (
          <div style={{ color: 'var(--neg)', fontSize: 12.5, fontFamily: 'var(--d-font-mono)' }}>
            {err}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="ghost-btn primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {!integration && (
            <button
              className="ghost-btn"
              onClick={() => setEditing(false)}
              disabled={busy}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Branding tab
// ─────────────────────────────────────────────────────────────────────

function BrandingTab({
  client,
  onSaved,
}: {
  client: import('@/types').ClientOut
  onSaved: () => void
}) {
  const brand = brandKeyFor(client.brand_name || client.name)
  const [brandName, setBrandName] = useState(client.brand_name ?? '')
  const [logoUrl, setLogoUrl] = useState(client.brand_logo_url ?? '')
  const [primary, setPrimary] = useState(client.brand_primary_color ?? '')
  const [accent, setAccent] = useState(client.brand_accent_color ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // Detect dirty state so the Save button only enables when there's
  // something to save (matches the GA4 tab UX).
  const dirty =
    brandName !== (client.brand_name ?? '') ||
    logoUrl !== (client.brand_logo_url ?? '') ||
    primary !== (client.brand_primary_color ?? '') ||
    accent !== (client.brand_accent_color ?? '')

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      await admin.updateClient(client.id, {
        brand_name: brandName.trim() || null,
        brand_logo_url: logoUrl.trim() || null,
        brand_primary_color: primary.trim() || null,
        brand_accent_color: accent.trim() || null,
      })
      setSavedAt(Date.now())
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="info-card">
      <div className="info-card-head">
        <span className="t">Client branding</span>
        <span className="sub">defaults inherited by every dashboard for this client</span>
      </div>
      <div className="editor-body">
        <div className="form-row">
          <span className="l">Default logo</span>
          <LogoUploader
            value={logoUrl}
            onChange={setLogoUrl}
            fallbackPreview={<BrandLogo brand={brand} size="lg" />}
            helpText={
              <>
                Used as the fallback logo on any dashboard that hasn't
                set its own. Per-dashboard branding overrides this.
              </>
            }
          />
        </div>

        <div className="form-row">
          <span className="l">Brand name</span>
          <input
            className="form-input"
            placeholder={client.name}
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
          />
          <span className="help">
            Shown next to the logo on the public dashboard header.
            Leave blank to use the client name ({client.name}).
          </span>
        </div>

        <div className="form-grid-2">
          <div className="form-row">
            <span className="l">Primary color</span>
            <div className="color-input-row">
              <input
                type="color"
                className="swatch"
                value={primary || '#1e293b'}
                onChange={(e) => setPrimary(e.target.value)}
              />
              <input
                className="form-input hex mono"
                placeholder="#1e293b"
                value={primary}
                onChange={(e) => setPrimary(e.target.value)}
              />
            </div>
          </div>
          <div className="form-row">
            <span className="l">Accent color</span>
            <div className="color-input-row">
              <input
                type="color"
                className="swatch"
                value={accent || '#f59e0b'}
                onChange={(e) => setAccent(e.target.value)}
              />
              <input
                className="form-input hex mono"
                placeholder="#f59e0b"
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
              />
            </div>
          </div>
        </div>

        {err && (
          <div style={{ color: 'var(--neg)', fontSize: 12.5, fontFamily: 'var(--d-font-mono)' }}>
            {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="ghost-btn primary"
            onClick={save}
            disabled={busy || !dirty}
          >
            {busy ? 'Saving…' : dirty ? 'Save branding' : 'Saved'}
          </button>
          {savedAt && !dirty && (
            <span style={{ fontSize: 12, color: 'var(--pos)', fontFamily: 'var(--d-font-mono)' }}>
              ✓ Saved {new Date(savedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Activity tab — placeholder
// ─────────────────────────────────────────────────────────────────────

function ActivityTab() {
  return (
    <div className="info-card" style={{ padding: 18, color: 'var(--fg-3)', fontSize: 13 }}>
      Activity history for this client lands in the next iteration. For now,
      open any dashboard's <strong style={{ color: 'var(--d-fg)' }}>Settings</strong> tab to see its recent sync log.
    </div>
  )
}
