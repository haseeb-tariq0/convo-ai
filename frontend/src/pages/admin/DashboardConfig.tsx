import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type CSSProperties } from 'react'
import { Link, useParams } from 'react-router-dom'

import BrandLogo, { brandKeyFor, BRAND_PRESETS } from '@/components/admin/BrandLogo'
import FieldEditor from '@/components/admin/FieldEditor'
import { I } from '@/components/admin/icons'
import LogoUploader from '@/components/admin/LogoUploader'
import { confirm as confirmDialog } from '@/components/admin/useConfirm'
import FieldRenderer from '@/components/charts/FieldRenderer'
import DashboardGrid from '@/components/public/DashboardGrid'
import { admin, publicApi } from '@/lib/api'
import type { DashboardOut, FieldConfig, FieldLayout, LayoutConfig, LayoutSectionConfig, PublicFieldValue, SyncLogOut } from '@/types'

type Tab = 'source' | 'fields' | 'layout' | 'builder' | 'branding' | 'settings'

type AccentStyle = CSSProperties & Record<`--${string}`, string>

function accentStyleFor(primary: string | null, accent: string | null, fallback: string): AccentStyle {
  const p = primary || fallback
  const a = accent || p
  return {
    '--accent': p,
    '--accent-soft': p + '14',
    '--accent-fg': '#ffffff',
    // accent-color used for native form controls (selects, color picker)
    accentColor: a,
  }
}

// Common semantic columns shown as dropdowns in the Source tab — replaces
// the legacy JSONB columnMap blob with a labelled dropdown per row.
const SEMANTIC_COLUMNS: { key: string; label: string; required?: boolean; type: string }[] = [
  { key: 'timestamp',  label: 'timestamp', type: 'datetime' },
  { key: 'message',    label: 'message',   required: true, type: 'string' },
  { key: 'channel',    label: 'channel',   type: 'string' },
  { key: 'user_id',    label: 'user_id',   type: 'string' },
  { key: 'language',   label: 'language',  type: 'string' },
  { key: 'country',    label: 'country',   type: 'string' },
]
const COLUMN_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P']

export default function DashboardConfig() {
  const { dashboardId } = useParams<{ dashboardId: string }>()
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: ['dashboard', dashboardId],
    queryFn: () => admin.getDashboard(dashboardId!),
    enabled: !!dashboardId,
  })
  const logsQ = useQuery({
    queryKey: ['dashboard-logs', dashboardId],
    queryFn: () => admin.recentLogs(dashboardId!, 25),
    enabled: !!dashboardId,
    refetchInterval: 10_000,
  })

  if (q.isLoading) return <div className="page-content" style={{ color: 'var(--fg-3)' }}>Loading dashboard…</div>
  if (q.isError || !q.data) return <div className="page-content" style={{ color: 'var(--neg)' }}>Dashboard not found.</div>

  return (
    <Editor
      dashboard={q.data}
      logs={logsQ.data ?? []}
      reload={() => qc.invalidateQueries({ queryKey: ['dashboard', dashboardId] })}
    />
  )
}

function Editor({
  dashboard,
  logs,
  reload,
}: {
  dashboard: DashboardOut
  logs: SyncLogOut[]
  reload: () => void
}) {
  const [tab, setTab] = useState<Tab>('source')
  const [name, setName] = useState(dashboard.name)
  const [sheetId, setSheetId] = useState(dashboard.sheet_id ?? '')
  const [sheetTab, setSheetTab] = useState(dashboard.sheet_tab_name)
  const [columnMap, setColumnMap] = useState<Record<string, string>>(dashboard.sheet_column_map)
  const [fieldConfig, setFieldConfig] = useState<FieldConfig[]>(dashboard.field_config)
  const [pollInterval, setPollInterval] = useState(dashboard.poll_interval_seconds)
  const [isActive, setIsActive] = useState(dashboard.is_active)

  const [brandName, setBrandName] = useState(dashboard.brand_name ?? '')
  const [brandLogoUrl, setBrandLogoUrl] = useState(dashboard.brand_logo_url ?? '')
  const fallbackBrand = BRAND_PRESETS[brandKeyFor(dashboard.name)].primary
  const [brandPrimary, setBrandPrimary] = useState(dashboard.brand_primary_color ?? fallbackBrand)
  const [brandAccent, setBrandAccent] = useState(dashboard.brand_accent_color ?? fallbackBrand)
  const [layoutConfig, setLayoutConfig] = useState<LayoutConfig | null>(dashboard.layout_config)

  const [copied, setCopied] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Reseed when the dashboard reloads (after save / token rotate).
  useEffect(() => {
    setName(dashboard.name)
    setSheetId(dashboard.sheet_id ?? '')
    setSheetTab(dashboard.sheet_tab_name)
    setColumnMap(dashboard.sheet_column_map)
    setFieldConfig(dashboard.field_config)
    setPollInterval(dashboard.poll_interval_seconds)
    setIsActive(dashboard.is_active)
    setBrandName(dashboard.brand_name ?? '')
    setBrandLogoUrl(dashboard.brand_logo_url ?? '')
    setBrandPrimary(dashboard.brand_primary_color ?? BRAND_PRESETS[brandKeyFor(dashboard.name)].primary)
    setBrandAccent(dashboard.brand_accent_color ?? BRAND_PRESETS[brandKeyFor(dashboard.name)].primary)
    setLayoutConfig(dashboard.layout_config)
  }, [dashboard.id, dashboard.updated_at])

  const save = useMutation({
    mutationFn: () =>
      admin.updateDashboard(dashboard.id, {
        name,
        sheet_id: sheetId.trim() || null,
        sheet_tab_name: sheetTab,
        sheet_column_map: columnMap,
        field_config: fieldConfig,
        poll_interval_seconds: pollInterval,
        is_active: isActive,
        brand_name: brandName.trim() || null,
        brand_logo_url: brandLogoUrl.trim() || null,
        brand_primary_color: brandPrimary || null,
        brand_accent_color: brandAccent || null,
        layout_config: layoutConfig,
      }),
    onSuccess: () => {
      setSavedAt(new Date().toLocaleTimeString())
      setSaveError(null)
      reload()
    },
    onError: (e) => setSaveError(e instanceof Error ? e.message : 'Save failed'),
  })

  const sync = useMutation({
    mutationFn: () => admin.manualSync(dashboard.id),
    onSuccess: () => reload(),
  })

  const rotate = useMutation({
    mutationFn: () => admin.rotateToken(dashboard.id),
    onSuccess: () => reload(),
  })

  const remove = useMutation({
    mutationFn: () => admin.deleteDashboard(dashboard.id),
    onSuccess: () => {
      window.location.href = `/admin/clients/${dashboard.client_id}`
    },
  })

  const accentStyle = accentStyleFor(brandPrimary, brandAccent, fallbackBrand)
  const brand = brandKeyFor(brandName || dashboard.name)
  const shareLink = `${window.location.origin}/d/${dashboard.share_token}`

  const copyShare = () => {
    navigator.clipboard?.writeText(shareLink)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="page-content" style={accentStyle}>
      {/* Identity banner */}
      <div className="identity">
        <div className="stripe" />
        <div className="identity-body">
          {brandLogoUrl ? (
            <span className="brand-logo size-lg">
              <img src={brandLogoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            </span>
          ) : (
            <BrandLogo brand={brand} size="lg" />
          )}
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>
              <Link to={`/admin/clients/${dashboard.client_id}`}>Client</Link>
              <span className="sep">·</span>
              <span>Dashboard config</span>
              <span className="sep">·</span>
              <span className="mono">{dashboard.id.slice(0, 8)}…{dashboard.id.slice(-4)}</span>
            </div>
            <h1 className="h1" style={{ fontSize: 24, marginBottom: 6 }}>{name}</h1>
            <div className="identity-meta">
              <span>
                <span className="lbl">Status</span>
                <span className={'pill-status ' + (isActive ? 'active' : 'archived')}>
                  <span className="ps-dot" />
                  {isActive ? 'active' : 'archived'}
                </span>
              </span>
              <span>
                <span className="lbl">Poll interval</span>
                <span className="v mono">{pollInterval}s</span>
              </span>
              <span>
                <span className="lbl">Widgets</span>
                <span className="v mono">{fieldConfig.length}</span>
              </span>
              <span>
                <span className="lbl">Updated</span>
                <span className="v mono">{new Date(dashboard.updated_at).toLocaleString()}</span>
              </span>
            </div>
          </div>
          <div className="identity-actions">
            <button className="ghost-btn" onClick={copyShare}>
              <I name={copied ? 'check' : 'copy'} />
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <a className="ghost-btn" href={`/d/${dashboard.share_token}`} target="_blank" rel="noreferrer">
              <I name="ext" />
              Open public view
            </a>
            <button className="ghost-btn primary" onClick={() => save.mutate()} disabled={save.isPending}>
              <I name="check" />
              {save.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
        <div className="tabs">
          {(
            [
              ['source', 'Source'],
              ['fields', 'Fields', fieldConfig.length],
              ['layout', 'Layout'],
              ['builder', 'Builder'],
              ['branding', 'Branding'],
              ['settings', 'Settings'],
            ] as [Tab, string, number?][]
          ).map(([id, label, ct]) => (
            <button key={id} className={'tab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>
              {label}
              {ct != null && <span className="ct">{ct}</span>}
            </button>
          ))}
        </div>
      </div>

      <div style={{ height: 20 }} />

      {/* Save toast */}
      {(savedAt || saveError) && (
        <div
          className="info-card"
          style={{
            padding: '10px 16px',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: saveError ? 'var(--neg)' : 'var(--pos)',
            fontSize: 12.5,
            background: saveError ? 'var(--neg-soft)' : 'var(--pos-soft)',
            borderColor: saveError
              ? 'color-mix(in srgb, var(--neg) 30%, transparent)'
              : 'color-mix(in srgb, var(--pos) 30%, transparent)',
          }}
        >
          <I name={saveError ? 'alert' : 'check'} />
          {saveError || `Saved at ${savedAt}`}
        </div>
      )}

      {/* Share link strip — always visible at top of body */}
      <div className="share-card" style={{ marginBottom: 16 }}>
        <div className="url-display">
          <I name="ext" size={13} />
          <span className="scheme">{window.location.origin.replace(/^https?:/, '')}</span>
          <span>/d/</span>
          <span className="tok">{dashboard.share_token}</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="ghost-btn" onClick={copyShare}>
            <I name={copied ? 'check' : 'copy'} />
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            className="ghost-btn"
            onClick={async () => {
              const ok = await confirmDialog({
                title: 'Rotate the share link?',
                message: 'The old link will stop working immediately. Anyone using it will see a 404.',
                confirmLabel: 'Rotate',
              })
              if (ok) rotate.mutate()
            }}
            disabled={rotate.isPending}
          >
            <I name="refresh" />
            {rotate.isPending ? 'Rotating…' : 'Rotate token'}
          </button>
          <a className="ghost-btn" href={`/d/${dashboard.share_token}`} target="_blank" rel="noreferrer">
            <I name="ext" />
            Open
          </a>
        </div>
      </div>

      {tab === 'source' && (
        <SourceTab
          name={name}
          setName={setName}
          sheetId={sheetId}
          setSheetId={setSheetId}
          sheetTab={sheetTab}
          setSheetTab={setSheetTab}
          columnMap={columnMap}
          setColumnMap={setColumnMap}
        />
      )}
      {tab === 'fields' && <FieldEditor fields={fieldConfig} onChange={setFieldConfig} />}
      {tab === 'layout' && (
        <LayoutTab layoutConfig={layoutConfig} setLayoutConfig={setLayoutConfig} />
      )}
      {tab === 'builder' && (
        <BuilderTab
          fieldConfig={fieldConfig}
          setFieldConfig={setFieldConfig}
          shareToken={dashboard.share_token}
        />
      )}
      {tab === 'branding' && (
        <BrandingTab
          brandName={brandName}
          setBrandName={setBrandName}
          brandLogoUrl={brandLogoUrl}
          setBrandLogoUrl={setBrandLogoUrl}
          brandPrimary={brandPrimary}
          setBrandPrimary={setBrandPrimary}
          brandAccent={brandAccent}
          setBrandAccent={setBrandAccent}
          dashboardName={dashboard.name}
          brandKey={brand}
        />
      )}
      {tab === 'settings' && (
        <SettingsTab
          pollInterval={pollInterval}
          setPollInterval={setPollInterval}
          isActive={isActive}
          setIsActive={setIsActive}
          logs={logs}
          onSync={() => sync.mutate()}
          syncing={sync.isPending}
          onDelete={async () => {
            const ok = await confirmDialog({
              title: `Delete "${dashboard.name}"?`,
              message: 'The share link, field config, and every chat row associated with this dashboard will be permanently removed. This cannot be undone.',
              confirmLabel: 'Delete dashboard',
              danger: true,
            })
            if (ok) remove.mutate()
          }}
          removing={remove.isPending}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────
// Layout tab — magazine layout editor. Reorder the public dashboard's
// sections and show/hide whole sections or individual cards. Persisted in
// the dashboard's layout_config and rendered by the public page. The
// existing "Save changes" button saves it.
// ─────────────────────────────────────────────────────────────────────

type SectionMeta = { id: string; title: string; cards: { id: string; label: string }[] }
const MAGAZINE_SECTIONS: SectionMeta[] = [
  { id: 'volume', title: 'Volume — KPIs + chart', cards: [
    { id: 'kpi', label: 'KPI ribbon' }, { id: 'chart', label: 'Conversations chart' }] },
  { id: 'conversion', title: 'Conversion & resolution', cards: [
    { id: 'gauge', label: 'Sentiment gauge' }, { id: 'revenue', label: 'Booking revenue' }, { id: 'escalation', label: 'Human escalations' }] },
  { id: 'intent', title: 'What guests ask about', cards: [
    { id: 'intent', label: 'Conversation intent' }, { id: 'topics', label: 'Top topics' }] },
  { id: 'geography', title: 'Geography & languages', cards: [
    { id: 'map', label: 'Map' }, { id: 'languages', label: 'Languages' }, { id: 'countries', label: 'Countries' }] },
  { id: 'recent', title: 'Live conversation stream', cards: [
    { id: 'table', label: 'Recent conversations' }] },
  { id: 'custom', title: 'Custom widgets', cards: [
    { id: 'custom', label: 'Custom widgets' }] },
]

function defaultSections(): LayoutSectionConfig[] {
  return MAGAZINE_SECTIONS.map((m) => ({ id: m.id, visible: true, hiddenCards: [] }))
}

function LayoutTab({
  layoutConfig,
  setLayoutConfig,
}: {
  layoutConfig: LayoutConfig | null
  setLayoutConfig: (c: LayoutConfig) => void
}) {
  // Normalize: saved order (known sections only), then append any known
  // sections missing from the config (forward-compat), all visible.
  const saved = (layoutConfig?.sections ?? []).filter((s) =>
    MAGAZINE_SECTIONS.some((m) => m.id === s.id),
  )
  const savedIds = new Set(saved.map((s) => s.id))
  const ordered: LayoutSectionConfig[] = [
    ...saved,
    ...MAGAZINE_SECTIONS.filter((m) => !savedIds.has(m.id)).map((m) => ({
      id: m.id, visible: true, hiddenCards: [] as string[],
    })),
  ]
  const meta = (id: string) => MAGAZINE_SECTIONS.find((m) => m.id === id)!
  const commit = (next: LayoutSectionConfig[]) => setLayoutConfig({ sections: next })

  function toggleSection(idx: number) {
    commit(ordered.map((s, i) => (i === idx ? { ...s, visible: !s.visible } : s)))
  }
  function move(idx: number, delta: -1 | 1) {
    const t = idx + delta
    if (t < 0 || t >= ordered.length) return
    const next = [...ordered]
    const [item] = next.splice(idx, 1)
    next.splice(t, 0, item)
    commit(next)
  }
  function toggleCard(idx: number, cardId: string) {
    commit(
      ordered.map((s, i) => {
        if (i !== idx) return s
        const hidden = s.hiddenCards.includes(cardId)
        return {
          ...s,
          hiddenCards: hidden
            ? s.hiddenCards.filter((c) => c !== cardId)
            : [...s.hiddenCards, cardId],
        }
      }),
    )
  }

  return (
    <div className="info-card" style={{ padding: 0 }}>
      <div className="info-card-head" style={{ padding: '14px 18px' }}>
        <span className="t">Layout</span>
        <span className="sub">
          Reorder sections and show/hide sections or individual cards · Save changes to publish
        </span>
        <button className="ghost-btn" onClick={() => commit(defaultSections())} style={{ marginLeft: 'auto' }}>
          <I name="refresh" />
          Reset
        </button>
      </div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {ordered.map((s, idx) => {
          const m = meta(s.id)
          return (
            <div key={s.id} className="info-card" style={{ padding: 12, opacity: s.visible ? 1 : 0.55 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 500 }}>
                  <input type="checkbox" checked={s.visible} onChange={() => toggleSection(idx)} />
                  {m.title}
                </label>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  <button className="ghost-btn" disabled={idx === 0} onClick={() => move(idx, -1)} style={{ padding: '2px 9px' }} title="Move up">↑</button>
                  <button className="ghost-btn" disabled={idx === ordered.length - 1} onClick={() => move(idx, 1)} style={{ padding: '2px 9px' }} title="Move down">↓</button>
                </div>
              </div>
              {m.cards.length > 1 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 10, paddingLeft: 26 }}>
                  {m.cards.map((c) => (
                    <label key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--fg-3)', cursor: s.visible ? 'pointer' : 'default' }}>
                      <input type="checkbox" checked={!s.hiddenCards.includes(c.id)} disabled={!s.visible} onChange={() => toggleCard(idx, c.id)} />
                      {c.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>
          Changes publish to the public dashboard when you click <strong>Save changes</strong> at the top.
        </div>
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────
// Builder tab — freeform widget canvas. Drag to move, drag the corner to
// resize, click/shift-click or marquee to multi-select, ✕/Delete to remove,
// ⧉/Ctrl+D to duplicate. Edits the dashboard's field_config layouts; the
// existing "Save changes" button persists it. Live widget values are pulled
// from the public data endpoint so the canvas shows real charts, not boxes.
// ─────────────────────────────────────────────────────────────────────

function BuilderTab({
  fieldConfig,
  setFieldConfig,
  shareToken,
}: {
  fieldConfig: FieldConfig[]
  setFieldConfig: (f: FieldConfig[]) => void
  shareToken: string
}) {
  const dataQ = useQuery({
    queryKey: ['builder-data', shareToken],
    queryFn: () => publicApi.data(shareToken),
    staleTime: 60_000,
  })

  // One PublicFieldValue per configured widget so EVERY widget renders on the
  // canvas (including freshly-duplicated ones the backend hasn't returned data
  // for yet). Real value when the data endpoint has it, else null → placeholder.
  const valById = new Map((dataQ.data?.fields ?? []).map((f) => [f.id, f.value]))
  const fields: PublicFieldValue[] = fieldConfig.map((c) => ({
    id: c.id,
    type: String(c.type),
    label: c.label,
    value: valById.get(c.id) ?? null,
  }))

  // Null value → lightweight placeholder (avoids the chart components reading
  // into a missing value); otherwise the real widget.
  const renderWidget = (f: PublicFieldValue) =>
    f.value == null ? (
      <section className="ux-card p-5 h-full flex flex-col">
        <div className="ux-label">{f.label}</div>
        <div className="mt-2 text-sm text-muted italic">{f.type}</div>
      </section>
    ) : (
      <FieldRenderer field={f} />
    )

  function onLayoutChange(layouts: Record<string, FieldLayout>) {
    setFieldConfig(
      fieldConfig.map((c) => (layouts[c.id] ? { ...c, layout: layouts[c.id] } : c)),
    )
  }
  function onDeleteWidgets(ids: string[]) {
    const drop = new Set(ids)
    setFieldConfig(fieldConfig.filter((c) => !drop.has(c.id)))
  }
  function onDuplicateWidgets(ids: string[]) {
    const drop = new Set(ids)
    const clones: FieldConfig[] = []
    for (const c of fieldConfig) {
      if (!drop.has(c.id)) continue
      const suffix = Math.random().toString(36).slice(2, 7)
      const lay = c.layout
      clones.push({
        ...c,
        id: `${c.id}-copy-${suffix}`,
        layout: lay ? { ...lay, x: Math.min(lay.x + 1, 11), y: lay.y + 1 } : undefined,
      })
    }
    if (clones.length) setFieldConfig([...fieldConfig, ...clones])
  }

  return (
    <div className="info-card" style={{ padding: 0 }}>
      <div className="info-card-head" style={{ padding: '14px 18px' }}>
        <span className="t">Widget builder</span>
        <span className="sub">
          Drag to move · drag the corner to resize · click/shift-click or marquee to select ·
          Delete to remove · Ctrl/Cmd+D to duplicate · Save changes to persist
        </span>
      </div>
      <div style={{ padding: 16 }}>
        {dataQ.isLoading ? (
          <div style={{ color: 'var(--fg-3)', fontSize: 13, padding: 24 }}>Loading widgets…</div>
        ) : fieldConfig.length === 0 ? (
          <div style={{ color: 'var(--fg-3)', fontSize: 13, padding: 24 }}>
            No widgets yet — add some in the <strong>Fields</strong> tab first.
          </div>
        ) : (
          <DashboardGrid
            mode="edit"
            fields={fields}
            config={fieldConfig}
            renderWidget={renderWidget}
            onLayoutChange={onLayoutChange}
            onDeleteWidgets={onDeleteWidgets}
            onDuplicateWidgets={onDuplicateWidgets}
          />
        )}
        <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 12 }}>
          Arrangement is saved to this dashboard when you click <strong>Save changes</strong> at the top.
        </div>
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────
// Source tab
// ─────────────────────────────────────────────────────────────────────

function SourceTab({
  name,
  setName,
  sheetId,
  setSheetId,
  sheetTab,
  setSheetTab,
  columnMap,
  setColumnMap,
}: {
  name: string
  setName: (n: string) => void
  sheetId: string
  setSheetId: (s: string) => void
  sheetTab: string
  setSheetTab: (s: string) => void
  columnMap: Record<string, string>
  setColumnMap: (m: Record<string, string>) => void
}) {
  return (
    <div className="two-col">
      <div>
        <div className="info-card" style={{ marginBottom: 16 }}>
          <div className="info-card-head">
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: 4,
                background: 'rgba(4,120,87,0.10)',
                color: '#047857',
                display: 'inline-grid',
                placeItems: 'center',
              }}
            >
              <I name="sheets" size={13} />
            </span>
            <span className="t">Google Sheets</span>
            {sheetId && (
              <span className="pill-status active" style={{ marginLeft: 'auto' }}>
                <span className="ps-dot" />
                connected
              </span>
            )}
          </div>
          <div className="editor-body">
            <div className="form-row">
              <span className="l">Dashboard name</span>
              <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="form-grid-2">
              <div className="form-row">
                <span className="l">Sheet ID</span>
                <input
                  className="form-input mono"
                  value={sheetId}
                  onChange={(e) => setSheetId(e.target.value)}
                  placeholder="1aBcXyZ…SHEET_ID"
                />
                <span className="help">From <span className="mono">/d/<u>SHEET_ID</u>/edit</span>. Service account needs Viewer access.</span>
              </div>
              <div className="form-row">
                <span className="l">Tab</span>
                <input className="form-input" value={sheetTab} onChange={(e) => setSheetTab(e.target.value)} />
                <span className="help">Which sheet tab to read from.</span>
              </div>
            </div>
          </div>
        </div>

        {/* Column mapping */}
        <div className="info-card">
          <div className="info-card-head">
            <span className="t">Column mapping</span>
            <span className="sub">{Object.keys(columnMap).length} mapped</span>
          </div>
          <table className="mapping-table">
            <thead>
              <tr>
                <th>Sheet column</th>
                <th></th>
                <th>Semantic name</th>
                <th>Type</th>
                <th>Required</th>
              </tr>
            </thead>
            <tbody>
              {SEMANTIC_COLUMNS.map((sc) => {
                const value = columnMap[sc.key] ?? ''
                return (
                  <tr key={sc.key}>
                    <td>
                      <select
                        className="form-input mono"
                        style={{ height: 28, padding: '0 8px', maxWidth: 160 }}
                        value={value}
                        onChange={(e) => {
                          const next = { ...columnMap }
                          if (e.target.value) next[sc.key] = e.target.value
                          else delete next[sc.key]
                          setColumnMap(next)
                        }}
                      >
                        <option value="">— not mapped —</option>
                        {COLUMN_LETTERS.map((l) => (
                          <option key={l} value={l}>
                            Column {l}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="arrow">→</td>
                    <td className="col-name">{sc.label}</td>
                    <td>
                      <span className="type-pill">{sc.type}</span>
                    </td>
                    <td>
                      {sc.required ? (
                        <span style={{ color: 'var(--neg)', fontFamily: 'var(--d-font-mono)', fontSize: 11 }}>
                          required
                        </span>
                      ) : (
                        <span style={{ color: 'var(--fg-4)', fontFamily: 'var(--d-font-mono)', fontSize: 11 }}>
                          optional
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sidebar: sync health */}
      <div>
        <div className="info-card" style={{ marginBottom: 16 }}>
          <div className="info-card-head">
            <span className="t">Sync health</span>
          </div>
          <div className="kv-list">
            <div className="kv-row">
              <div className="k">Source</div>
              <div className="v mono">Google Sheets</div>
            </div>
            <div className="kv-row">
              <div className="k">Sheet</div>
              <div className="v mono">{sheetId ? `${sheetId.slice(0, 16)}…` : '—'}</div>
            </div>
            <div className="kv-row">
              <div className="k">Tab</div>
              <div className="v mono">{sheetTab}</div>
            </div>
            <div className="kv-row">
              <div className="k">Mapped columns</div>
              <div className="v mono">{Object.keys(columnMap).length} / {SEMANTIC_COLUMNS.length}</div>
            </div>
          </div>
        </div>

        <div className="info-card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12.5, color: 'var(--fg-3)', marginBottom: 8 }}>
            <strong style={{ color: 'var(--d-fg)' }}>message</strong> is what gets sent to the LLM.{' '}
            <strong style={{ color: 'var(--d-fg)' }}>timestamp</strong> is strongly recommended — without it, time-series widgets fall back to row-insert time.
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Branding tab
// ─────────────────────────────────────────────────────────────────────

function BrandingTab({
  brandName,
  setBrandName,
  brandLogoUrl,
  setBrandLogoUrl,
  brandPrimary,
  setBrandPrimary,
  brandAccent,
  setBrandAccent,
  dashboardName,
  brandKey,
}: {
  brandName: string
  setBrandName: (n: string) => void
  brandLogoUrl: string
  setBrandLogoUrl: (u: string) => void
  brandPrimary: string
  setBrandPrimary: (c: string) => void
  brandAccent: string
  setBrandAccent: (c: string) => void
  dashboardName: string
  brandKey: ReturnType<typeof brandKeyFor>
}) {
  return (
    <div className="two-col">
      <div>
        <div className="info-card" style={{ marginBottom: 16 }}>
          <div className="info-card-head">
            <span className="t">Logo</span>
            <span className="sub">shown on every page of the public dashboard</span>
          </div>
          <div className="editor-body">
            <LogoUploader
              value={brandLogoUrl}
              onChange={setBrandLogoUrl}
              fallbackPreview={<BrandLogo brand={brandKey} size="lg" />}
              helpText={
                <>
                  PNG, JPEG, SVG, or WebP. Square + transparent reads best.
                  Uploads up to 250&nbsp;KB are embedded inline in the
                  dashboard config; larger logos need a hosted URL.
                </>
              }
            />
          </div>
        </div>

        <div className="info-card" style={{ marginBottom: 16 }}>
          <div className="info-card-head">
            <span className="t">Display name</span>
          </div>
          <div className="editor-body">
            <div className="form-row">
              <span className="l">Brand name</span>
              <input
                className="form-input"
                placeholder={dashboardName}
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
              />
              <span className="help">Shown next to the logo in the public dashboard header.</span>
            </div>
          </div>
        </div>

        <div className="info-card">
          <div className="info-card-head">
            <span className="t">
              Brand colors <span style={{ color: 'var(--fg-4)', fontWeight: 400 }}>· optional</span>
            </span>
          </div>
          <div className="editor-body">
            <div className="form-row">
              <span className="l">Primary</span>
              <div className="color-input-row">
                <input
                  type="color"
                  className="swatch"
                  value={brandPrimary}
                  onChange={(e) => setBrandPrimary(e.target.value)}
                  aria-label="Primary color"
                />
                <input
                  className="form-input mono hex"
                  value={brandPrimary}
                  onChange={(e) => setBrandPrimary(e.target.value)}
                />
              </div>
            </div>
            <div className="form-row">
              <span className="l">Accent</span>
              <div className="color-input-row">
                <input
                  type="color"
                  className="swatch"
                  value={brandAccent}
                  onChange={(e) => setBrandAccent(e.target.value)}
                  aria-label="Accent color"
                />
                <input
                  className="form-input mono hex"
                  value={brandAccent}
                  onChange={(e) => setBrandAccent(e.target.value)}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Live preview */}
      <div>
        <div className="info-card" style={{ position: 'sticky', top: 72 }}>
          <div className="info-card-head">
            <span className="t">Live preview</span>
            <span className="sub">what clients see</span>
          </div>
          <div className="editor-body">
            <div className="brand-preview">
              {brandLogoUrl ? (
                <img src={brandLogoUrl} alt="" style={{ maxHeight: 48, maxWidth: '40%', objectFit: 'contain' }} />
              ) : (
                <BrandLogo brand={brandKey} size="md" />
              )}
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--d-fg)' }}>
                  {brandName || dashboardName}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--fg-3)', fontFamily: 'var(--d-font-mono)', marginTop: 2 }}>
                  Live · syncing every 30s
                </div>
              </div>
            </div>
            <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--bg-muted)', borderRadius: 'var(--d-radius)', fontSize: 11, color: 'var(--fg-3)' }}>
              The brand color also drives chart accents, KPI ribbon highlights, and the gauge fill on the public dashboard.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Settings tab
// ─────────────────────────────────────────────────────────────────────

function SettingsTab({
  pollInterval,
  setPollInterval,
  isActive,
  setIsActive,
  logs,
  onSync,
  syncing,
  onDelete,
  removing,
}: {
  pollInterval: number
  setPollInterval: (v: number) => void
  isActive: boolean
  setIsActive: (v: boolean) => void
  logs: SyncLogOut[]
  onSync: () => void
  syncing: boolean
  onDelete: () => void
  removing: boolean
}) {
  return (
    <div className="two-col">
      <div>
        <div className="info-card" style={{ marginBottom: 16 }}>
          <div className="info-card-head">
            <span className="t">Sync</span>
            <button className="ghost-btn primary" style={{ marginLeft: 'auto' }} onClick={onSync} disabled={syncing}>
              <I name="refresh" />
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
          <div className="editor-body">
            <div className="form-grid-2">
              <div className="form-row">
                <span className="l">Poll interval (seconds)</span>
                <input
                  className="form-input mono"
                  type="number"
                  min={5}
                  max={3600}
                  value={pollInterval}
                  onChange={(e) => setPollInterval(Number(e.target.value))}
                />
                <span className="help">Default 30s. Faster polling costs more Sheets API quota.</span>
              </div>
              <div className="form-row">
                <span className="l">Active</span>
                <label style={{ display: 'inline-flex', gap: 10, alignItems: 'center', height: 34, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={(e) => setIsActive(e.target.checked)}
                    style={{ width: 16, height: 16, accentColor: 'var(--accent)' }}
                  />
                  <span>{isActive ? 'Live · public link works' : 'Archived · public link returns 404'}</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <div className="info-card" style={{ marginBottom: 16 }}>
          <div className="info-card-head">
            <span className="t">Recent syncs</span>
            <span className="sub">last 25 · refreshes every 10s</span>
          </div>
          {logs.length === 0 ? (
            <div style={{ padding: 24, color: 'var(--fg-3)', fontSize: 13 }}>No syncs yet.</div>
          ) : (
            <table className="activity-table">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>Time</th>
                  <th style={{ width: 90 }}>Source</th>
                  <th style={{ width: 90 }}>Status</th>
                  <th>Message</th>
                  <th style={{ width: 80, textAlign: 'right' }}>Rows</th>
                  <th style={{ width: 80, textAlign: 'right' }}>Duration</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="ts">{new Date(l.occurred_at).toLocaleTimeString()}</td>
                    <td>
                      {/* Map to collision-safe pill classes: 'ai' → 'openai',
                          and 'admin' → 'audit' (a bare `.admin` class would
                          collide with the app-shell `.admin` rule and stretch
                          the pill to a full screen tall). */}
                      <span className={'src ' + (l.source === 'ai' ? 'openai' : l.source === 'admin' ? 'audit' : l.source)}>{l.source}</span>
                    </td>
                    <td>
                      <span className={'status-cell ' + (l.status === 'success' ? 'success' : 'error')}>
                        <span className="pip" />
                        {l.status}
                      </span>
                    </td>
                    <td style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{l.message}</td>
                    <td className="ts" style={{ textAlign: 'right' }}>{l.rows_processed ?? '—'}</td>
                    <td className="ts" style={{ textAlign: 'right' }}>{l.duration_ms != null ? `${l.duration_ms} ms` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="danger-zone">
          <div className="t">Danger zone</div>
          <div className="d">
            Deleting the dashboard removes its chat rows + sync history. The Google Sheet itself is untouched.
          </div>
          <button className="btn-danger" onClick={onDelete} disabled={removing}>
            <I name="trash" />
            {removing ? 'Deleting…' : 'Delete dashboard'}
          </button>
        </div>
      </div>

      <div>
        <div className="info-card">
          <div className="info-card-head">
            <span className="t">Quick reference</span>
          </div>
          <div className="kv-list">
            <div className="kv-row">
              <div className="k">Sync cadence</div>
              <div className="v mono">{pollInterval}s</div>
            </div>
            <div className="kv-row">
              <div className="k">AI batch</div>
              <div className="v mono">20 / call</div>
            </div>
            <div className="kv-row">
              <div className="k">AI tick</div>
              <div className="v mono">60s</div>
            </div>
            <div className="kv-row">
              <div className="k">GA4 tick</div>
              <div className="v mono">1h</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
