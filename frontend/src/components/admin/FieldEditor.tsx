import { useEffect, useState } from 'react'

import type { FieldConfig, FieldType } from '@/types'

import { I } from './icons'
import { confirm as confirmDialog } from './useConfirm'

// ─────────────────────────────────────────────────────────────────────
// Type catalogue — what shows in the palette + the type pill on rows
// ─────────────────────────────────────────────────────────────────────

export type TypeMeta = {
  type: FieldType
  label: string
  hint: string
  iconId: string
}

// Exported so the visual Layout builder can offer the same widget catalog
// + identical default shapes when adding/duplicating widgets on the canvas.
export const TYPES: TypeMeta[] = [
  { type: 'metric',    label: 'Metric',    hint: 'Single big number with delta',  iconId: 'hash' },
  { type: 'gauge',     label: 'Gauge',     hint: '% against a range (0–100)',     iconId: 'gauge' },
  { type: 'line',      label: 'Line',      hint: 'Time series',                   iconId: 'line' },
  { type: 'bar',       label: 'Bar',       hint: 'Categorical bars',              iconId: 'bar' },
  { type: 'pie',       label: 'Pie',       hint: 'Share breakdown',               iconId: 'pie' },
  { type: 'tag_cloud', label: 'Tag cloud', hint: 'Open-text topic weights',       iconId: 'tag' },
  { type: 'table',     label: 'Table',     hint: 'Tabular rows',                  iconId: 'table' },
  { type: 'map',       label: 'Map',       hint: 'Geo bubbles or pin',            iconId: 'map' },
  { type: 'big_number',   label: 'Big number',    hint: 'Hero stat with sparkline',     iconId: 'hash' },
  { type: 'donut',        label: 'Donut',         hint: 'Pie with center total',         iconId: 'pie' },
  { type: 'funnel',       label: 'Funnel',        hint: 'Sequential conversion stages',  iconId: 'bar' },
  { type: 'progress_bar', label: 'Progress bar',  hint: 'Value vs target',               iconId: 'bar' },
]
const TYPE_BY_KEY: Record<string, TypeMeta> = Object.fromEntries(TYPES.map((t) => [t.type, t]))

// Data sources for `metric` and `gauge` (sheets-derived + GA4).
const SHEET_SOURCES: { value: string; label: string }[] = [
  { value: 'chat_count',         label: 'Chat count — all rows in window' },
  { value: 'user_messages',      label: 'User messages — only user-sent rows' },
  { value: 'unique_users',       label: 'Unique users — distinct UserId' },
  { value: 'human_escalations',  label: 'Human escalations' },
  { value: 'in_house_guests',    label: 'In-house guests' },
  { value: 'booking_links',      label: 'Booking links shared' },
  { value: 'total_bookings',     label: 'Total bookings' },
  { value: 'avg_response_time',  label: 'Average response time (seconds)' },
  { value: 'avg_interactions',   label: 'Average interactions (msgs / chat)' },
  { value: 'ai_sentiment_score', label: 'AI sentiment score (-1 to +1)' },
]
const GA4_SOURCES: { value: string; label: string }[] = [
  { value: 'ga4_users',       label: 'GA4 active users' },
  { value: 'ga4_conversions', label: 'GA4 conversions (revenue)' },
  { value: 'ga4_pageviews',   label: 'GA4 pageviews' },
  { value: 'ga4_traffic',     label: 'GA4 traffic sources' },
]

const GROUP_BY_OPTIONS = [
  { value: 'Language',     label: 'Language' },
  { value: 'Channel',      label: 'Channel' },
  { value: 'Country',      label: 'Country' },
  { value: 'ai_intent',    label: 'AI intent classification' },
  { value: 'ai_sentiment', label: 'AI sentiment bucket' },
]

const WINDOW_OPTIONS = [
  { value: '',   label: 'Match dashboard date range' },
  { value: '1',  label: 'Today (last 24 hours)' },
  { value: '7',  label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
]

// ─────────────────────────────────────────────────────────────────────
// Public component
// ─────────────────────────────────────────────────────────────────────

export default function FieldEditor({
  fields,
  onChange,
}: {
  fields: FieldConfig[]
  onChange: (next: FieldConfig[]) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(fields[0]?.id ?? null)
  const [showPalette, setShowPalette] = useState(false)
  const selected = fields.find((f) => f.id === selectedId) ?? null

  function updateAt(idx: number, next: FieldConfig) {
    const copy = [...fields]
    copy[idx] = next
    onChange(copy)
  }
  function remove(id: string) {
    onChange(fields.filter((f) => f.id !== id))
    if (selectedId === id) setSelectedId(null)
  }
  function move(idx: number, delta: -1 | 1) {
    const target = idx + delta
    if (target < 0 || target >= fields.length) return
    const copy = [...fields]
    const [item] = copy.splice(idx, 1)
    copy.splice(target, 0, item)
    onChange(copy)
  }
  function addOfType(type: FieldType) {
    const id = `widget_${Date.now()}`
    const defaults: FieldConfig = makeDefaultsFor(type, id)
    onChange([...fields, defaults])
    setSelectedId(id)
    setShowPalette(false)
  }

  return (
    <div className="fields-editor">
      <div className="fields-list">
        <div className="fields-list-head">
          <span className="t">Widgets</span>
          <span className="ct">{fields.length}</span>
          <button className="add" onClick={() => setShowPalette((s) => !s)}>
            <I name="plus" size={12} />
            Add widget
          </button>
        </div>

        {fields.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>
            No widgets yet. Click <strong style={{ color: 'var(--d-fg)' }}>Add widget</strong> to pick a type.
          </div>
        ) : (
          <div>
            {fields.map((f, i) => (
              <FieldRow
                key={f.id}
                field={f}
                isSelected={selectedId === f.id}
                isFirst={i === 0}
                isLast={i === fields.length - 1}
                onSelect={() => {
                  setSelectedId(f.id)
                  setShowPalette(false)
                }}
                onDelete={() => remove(f.id)}
                onMoveUp={() => move(i, -1)}
                onMoveDown={() => move(i, +1)}
              />
            ))}
          </div>
        )}

        {showPalette && (
          <div className="palette">
            {TYPES.map((t) => (
              <button key={t.type} className="palette-item" onClick={() => addOfType(t.type)}>
                <span className="ic">
                  <I name={t.iconId} size={13} />
                </span>
                <span>
                  <span className="ti">{t.label}</span>
                  <span className="hi">{t.hint}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Editor pane */}
      {selected ? (
        <FieldForm
          field={selected}
          onSave={(next) => {
            const idx = fields.findIndex((f) => f.id === selected.id)
            if (idx >= 0) updateAt(idx, next)
          }}
          onDelete={() => remove(selected.id)}
        />
      ) : (
        <div className="field-editor">
          <div className="field-editor-head">
            <span className="t" style={{ color: 'var(--fg-3)' }}>No widget selected</span>
          </div>
          <div className="editor-body" style={{ textAlign: 'center', color: 'var(--fg-3)', fontSize: 13, padding: 32 }}>
            Select a widget on the left, or click <strong style={{ color: 'var(--d-fg)' }}>Add widget</strong> to start.
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// List row
// ─────────────────────────────────────────────────────────────────────

function FieldRow({
  field,
  isSelected,
  isFirst,
  isLast,
  onSelect,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  field: FieldConfig
  isSelected: boolean
  isFirst: boolean
  isLast: boolean
  onSelect: () => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const meta = TYPE_BY_KEY[field.type] ?? TYPE_BY_KEY.metric
  return (
    <div className={'field-row' + (isSelected ? ' selected' : '')} onClick={onSelect}>
      <span className="drag" title="Reorder">
        <I name="drag" size={14} />
      </span>
      <span className="type-ic">
        <I name={meta.iconId} size={13} />
      </span>
      <span className="field-info">
        <span className="lbl">{field.label || 'Untitled'}</span>
        <span className="meta">
          <span className="ty">{field.type}</span>
          {summaryFor(field) && <> · {summaryFor(field)}</>}
        </span>
      </span>
      <span style={{ display: 'flex', gap: 2 }} onClick={(e) => e.stopPropagation()}>
        <button
          className="icon-btn"
          style={{ width: 22, height: 22 }}
          disabled={isFirst}
          onClick={onMoveUp}
          title="Move up"
        >
          <I name="up" size={11} />
        </button>
        <button
          className="icon-btn"
          style={{ width: 22, height: 22 }}
          disabled={isLast}
          onClick={onMoveDown}
          title="Move down"
        >
          <I name="down" size={11} />
        </button>
        <button
          className="icon-btn"
          style={{ width: 22, height: 22 }}
          onClick={() => {
            confirmDialog({
              title: `Delete "${field.label}"?`,
              message: 'The widget will be removed from this dashboard.',
              confirmLabel: 'Delete widget',
              danger: true,
            }).then((ok) => { if (ok) onDelete() })
          }}
          title="Delete"
        >
          <I name="trash" size={11} />
        </button>
      </span>
    </div>
  )
}

function summaryFor(f: FieldConfig): string {
  switch (f.type) {
    case 'metric': {
      const source = String(f.source ?? '—')
      const w = f.window_days ? `${f.window_days}d window` : 'dashboard range'
      return `${source} · ${w}`
    }
    case 'gauge':
      return String(f.source ?? '—')
    case 'line':
      return String(f.aggregation ?? 'count_by_day')
    case 'bar':
    case 'pie':
      return `by ${String(f.group_by ?? '—')}`
    case 'tag_cloud':
      return 'AI topics'
    case 'table':
      return `${f.limit ?? 25} rows`
    case 'map':
      return f.q ? `place: ${String(f.q)}` : 'geo bubbles'
    default:
      return ''
  }
}

// ─────────────────────────────────────────────────────────────────────
// Form pane
// ─────────────────────────────────────────────────────────────────────

function FieldForm({
  field,
  onSave,
  onDelete,
}: {
  field: FieldConfig
  onSave: (next: FieldConfig) => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState<FieldConfig>(field)

  // Reseed when parent passes a different field.
  useEffect(() => {
    setDraft(field)
  }, [field.id])

  function patch(p: Partial<FieldConfig>) {
    setDraft({ ...draft, ...p })
  }

  const meta = TYPE_BY_KEY[draft.type] ?? TYPE_BY_KEY.metric

  return (
    <div className="field-editor">
      <div className="field-editor-head">
        <span className="t">{draft.label || 'Untitled'}</span>
        <span className="ty-pill">{draft.type}</span>
        <div className="right">
          <button className="icon-btn" onClick={() => onSave(draft)} title="Save">
            <I name="check" />
          </button>
          <button
            className="icon-btn"
            onClick={() => {
              confirmDialog({
                title: `Delete "${draft.label}"?`,
                message: 'The widget will be removed from this dashboard.',
                confirmLabel: 'Delete widget',
                danger: true,
              }).then((ok) => { if (ok) onDelete() })
            }}
            title="Delete"
          >
            <I name="trash" />
          </button>
        </div>
      </div>
      <div className="editor-body">
        {/* Type picker */}
        <div className="form-row">
          <span className="l">Widget type</span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
            {TYPES.map((t) => {
              const active = draft.type === t.type
              return (
                <button
                  key={t.type}
                  type="button"
                  onClick={() => patch({ type: t.type })}
                  className="palette-item"
                  style={
                    active
                      ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' }
                      : undefined
                  }
                >
                  <span className="ic">
                    <I name={t.iconId} size={12} />
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span className="ti" style={{ fontSize: 11.5 }}>{t.label}</span>
                  </span>
                </button>
              )
            })}
          </div>
          <span className="help">Switch type — type-specific fields swap below.</span>
        </div>

        {/* Label */}
        <div className="form-row">
          <span className="l">Label</span>
          <input
            className="form-input"
            value={String(draft.label ?? '')}
            onChange={(e) => patch({ label: e.target.value })}
            placeholder={`New ${meta.label.toLowerCase()}`}
          />
          <span className="help">Shown above the widget on the public dashboard.</span>
        </div>

        {/* Type-specific fields */}
        {(draft.type === 'metric' || draft.type === 'gauge') && (
          <div className="form-row">
            <span className="l">Data source</span>
            <select
              className="form-input mono"
              value={String(draft.source ?? '')}
              onChange={(e) => patch({ source: e.target.value })}
            >
              <option value="">— pick a source —</option>
              <optgroup label="Sheets pipeline">
                {SHEET_SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </optgroup>
              <optgroup label="GA4 (if configured)">
                {GA4_SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </optgroup>
            </select>
          </div>
        )}

        {draft.type === 'metric' && (
          <>
            <div className="form-grid-2">
              <div className="form-row">
                <span className="l">Time window</span>
                <select
                  className="form-input mono"
                  value={draft.window_days != null ? String(draft.window_days) : ''}
                  onChange={(e) => patch({ window_days: e.target.value ? Number(e.target.value) : null })}
                >
                  {WINDOW_OPTIONS.map((w) => (
                    <option key={w.value} value={w.value}>{w.label}</option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <span className="l">Unit suffix</span>
                <input
                  className="form-input mono"
                  value={String(draft.unit ?? '')}
                  onChange={(e) => patch({ unit: e.target.value })}
                  placeholder="e.g. chats, msgs, seconds, USD"
                />
              </div>
            </div>
          </>
        )}

        {draft.type === 'gauge' && (
          <div className="form-grid-2">
            <div className="form-row">
              <span className="l">Min</span>
              <input
                className="form-input mono"
                type="number"
                step="0.1"
                value={draft.min != null ? String(draft.min) : '-1'}
                onChange={(e) => patch({ min: Number(e.target.value) })}
              />
            </div>
            <div className="form-row">
              <span className="l">Max</span>
              <input
                className="form-input mono"
                type="number"
                step="0.1"
                value={draft.max != null ? String(draft.max) : '1'}
                onChange={(e) => patch({ max: Number(e.target.value) })}
              />
            </div>
          </div>
        )}

        {draft.type === 'line' && (
          <div className="form-row">
            <span className="l">Aggregation</span>
            <select
              className="form-input mono"
              value={String(draft.aggregation ?? 'count_by_day')}
              onChange={(e) => patch({ aggregation: e.target.value })}
            >
              <option value="count_by_day">Count per day</option>
              <option value="count_by_hour">Count per hour</option>
              <option value="avg_sentiment_by_day">Average sentiment per day</option>
            </select>
          </div>
        )}

        {(draft.type === 'bar' || draft.type === 'pie') && (
          <div className="form-row">
            <span className="l">Group by</span>
            <select
              className="form-input mono"
              value={String(draft.group_by ?? '')}
              onChange={(e) => patch({ group_by: e.target.value })}
            >
              <option value="">— pick a column —</option>
              {GROUP_BY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        )}

        {draft.type === 'table' && (
          <div className="form-row">
            <span className="l">Row limit</span>
            <input
              className="form-input mono"
              type="number"
              value={Number(draft.limit ?? 25)}
              onChange={(e) => patch({ limit: Number(e.target.value) })}
              min={1}
              max={500}
            />
          </div>
        )}

        {draft.type === 'map' && (
          <div className="form-row">
            <span className="l">Place query (optional)</span>
            <input
              className="form-input"
              value={String(draft.q ?? '')}
              onChange={(e) => patch({ q: e.target.value })}
              placeholder="e.g. Sharjah, UAE"
            />
            <span className="help">
              If set, embeds Google Maps centered on this place. If empty, plots country-level bubbles.
            </span>
          </div>
        )}

        {/* Live preview */}
        <div className="live-preview">
          <div className="live-preview-head">
            <I name="eye" size={11} />
            Live preview
          </div>
          <FieldPreview field={draft} />
        </div>

        {/* Footer actions */}
        <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: '1px solid var(--d-border)' }}>
          <button
            className="btn-danger"
            type="button"
            onClick={() => {
              confirmDialog({
                title: `Delete "${draft.label}"?`,
                message: 'The widget will be removed from this dashboard.',
                confirmLabel: 'Delete widget',
                danger: true,
              }).then((ok) => { if (ok) onDelete() })
            }}
          >
            <I name="trash" />
            Delete
          </button>
          <button
            type="button"
            className="ghost-btn primary"
            style={{ marginLeft: 'auto' }}
            onClick={() => onSave(draft)}
            disabled={!draft.label.trim()}
          >
            <I name="check" />
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Mini preview tile per type
// ─────────────────────────────────────────────────────────────────────

function FieldPreview({ field }: { field: FieldConfig }) {
  switch (field.type) {
    case 'metric':
      return (
        <div className="preview-tile">
          <div className="label">{field.label || 'Untitled'}</div>
          <div className="value">
            312
            {field.unit ? <span className="unit">{String(field.unit)}</span> : null}
          </div>
          <div className="delta">▲ 8.4% vs prev period</div>
        </div>
      )
    case 'gauge':
      return (
        <div className="preview-tile" style={{ textAlign: 'center' }}>
          <div className="label">{field.label || 'Untitled'}</div>
          <svg viewBox="0 0 220 130" style={{ width: '100%', maxWidth: 220, marginTop: 6 }}>
            <path d="M 20 110 A 90 90 0 0 1 200 110" fill="none" stroke="var(--d-border)" strokeWidth="10" strokeLinecap="round" />
            <path d="M 20 110 A 90 90 0 0 1 200 110" fill="none" stroke="var(--accent)" strokeWidth="10" strokeLinecap="round" strokeDasharray="200 282" />
          </svg>
          <div className="value" style={{ marginTop: 4 }}>0.62</div>
        </div>
      )
    case 'line':
      return (
        <div className="preview-tile">
          <div className="label">{field.label || 'Untitled'}</div>
          <svg viewBox="0 0 280 80" style={{ width: '100%', height: 80, marginTop: 8 }}>
            <defs>
              <linearGradient id="prev-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d="M0,55 C40,52 60,40 100,42 C140,44 160,18 200,22 C240,26 260,32 280,26 L280,80 L0,80 Z" fill="url(#prev-area)" />
            <path d="M0,55 C40,52 60,40 100,42 C140,44 160,18 200,22 C240,26 260,32 280,26" fill="none" stroke="var(--accent)" strokeWidth="1.75" />
          </svg>
        </div>
      )
    case 'bar':
      return (
        <div className="preview-tile">
          <div className="label">{field.label || 'Untitled'}</div>
          <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
            {[64, 48, 32, 18].map((w, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--fg-3)', width: 70, fontFamily: 'var(--d-font-mono)' }}>cat {i + 1}</span>
                <div style={{ flex: 1, height: 6, background: 'var(--bg-muted)', borderRadius: 999 }}>
                  <div style={{ width: w + '%', height: '100%', background: 'var(--accent)', borderRadius: 999 }} />
                </div>
                <span style={{ fontSize: 11, color: 'var(--d-fg)', fontFamily: 'var(--d-font-mono)' }}>{w}</span>
              </div>
            ))}
          </div>
        </div>
      )
    case 'pie':
      return (
        <div className="preview-tile" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <svg viewBox="0 0 80 80" style={{ width: 80, height: 80, transform: 'rotate(-90deg)' }}>
            <circle cx="40" cy="40" r="30" fill="none" stroke="var(--bg-muted)" strokeWidth="12" />
            <circle cx="40" cy="40" r="30" fill="none" stroke="var(--accent)" strokeWidth="12" strokeDasharray="98 188" />
            <circle cx="40" cy="40" r="30" fill="none" stroke="var(--fg-4)" strokeWidth="12" strokeDasharray="62 188" strokeDashoffset="-98" />
          </svg>
          <div style={{ flex: 1, fontSize: 12 }}>
            <div className="label">{field.label || 'Untitled'}</div>
            <div style={{ marginTop: 8, display: 'grid', gap: 4, color: 'var(--fg-3)' }}>
              <div>● English · 52%</div>
              <div style={{ color: 'var(--fg-4)' }}>● Arabic · 33%</div>
            </div>
          </div>
        </div>
      )
    case 'tag_cloud':
      return (
        <div className="preview-tile">
          <div className="label">{field.label || 'Untitled'}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
            {['room-service', 'booking', 'wifi', 'check-out', 'breakfast'].map((t, i) => (
              <span
                key={t}
                style={{
                  fontSize: 14 - i * 0.7,
                  padding: '3px 8px',
                  background: 'var(--d-surface)',
                  border: '1px solid var(--d-border)',
                  borderRadius: 999,
                  color: 'var(--fg-2)',
                }}
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      )
    case 'table':
      return (
        <div className="preview-tile" style={{ padding: 0 }}>
          <div style={{ padding: 12, borderBottom: '1px solid var(--d-border)' }}>
            <div className="label">{field.label || 'Untitled'}</div>
          </div>
          <div style={{ padding: 12, fontSize: 11.5, color: 'var(--fg-3)', fontFamily: 'var(--d-font-mono)' }}>
            14:38 · UAE · positive · "Hi can I extend my stay…"
            <br />
            14:31 · KSA · neutral · "السلام عليكم…"
            <br />
            14:24 · UK · positive · "Amazing service…"
          </div>
        </div>
      )
    case 'map':
      return (
        <div className="preview-tile">
          <div className="label">{field.label || 'Untitled'}</div>
          <div
            style={{
              marginTop: 8,
              aspectRatio: '2 / 1',
              background: 'var(--bg-muted)',
              borderRadius: 'var(--d-radius)',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--fg-4)',
              fontSize: 11,
              fontFamily: 'var(--d-font-mono)',
            }}
          >
            world map · {field.q ? `pin: ${String(field.q)}` : 'country bubbles'}
          </div>
        </div>
      )
    default:
      return (
        <div className="preview-tile">
          <div className="label">Unsupported type</div>
        </div>
      )
  }
}

// ─────────────────────────────────────────────────────────────────────
// Defaults per type
// ─────────────────────────────────────────────────────────────────────

export function makeDefaultsFor(type: FieldType, id: string): FieldConfig {
  const base = { id, label: 'New widget' }
  switch (type) {
    case 'metric':
      return { ...base, type, source: 'chat_count', window_days: 7 }
    case 'gauge':
      return { ...base, type, source: 'ai_sentiment_score', min: -1, max: 1 }
    case 'line':
      return { ...base, type, aggregation: 'count_by_day' }
    case 'bar':
    case 'pie':
      return { ...base, type, group_by: 'Channel' }
    case 'tag_cloud':
      return { ...base, type, source: 'ai_topics' }
    case 'table':
      return { ...base, type, limit: 25 }
    case 'map':
      return { ...base, type }
    default:
      return { ...base, type: 'metric' }
  }
}
