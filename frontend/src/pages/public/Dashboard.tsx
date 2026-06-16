import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { CircleMarker, MapContainer, TileLayer, Tooltip, ZoomControl } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { useParams } from 'react-router-dom'

import BrandLogo, { brandKeyFor } from '@/components/admin/BrandLogo'
import FieldRenderer, { fieldSpanClass } from '@/components/charts/FieldRenderer'
import BlockGrid, { type BlockItem } from '@/components/public/BlockGrid'
import { publicApi } from '@/lib/api'
import type {
  BarValue,
  BigNumberValue,
  DonutValue,
  FieldLayout,
  FunnelValue,
  GaugeValue,
  LayoutConfig,
  LineValue,
  MapValue,
  MetricValue,
  PieValue,
  ProgressBarValue,
  PublicDashboardConfig,
  PublicDashboardData,
  PublicFieldValue,
  TableValue,
  TagCloudValue,
} from '@/types'

// Window selection — preset chips (incl. YTD) or an explicit custom range.
// YTD is just sugar for a custom range starting on Jan 1 of the current year.
type Window =
  | { kind: 'preset'; days: 1 | 7 | 30 | 90 }
  | { kind: 'ytd' }
  | { kind: 'all' }
  | { kind: 'custom'; from: string; to: string }

const PRESETS: { days: 1 | 7 | 30 | 90; chip: string }[] = [
  { days: 1, chip: '1D' },
  { days: 7, chip: '7D' },
  { days: 30, chip: '30D' },
  { days: 90, chip: '90D' },
]

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function ytdRange(): { from: string; to: string } {
  const now = new Date()
  return {
    from: `${now.getFullYear()}-01-01`,
    to: isoDate(now),
  }
}
function shortRangeLabel(w: Window): string {
  if (w.kind === 'preset') {
    const now = new Date()
    const start = new Date(now.getTime() - (w.days - 1) * 86_400_000)
    return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
  }
  if (w.kind === 'ytd') {
    const r = ytdRange()
    return `Jan 1 – ${new Date(r.to).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
  }
  if (w.kind === 'all') {
    return 'All time'
  }
  return `${new Date(w.from).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(w.to).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

type AccentStyle = CSSProperties & Record<`--${string}`, string>

function accentStyleFor(cfg: PublicDashboardConfig | undefined): AccentStyle {
  // Use brand_primary_color if set; otherwise derive from brand name hash.
  const primary = cfg?.brand_primary_color || ''
  if (primary) {
    return {
      '--accent': primary,
      '--accent-soft': primary + '14',
      '--accent-fg': '#ffffff',
    }
  }
  // Fall back to brand preset
  const seed = cfg?.brand_name || cfg?.name || 'default'
  const brand = brandKeyFor(seed)
  const preset = {
    nest: { primary: '#1e293b', fg_on: '#fff' },
    emerald: { primary: '#047857', fg_on: '#fff' },
    bronze: { primary: '#92400e', fg_on: '#fff' },
    crimson: { primary: '#9f1239', fg_on: '#fff' },
    default: { primary: '#1e293b', fg_on: '#fff' },
  }[brand]
  return {
    '--accent': preset.primary,
    '--accent-soft': preset.primary + '14',
    '--accent-fg': preset.fg_on,
  }
}

function bucketFields(fields: PublicFieldValue[]) {
  const buckets = {
    metric: [] as PublicFieldValue[],
    gauge: [] as PublicFieldValue[],
    line: [] as PublicFieldValue[],
    pie: [] as PublicFieldValue[],
    bar: [] as PublicFieldValue[],
    map: [] as PublicFieldValue[],
    tag_cloud: [] as PublicFieldValue[],
    table: [] as PublicFieldValue[],
  }
  for (const f of fields) {
    const k = f.type as keyof typeof buckets
    if (k in buckets) buckets[k].push(f)
  }
  return buckets
}

// ── Card-level "block" layout ───────────────────────────────────────────
// Each magazine card is a draggable/resizable block. These are the default
// positions (mirroring the magazine's reading order) used when a dashboard
// hasn't been customised; saved positions in layout_config.blocks override
// them per-card. The SAME builder feeds the public page (read-only) and the
// admin Layout editor (drag/resize) so they're identical and the cards stay
// pixel-perfect — they ARE the magazine components.
export const MAGAZINE_BLOCK_META: { id: string; title: string; layout: FieldLayout }[] = [
  { id: 'kpi',        title: 'KPI ribbon',           layout: { x: 0, y: 0,  w: 12, h: 3 } },
  { id: 'chart',      title: 'Conversations chart',  layout: { x: 0, y: 3,  w: 12, h: 8 } },
  { id: 'gauge',      title: 'Overall sentiment',    layout: { x: 0, y: 11, w: 4,  h: 7 } },
  { id: 'revenue',    title: 'Booking revenue',      layout: { x: 4, y: 11, w: 4,  h: 7 } },
  { id: 'escalation', title: 'Human escalations',    layout: { x: 8, y: 11, w: 4,  h: 7 } },
  { id: 'intent',     title: 'Conversation intent',  layout: { x: 0, y: 18, w: 4,  h: 7 } },
  { id: 'topics',     title: 'Top topics',           layout: { x: 4, y: 18, w: 8,  h: 7 } },
  { id: 'geo',        title: 'Geography',            layout: { x: 0, y: 25, w: 8,  h: 9 } },
  { id: 'languages',  title: 'Languages',            layout: { x: 8, y: 25, w: 4,  h: 4 } },
  { id: 'countries',  title: 'Countries',            layout: { x: 8, y: 29, w: 4,  h: 5 } },
  { id: 'table',      title: 'Recent conversations', layout: { x: 0, y: 34, w: 12, h: 8 } },
]

export function buildMagazineBlocks(
  cfg: PublicDashboardConfig,
  data: PublicDashboardData,
  accentVar: string,
): BlockItem[] {
  const buckets = bucketFields(data.fields)
  const heroLine = buckets.line[0] ?? null
  const heroLineHasData = !!heroLine && ((heroLine.value as LineValue)?.points?.length ?? 0) > 0
  const heroGauge = buckets.gauge[0] ?? null
  const byId = (id: string) => data.fields.find((f) => f.id === id) ?? null
  const byLabelIncludes = (kw: string) => buckets.metric.find((m) => m.label.toLowerCase().includes(kw)) ?? null
  const revenueAed = byId('revenue_aed') ?? byLabelIncludes('aed')
  const revenueUsd = byId('revenue_usd') ?? byLabelIncludes('usd')
  const totalBookings = byId('total_bookings') ?? byLabelIncludes('booking')
  const totalChats = byId('total_chats') ?? byLabelIncludes('total chats')
  const escWeek = byId('escalations_week') ?? byLabelIncludes('escalat')
  const escPos = byId('escalated_positive')
  const escNeu = byId('escalated_neutral')
  const escNeg = byId('escalated_negative')
  const heroPie = buckets.pie[0] ?? null
  const heroTagCloud = buckets.tag_cloud[0] ?? null
  const heroMap = buckets.map[0] ?? null
  // FAQ table (top frequently-asked questions) renders below Top Topics; the
  // recent-conversations table is pinned so the two don't get swapped.
  const faqTable = byId('faq_table') ?? null
  const heroTable =
    byId('recent_chats') ?? buckets.table.find((t) => t.id !== 'faq_table') ?? buckets.table[0] ?? null
  const langBar = buckets.bar.find((b) => b.label.toLowerCase().includes('lang')) ?? null
  const countryBar = buckets.bar.find((b) => b.label.toLowerCase().includes('country')) ?? null
  // Channels is dropped from the dashboard (WhatsApp-only) — flagged consumed
  // so it never renders, including in the Custom widgets fallback.
  const channelBar = byId('channel_bar') ?? buckets.bar.find((b) => b.label.toLowerCase().includes('channel')) ?? null
  const KPI_RIBBON_ORDER = [
    'total_chats', 'unique_users', 'user_messages', 'avg_interactions',
    'avg_response_time', 'in_house_guests', 'revenue_aed',
  ]
  const metricsById = new Map(buckets.metric.map((m) => [m.id, m]))
  const KPI_HIDDEN_IDS = new Set(['escalated_positive', 'escalated_neutral', 'escalated_negative'])
  const orderedRibbon = KPI_RIBBON_ORDER
    .map((id) => metricsById.get(id))
    .filter((m): m is PublicFieldValue => !!m)
  const usedIds = new Set([...orderedRibbon.map((m) => m.id), ...KPI_HIDDEN_IDS])
  const extras = buckets.metric.filter((m) => !usedIds.has(m.id))
  const kpiMetrics = [...orderedRibbon, ...extras].slice(0, 7)
  const renderableKpis = kpiMetrics.filter((m) => {
    const v = m.value as MetricValue
    return !!v && typeof v === 'object' && !('error' in v)
  })

  const node: Record<string, ReactNode> = {}
  if (renderableKpis.length > 0) node['kpi'] = <KPIRibbon metrics={renderableKpis} />
  if (heroLineHasData) node['chart'] = <VolumeChart field={heroLine!} />
  if (heroGauge) node['gauge'] = <GaugeCard field={heroGauge} totalChats={totalChats} escWeek={escWeek} />
  if (revenueAed) node['revenue'] = <RevenueCard primary={revenueAed} usd={revenueUsd} bookings={totalBookings} />
  if (escWeek || escPos || escNeu || escNeg) node['escalation'] = <EscalationCard total={escWeek} pos={escPos} neu={escNeu} neg={escNeg} />
  if (heroPie) node['intent'] = <IntentBreakdown field={heroPie} />
  if (heroTagCloud) node['topics'] = <TopicsCard field={heroTagCloud} />
  if (heroMap || countryBar) node['geo'] = <GeoCard mapField={heroMap} countryBar={countryBar} accent={accentVar} />
  if (langBar) node['languages'] = <RankedCard field={langBar} title="Languages" showPct />
  if (countryBar) node['countries'] = <RankedCard field={countryBar} title="Countries" />
  if (heroTable) node['table'] = <RecentTable field={heroTable} />

  // Order = saved block order first (skipping hidden / unavailable), then any
  // remaining available cards in the default magazine reading order. `w` is
  // the card's column span (12-col); height is auto (cards size to content).
  const savedList = cfg.layout_config?.blocks ?? []
  const savedById = new Map(savedList.map((b) => [b.id, b]))
  const orderedIds: string[] = []
  for (const b of savedList) {
    if (b.hidden || !node[b.id]) continue
    orderedIds.push(b.id)
  }
  for (const meta of MAGAZINE_BLOCK_META) {
    if (savedById.has(meta.id) || !node[meta.id]) continue
    orderedIds.push(meta.id)
  }
  return orderedIds.map((id) => {
    const meta = MAGAZINE_BLOCK_META.find((m) => m.id === id)!
    const s = savedById.get(id)
    return {
      id,
      title: meta.title,
      // w = column span; h = fixed height in row units, or 0 = auto (sizes to
      // content). Height is only fixed once the operator drags to resize it.
      layout: { x: 0, y: 0, w: s?.w ?? meta.layout.w, h: s?.h ?? 0 },
      node: node[id]!,
    }
  })
}

export default function PublicDashboard({
  shareTokenProp,
  layoutOverride,
}: {
  // When rendered as a live PREVIEW inside the admin Layout editor we pass the
  // token directly and an unsaved layout_config so the preview reflects edits
  // before they're saved. The router renders it with no props (uses useParams).
  shareTokenProp?: string
  layoutOverride?: LayoutConfig | null
} = {}) {
  const params = useParams<{ shareToken: string }>()
  const shareToken = shareTokenProp ?? params.shareToken
  const [window_, setWindow] = useState<Window>({ kind: 'preset', days: 7 })
  const [tick, setTick] = useState(0)
  const [copied, setCopied] = useState(false)

  // Public dashboard mounts the same premium-fintech token system used by
  // admin. We set data-theme + data-density on <html> so the design's
  // selectors kick in. The admin would set these too if it ran first;
  // we're just being defensive.
  useEffect(() => {
    document.documentElement.setAttribute('data-density', 'cozy')
    if (!document.documentElement.getAttribute('data-theme')) {
      document.documentElement.setAttribute('data-theme', 'light')
    }
  }, [])

  const cfgQuery = useQuery({
    queryKey: ['public-config', shareToken],
    queryFn: () => publicApi.config(shareToken!),
    enabled: !!shareToken,
  })

  const dataQuery = useQuery({
    queryKey: ['public-data', shareToken, window_],
    queryFn: () => {
      // Translate the window state to backend params. All → no params (the
      // backend shows everything). YTD → custom Jan 1 → today. Custom passes
      // through. Preset uses rangeDays.
      if (window_.kind === 'all') {
        return publicApi.data(shareToken!)
      }
      if (window_.kind === 'preset') {
        return publicApi.data(shareToken!, { rangeDays: window_.days })
      }
      const range = window_.kind === 'ytd' ? ytdRange() : window_
      return publicApi.data(shareToken!, { from: range.from, to: range.to })
    },
    enabled: !!shareToken,
    refetchInterval: 30_000,
  })

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const accentStyle = useMemo(() => accentStyleFor(cfgQuery.data), [cfgQuery.data])

  if (cfgQuery.isError || dataQuery.isError) {
    const msg =
      cfgQuery.error instanceof Error
        ? cfgQuery.error.message
        : dataQuery.error instanceof Error
          ? dataQuery.error.message
          : 'Failed to load dashboard'
    return <ErrorState message={msg} onRetry={() => { cfgQuery.refetch(); dataQuery.refetch() }} />
  }
  if (!cfgQuery.data || !dataQuery.data) {
    return <LoadingState style={accentStyle} />
  }

  const cfg = cfgQuery.data
  const data = dataQuery.data
  // Display title — prefer the explicit brand_name when set; otherwise derive
  // a clean brand from the dashboard name by stripping the "Chat Export - …"
  // operator-prefix and any trailing date suffix the seed adds. So the seed's
  // "Chat Export - Nest Hotel - 2026-04-15" becomes "Nest Hotel" — matching
  // the v3 mock's "Nest Hotel — conversational analytics" header.
  const brandTitle = cfg.brand_name || cleanDashboardName(cfg.name)
  const initial = brandTitle.charAt(0).toUpperCase()
  const brand = brandKeyFor(brandTitle)
  const lastUpdated = cfg.last_updated_at ? new Date(cfg.last_updated_at) : null
  const updatedAt = dataQuery.dataUpdatedAt || Date.now()
  const remainingSec = Math.ceil(Math.max(0, 30_000 - (Date.now() - updatedAt)) / 1000)
  void tick

  // Compute share URL for the top-bar pill
  const shareUrl = `${window.location.host}/d/${shareToken}`
  const copyShare = () => {
    navigator.clipboard?.writeText(`https://${shareUrl}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  // ── Chaptered ("magazine") layout field picks ──────────────────────────
  const buckets = bucketFields(data.fields)
  const heroLine = buckets.line[0] ?? null
  const heroLineHasData =
    !!heroLine && ((heroLine.value as LineValue)?.points?.length ?? 0) > 0
  const heroGauge = buckets.gauge[0] ?? null
  const byId = (id: string) => data.fields.find((f) => f.id === id) ?? null
  const byLabelIncludes = (kw: string) =>
    buckets.metric.find((m) => m.label.toLowerCase().includes(kw)) ?? null
  const revenueAed = byId('revenue_aed') ?? byLabelIncludes('aed')
  const revenueUsd = byId('revenue_usd') ?? byLabelIncludes('usd')
  const totalBookings = byId('total_bookings') ?? byLabelIncludes('booking')
  const totalChats = byId('total_chats') ?? byLabelIncludes('total chats')
  const escWeek = byId('escalations_week') ?? byLabelIncludes('escalat')
  const escPos = byId('escalated_positive')
  const escNeu = byId('escalated_neutral')
  const escNeg = byId('escalated_negative')
  const heroPie = buckets.pie[0] ?? null
  const heroTagCloud = buckets.tag_cloud[0] ?? null
  const heroMap = buckets.map[0] ?? null
  // FAQ table (top frequently-asked questions) renders below Top Topics; the
  // recent-conversations table is pinned so the two don't get swapped.
  const faqTable = byId('faq_table') ?? null
  const heroTable =
    byId('recent_chats') ?? buckets.table.find((t) => t.id !== 'faq_table') ?? buckets.table[0] ?? null
  const langBar = buckets.bar.find((b) => b.label.toLowerCase().includes('lang')) ?? null
  const countryBar = buckets.bar.find((b) => b.label.toLowerCase().includes('country')) ?? null
  // Channels is dropped from the dashboard (WhatsApp-only) — flagged consumed
  // so it never renders, including in the Custom widgets fallback.
  const channelBar = byId('channel_bar') ?? buckets.bar.find((b) => b.label.toLowerCase().includes('channel')) ?? null
  // KPI ribbon — up to 7 metrics in the v3 design's order; the escalation
  // breakdown fields are shown in the EscalationCard, not as standalone KPIs.
  const KPI_RIBBON_ORDER = [
    'total_chats', 'unique_users', 'user_messages', 'avg_interactions',
    'avg_response_time', 'in_house_guests', 'revenue_aed',
  ]
  const metricsById = new Map(buckets.metric.map((m) => [m.id, m]))
  const KPI_HIDDEN_IDS = new Set([
    'escalated_positive', 'escalated_neutral', 'escalated_negative',
  ])
  const orderedRibbon = KPI_RIBBON_ORDER
    .map((id) => metricsById.get(id))
    .filter((m): m is PublicFieldValue => !!m)
  const usedIds = new Set([...orderedRibbon.map((m) => m.id), ...KPI_HIDDEN_IDS])
  const extras = buckets.metric.filter((m) => !usedIds.has(m.id))
  const kpiMetrics = [...orderedRibbon, ...extras].slice(0, 7)
  const renderableKpis = kpiMetrics.filter((m) => {
    const v = m.value as MetricValue
    return !!v && typeof v === 'object' && !('error' in v)
  })

  // Every field already shown by a curated card. Anything NOT in here (e.g. an
  // AI-added or manually-added widget that doesn't fit a curated slot) is
  // rendered in the "Custom widgets" section so it never silently disappears.
  const consumedIds = new Set<string>(
    [
      ...renderableKpis.map((m) => m.id),
      ...KPI_HIDDEN_IDS,
      // Only mark the line "consumed" when it actually renders (has points);
      // otherwise it would vanish from the Custom-widgets fallback too.
      heroLineHasData ? heroLine?.id : undefined, heroGauge?.id,
      revenueAed?.id, revenueUsd?.id, totalBookings?.id, totalChats?.id,
      escWeek?.id, escPos?.id, escNeu?.id, escNeg?.id,
      heroPie?.id, heroTagCloud?.id, heroMap?.id,
      langBar?.id, countryBar?.id, heroTable?.id, faqTable?.id,
      channelBar?.id, // Channels removed (WhatsApp-only)
    ].filter((x): x is string => !!x),
  )

  // ── Config-driven magazine sections ────────────────────────────────────
  // The admin "Layout" tab stores an ordered list of sections + per-card
  // visibility in cfg.layout_config. Null/absent → the full default magazine.
  const DEFAULT_SECTION_ORDER = ['volume', 'conversion', 'intent', 'geography', 'recent', 'custom']
  // Live editor preview passes layoutOverride (unsaved edits); otherwise use
  // the saved layout_config; otherwise the full default magazine.
  const effectiveLayout = layoutOverride !== undefined ? layoutOverride : cfg.layout_config
  const orderedSections =
    effectiveLayout?.sections && effectiveLayout.sections.length
      ? effectiveLayout.sections
      : DEFAULT_SECTION_ORDER.map((id) => ({ id, visible: true, hiddenCards: [] as string[] }))

  const renderSection = (id: string, hiddenCards: string[], num: number) => {
    const hide = (card: string) => hiddenCards.includes(card)
    switch (id) {
      case 'volume': {
        const showKpi = renderableKpis.length > 0 && !hide('kpi')
        const showChart = heroLineHasData && !hide('chart')
        if (!showKpi && !showChart) return null
        return (
          <section className="section" style={{ paddingTop: 16 }} key={id}>
            {showKpi && <KPIRibbon metrics={renderableKpis} />}
            {showChart && (
              <>
                {showKpi && <div style={{ height: 16 }} />}
                <VolumeChart field={heroLine!} />
              </>
            )}
          </section>
        )
      }
      case 'conversion': {
        const showGauge = !!heroGauge && !hide('gauge')
        const showRevenue = !!revenueAed && !hide('revenue')
        const showEsc = !!(escWeek || escPos || escNeu || escNeg) && !hide('escalation')
        if (!showGauge && !showRevenue && !showEsc) return null
        return (
          <section className="section" key={id}>
            <SectionHead num={num} title="Conversion & resolution" />
            <div className="grid-3">
              {showGauge && <GaugeCard field={heroGauge!} totalChats={totalChats} escWeek={escWeek} />}
              {showRevenue && <RevenueCard primary={revenueAed!} usd={revenueUsd} bookings={totalBookings} />}
              {showEsc && <EscalationCard total={escWeek} pos={escPos} neu={escNeu} neg={escNeg} />}
            </div>
          </section>
        )
      }
      case 'intent': {
        const showPie = !!heroPie && !hide('intent')
        const showTopics = !!heroTagCloud && !hide('topics')
        const showFaq = !!faqTable && !hide('faq')
        if (!showPie && !showTopics && !showFaq) return null
        return (
          <section className="section" key={id}>
            <SectionHead num={num} title="What guests ask about" />
            {/* Intent gets its own full-width row now that Channels is removed —
                shows the full breakdown + legend. Topics + FAQ stack below. */}
            {showPie && <IntentBreakdown field={heroPie!} />}
            {showTopics && (
              <div style={{ marginTop: showPie ? 16 : 0 }}>
                <TopicsCard field={heroTagCloud!} />
              </div>
            )}
            {/* FAQ — top frequently-asked questions, below Top Topics */}
            {showFaq && (
              <div style={{ marginTop: 16 }}>
                <FieldRenderer field={faqTable!} />
              </div>
            )}
          </section>
        )
      }
      case 'geography': {
        const showMap = !!(heroMap || countryBar) && !hide('map')
        const showLang = !!langBar && !hide('languages')
        const showCountry = !!countryBar && !hide('countries')
        if (!showMap && !showLang && !showCountry) return null
        return (
          <section className="section" key={id}>
            <SectionHead num={num} title="Geography & languages" />
            <div className="grid-3">
              {showMap && (
                <div className="span-2">
                  <GeoCard mapField={heroMap} countryBar={countryBar} accent={accentStyle['--accent']} />
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {showLang && <RankedCard field={langBar!} title="Languages" showPct />}
                {showCountry && <RankedCard field={countryBar!} title="Countries" />}
              </div>
            </div>
          </section>
        )
      }
      case 'recent': {
        if (!heroTable || hide('table')) return null
        return (
          <section className="section" key={id}>
            <SectionHead num={num} title="Live conversation stream" />
            <RecentTable field={heroTable} />
          </section>
        )
      }
      case 'custom': {
        if (hide('custom')) return null
        // Anything NOT already shown by a curated card above — AI-added or
        // manually-added widgets. Skip error/empty values so we never show a
        // broken card.
        const leftover = data.fields.filter((f) => {
          if (consumedIds.has(f.id)) return false
          const v = f.value
          return !(v && typeof v === 'object' && 'error' in v)
        })
        if (leftover.length === 0) return null
        return (
          <section className="section" key={id}>
            <SectionHead num={num} title="Custom widgets" />
            <div className="grid grid-cols-12 gap-4">
              {leftover.map((f) => (
                <div key={f.id} className={fieldSpanClass(f.type)}>
                  {f.type === 'big_number' ? <BigNumberCard field={f} />
                    : f.type === 'donut' ? <DonutCard field={f} />
                    : f.type === 'funnel' ? <FunnelCard field={f} />
                    : f.type === 'progress_bar' ? <ProgressBarCard field={f} />
                    : <FieldRenderer field={f} />}
                </div>
              ))}
            </div>
          </section>
        )
      }
      default:
        return null
    }
  }

  return (
    <div className="pub-root" style={accentStyle}>
      {/* ─── Top bar ─── */}
      <div className="topbar">
        <div className="topbar-inner">
          <div className="brand-mark">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
              {/* Convo AI nest logomark — the "V" shape on a brand-ink square,
                  matching the Claude Design bundle. Stroke goes back to the bg
                  color so the mark works in both light + dark themes. */}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="1" y="1" width="14" height="14" rx="3" fill="var(--d-fg)" />
                <path
                  d="M5 11 V5 L11 11 V5"
                  stroke="var(--bg)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
              Convo AI
            </span>
            <span className="crumb-sep">/</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <BrandLogo brand={brand} size="sm" />
              <span className="crumb-cur">{brandTitle}</span>
            </span>
          </div>
          <span className="live-chip">
            <span className="pulse" />
            Live
          </span>

          <div className="topbar-spacer" />

          <div className="share-pill" title="Shareable link for this client">
            <Glyph name="globe" size={13} />
            <span className="url">
              {window.location.host}/d/<span className="tok">{shareToken?.slice(0, 12)}…</span>
            </span>
            <button className={'copy' + (copied ? ' ok' : '')} onClick={copyShare}>
              {copied ? (
                <>
                  <Glyph name="check" size={11} />
                  Copied
                </>
              ) : (
                <>
                  <Glyph name="copy" size={11} />
                  Copy
                </>
              )}
            </button>
          </div>

          <ThemeToggle />
          <button
            className="icon-btn"
            title="Export PDF"
            onClick={() => window.print()}
          >
            <Glyph name="download" />
          </button>
        </div>
      </div>

      <div className="shell">
        {/* ─── Page head ─── */}
        <div className="page-head">
          <div className="page-head-lockup">
            {cfg.brand_logo_url ? (
              <span className="brand-logo size-lg">
                <img src={cfg.brand_logo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              </span>
            ) : (
              <BrandLogo brand={brand} size="lg" />
            )}
            <div className="page-head-text">
              <div className="eyebrow">
                <span>AI Concierge</span>
                <span className="sep">·</span>
                <span>Public dashboard</span>
              </div>
              <h1 className="h1">
                {brandTitle} <span className="sub">— conversational analytics</span>
              </h1>
              <div className="meta-row">
                <span className="meta">
                  <Glyph name="clock" size={12} />
                  <span>Last sync</span>
                  <strong className="mono" style={{ fontWeight: 500, fontSize: 12 }}>
                    {lastUpdated
                      ? lastUpdated.toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '—'}
                  </strong>
                </span>
                <span className="vsep" />
                <span className="meta">
                  <Glyph name="refresh" size={12} />
                  <span>Next refresh in</span>
                  <strong className="mono">00:{String(remainingSec).padStart(2, '0')}</strong>
                </span>
                <span className="vsep" />
                <span className="meta">
                  <span>Sources</span>
                  <strong>Sheets</strong>
                  <span style={{ color: 'var(--fg-4)' }}>·</span>
                  <strong>OpenAI</strong>
                </span>
              </div>
            </div>
          </div>
          <DateRangeControls value={window_} onChange={setWindow} />
        </div>

        {/* Magazine sections, rendered in the admin-configured order with
            section + per-card visibility applied. Default = full magazine. */}
        {orderedSections
          .filter((s) => s.visible)
          .map((s, i) => renderSection(s.id, s.hiddenCards ?? [], i + 1))}

        {/* Footer */}
        <footer className="pub-footer">
          <div>
            <span className="pulse" style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--live)', display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }} />
            Auto-refresh every 30s · next tick in{' '}
            <span className="mono">00:{String(remainingSec).padStart(2, '0')}</span>
          </div>
          <div>
            Powered by <span className="footer-brand">Next AI Lab</span> · Nexa Digital
            <span style={{ color: 'var(--fg-5)', margin: '0 10px' }}>·</span>
            <span className="mono">v2.4.0</span>
          </div>
        </footer>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Date range controls — 5 chips (1D · 7D · 30D · 90D · YTD) + custom button
// ─────────────────────────────────────────────────────────────────────
function DateRangeControls({
  value,
  onChange,
}: {
  value: Window
  onChange: (w: Window) => void
}) {
  const [open, setOpen] = useState(false)
  const [draftFrom, setDraftFrom] = useState<string>(
    value.kind === 'custom' ? value.from : isoDate(new Date(Date.now() - 13 * 86_400_000)),
  )
  const [draftTo, setDraftTo] = useState<string>(
    value.kind === 'custom' ? value.to : isoDate(new Date()),
  )

  // Close popover on outside click.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element
      if (!target.closest?.('[data-daterange]')) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  return (
    <div className="controls" data-daterange>
      <div className="seg">
        {PRESETS.map((p) => (
          <button
            key={p.days}
            className={value.kind === 'preset' && value.days === p.days ? 'active' : ''}
            onClick={() => onChange({ kind: 'preset', days: p.days })}
          >
            {p.chip}
          </button>
        ))}
        <button
          className={value.kind === 'ytd' ? 'active' : ''}
          onClick={() => onChange({ kind: 'ytd' })}
        >
          YTD
        </button>
        <button
          className={value.kind === 'all' ? 'active' : ''}
          onClick={() => onChange({ kind: 'all' })}
          title="All time — every conversation on record"
        >
          All
        </button>
      </div>
      <div style={{ position: 'relative' }}>
        <button className="date-btn" onClick={() => setOpen((s) => !s)}>
          <Glyph name="clock" size={13} />
          <span className="mono">{shortRangeLabel(value)}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {open && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              right: 0,
              zIndex: 50,
              width: 280,
              background: 'var(--d-surface)',
              border: '1px solid var(--d-border)',
              borderRadius: 8,
              padding: 12,
              boxShadow: '0 8px 24px -4px rgba(15,23,42,.12)',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--d-font-mono)',
                fontSize: 10.5,
                textTransform: 'uppercase',
                letterSpacing: '.06em',
                color: 'var(--fg-4)',
                marginBottom: 8,
              }}
            >
              Custom range
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>From</span>
                <input
                  type="date"
                  value={draftFrom}
                  onChange={(e) => setDraftFrom(e.target.value)}
                  style={{
                    height: 32,
                    padding: '0 8px',
                    border: '1px solid var(--d-border)',
                    background: 'var(--bg-muted)',
                    borderRadius: 4,
                    fontFamily: 'var(--d-font-mono)',
                    fontSize: 12,
                    color: 'var(--d-fg)',
                  }}
                />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>To</span>
                <input
                  type="date"
                  value={draftTo}
                  onChange={(e) => setDraftTo(e.target.value)}
                  style={{
                    height: 32,
                    padding: '0 8px',
                    border: '1px solid var(--d-border)',
                    background: 'var(--bg-muted)',
                    borderRadius: 4,
                    fontFamily: 'var(--d-font-mono)',
                    fontSize: 12,
                    color: 'var(--d-fg)',
                  }}
                />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              <button
                className="ghost-btn"
                style={{ flex: 1 }}
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <button
                className="ghost-btn primary"
                style={{ flex: 1 }}
                onClick={() => {
                  onChange({ kind: 'custom', from: draftFrom, to: draftTo })
                  setOpen(false)
                }}
              >
                Apply
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Section header
// ─────────────────────────────────────────────────────────────────────
function SectionHead({ num, title }: { num: number; title: string }) {
  // Subtitle removed per user request — the title is descriptive enough
  // on its own and the right-aligned `sub` left a huge dead gap on wide
  // screens. The prop signature stays back-compat (callers can still
  // pass `sub` and it'll be ignored) so the chaptered layout doesn't
  // break.
  void num // section numbers (§01/§02…) removed per user request
  return (
    <div className="sec-head">
      <h2 className="sec-title">{title}</h2>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// KPI ribbon
// ─────────────────────────────────────────────────────────────────────
function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (Math.abs(n) >= 10_000) return (n / 1_000).toFixed(1) + 'k'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n)
}

// Hover explanations for metrics whose logic clients ask about (per the
// 6/9 review with Mohsin: explain in-house guests + sentiment classification).
const FIELD_INFO: Record<string, string> = {
  in_house_guests:
    'Identified by keyword mapping — messages that mention a room number or in-stay keywords are flagged as in-house guests.',
  sentiment_gauge:
    'AI scores each message from -1 (negative) to +1 (positive); the gauge shows the average sentiment across all conversations.',
}

/** Small ⓘ icon with a hover tooltip explaining a metric's logic. */
function InfoTip({ text }: { text: string }) {
  return (
    <span
      className="info-tip"
      tabIndex={0}
      role="img"
      aria-label={text}
      title={text}
      style={{ display: 'inline-flex', verticalAlign: 'middle', marginLeft: 5, color: 'var(--fg-4)', cursor: 'help' }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    </span>
  )
}

function KPIRibbon({ metrics }: { metrics: PublicFieldValue[] }) {
  return (
    <div className="kpi-ribbon">
      {metrics.map((m, i) => {
        const v = m.value as MetricValue
        if (!v || typeof v !== 'object' || 'error' in v) return null
        // Delta direction: positive % is generally "good" for most KPIs,
        // BUT for response time + escalations, lower is better. Flip the
        // tone color in those cases so a -10% on response time reads as
        // green (an improvement), not red.
        const isLowerBetter =
          m.label.toLowerCase().includes('response') ||
          m.label.toLowerCase().includes('escalat')
        const delta = v.delta_pct ?? null
        const dir =
          delta == null
            ? 'neu'
            : isLowerBetter
              ? delta < 0
                ? 'pos'
                : delta > 0
                  ? 'neg'
                  : 'neu'
              : delta > 0
                ? 'pos'
                : delta < 0
                  ? 'neg'
                  : 'neu'
        const windowLabel = v.window_days ? `vs prev ${v.window_days}d` : v.sublabel || ''
        return (
          <div key={m.id} className={'kpi' + (i === 0 ? ' hero' : '')}>
            <div className="kpi-label">
              {KPI_LABEL_OVERRIDES[m.id] || m.label}
              {FIELD_INFO[m.id] && <InfoTip text={FIELD_INFO[m.id]} />}
            </div>
            <div className="kpi-value num">
              {fmt(v.value)}
              {v.unit && <span className="unit">{v.unit}</span>}
            </div>
            <div className="kpi-foot">
              {delta != null && (
                <span className={'kpi-delta ' + dir}>
                  {delta > 0 ? (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  ) : delta < 0 ? (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  ) : null}
                  {delta > 0 ? '+' : ''}
                  {delta.toFixed(1)}%
                </span>
              )}
              {windowLabel && <span className="kpi-vs">{windowLabel}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// MetricCard — standalone tile version of a KPIRibbon entry. Used by
// the new freeform grid (DashboardGrid) where each metric is its own
// draggable card instead of part of a joined ribbon. Same delta tone /
// hero-first / lower-is-better rules as KPIRibbon — just rewrapped in
// a `.pub-card` shell with its own border.
// ─────────────────────────────────────────────────────────────────────
function MetricCard({ field, hero = false }: { field: PublicFieldValue; hero?: boolean }) {
  const v = field.value as MetricValue
  if (!v || typeof v !== 'object' || 'error' in v) return null
  const isLowerBetter =
    field.label.toLowerCase().includes('response') ||
    field.label.toLowerCase().includes('escalat')
  const delta = v.delta_pct ?? null
  const dir =
    delta == null
      ? 'neu'
      : isLowerBetter
        ? delta < 0 ? 'pos' : delta > 0 ? 'neg' : 'neu'
        : delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'neu'
  const windowLabel = v.window_days ? `vs prev ${v.window_days}d` : v.sublabel || ''
  return (
    <div className={'pub-card kpi metric-tile' + (hero ? ' hero' : '')}>
      <div className="kpi-label">{KPI_LABEL_OVERRIDES[field.id] || field.label}</div>
      <div className="kpi-value num">
        {fmt(v.value)}
        {v.unit && <span className="unit">{v.unit}</span>}
      </div>
      <div className="kpi-foot">
        {delta != null && (
          <span className={'kpi-delta ' + dir}>
            {delta > 0 ? (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="18 15 12 9 6 15" />
              </svg>
            ) : delta < 0 ? (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            ) : null}
            {delta > 0 ? '+' : ''}
            {delta.toFixed(1)}%
          </span>
        )}
        {windowLabel && <span className="kpi-vs">{windowLabel}</span>}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Volume chart (area + crosshair on peak)
// ─────────────────────────────────────────────────────────────────────
function VolumeChart({ field }: { field: PublicFieldValue }) {
  const v = field.value as LineValue
  // hoverIdx is null when the cursor isn't over the chart → no crosshair, no
  // tooltip. Otherwise it's the index of the data point snapped to the
  // cursor's x position.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  if (!v?.points || v.points.length === 0) return null
  // Fill in any missing days between the min and max date in the dataset so the
  // line renders continuously instead of jumping across gaps (the raw backend
  // points are sparse — only days that had at least one chat appear). This
  // matches the v3 mock's "Last 14 days · daily totals" continuous curve.
  const points = densify(v.points)
  const prevPoints = v.previous_points ? densify(v.previous_points) : null
  const W = 720
  const H = 240
  const PAD_L = 36
  const PAD_R = 12
  const PAD_T = 12
  const PAD_B = 28
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  // Scale both periods on the same y-axis so they're directly comparable.
  const allYs = [...points.map((p) => p.y), ...(prevPoints?.map((p) => p.y) ?? [])]
  const maxRaw = Math.max(...allYs, 0)
  const max = maxRaw === 0 ? 1 : maxRaw * 1.1
  const step = innerW / Math.max(1, points.length - 1)
  const project = (pts: { y: number }[]): [number, number][] =>
    pts.map((p, i) => [
      PAD_L + i * step,
      PAD_T + innerH - (p.y / max) * innerH,
    ])
  const xy = project(points)
  const prevXy = prevPoints ? project(prevPoints.slice(0, points.length)) : null
  const toPath = (pts: [number, number][]) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const last = xy[xy.length - 1]
  const first = xy[0]
  const area = `${toPath(xy)} L${last[0]},${PAD_T + innerH} L${first[0]},${PAD_T + innerH} Z`

  // Gridlines (4 ticks)
  const gridYs = Array.from({ length: 5 }, (_, i) => PAD_T + (innerH * i) / 4)
  const tickValues = Array.from({ length: 5 }, (_, i) => Math.round(max - (max * i) / 4))

  // Peak emphasis on the CURRENT period (used for the aside stat row)
  const ys = points.map((p) => p.y)
  const peakIdx = ys.reduce((best, y, i) => (y > ys[best] ? i : best), 0)
  const peakLabel = shortLabel(points[peakIdx].x)
  // The crosshair + tooltip follow the cursor when hovering; nothing renders
  // when hoverIdx is null (initial state, and after the cursor leaves the
  // SVG). This matches the v3 design where the popup is hover-driven, not
  // pinned to the peak.
  const hp = hoverIdx != null ? xy[hoverIdx] : null
  const hoverLabel = hoverIdx != null ? shortLabel(points[hoverIdx].x) : ''
  const hoverValue = hoverIdx != null ? points[hoverIdx].y : 0

  // Map cursor x (in CSS pixels) to a SVG-space x (0..W) via the rendered
  // bounding box, then find the nearest data-point index. Using the SVG's
  // viewBox space — not the raw clientX — keeps snapping accurate even when
  // the chart is responsive-resized.
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const localPx = e.clientX - rect.left
    const svgX = (localPx / rect.width) * W
    // Clamp into the plot area and snap to the closest x position
    const clamped = Math.max(PAD_L, Math.min(W - PAD_R, svgX))
    const idx = Math.round((clamped - PAD_L) / step)
    const next = Math.max(0, Math.min(points.length - 1, idx))
    if (next !== hoverIdx) setHoverIdx(next)
  }
  const onLeave = () => setHoverIdx(null)

  const total = ys.reduce((s, y) => s + y, 0)
  const prevTotal = prevPoints
    ? prevPoints.reduce((s, p) => s + p.y, 0)
    : null
  const avg = Math.round(total / ys.length)
  const peakValue = points[peakIdx].y
  const periodDelta =
    prevTotal != null && prevTotal !== 0
      ? Math.round(((total - prevTotal) / prevTotal) * 1000) / 10
      : null

  return (
    <div className="pub-card">
      <div className="pub-card-head">
        <span className="t">{field.label}</span>
        <span className="sub">Daily totals</span>
      </div>
      <div className="pub-card-body">
        <div className="volume-wrap">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="chart-svg"
            preserveAspectRatio="none"
            onMouseMove={onMove}
            onMouseLeave={onLeave}
            style={{ cursor: 'crosshair' }}
          >
            <defs>
              <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.16" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {gridYs.map((y, i) => (
              <g key={i}>
                <line x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} className="chart-grid-line" />
                <text x={PAD_L - 8} y={y + 3} textAnchor="end" className="chart-axis-text">
                  {tickValues[i] >= 1000 ? `${(tickValues[i] / 1000).toFixed(1)}k` : tickValues[i]}
                </text>
              </g>
            ))}
            {points.map((p, i) => {
              // Show ~7 tick labels evenly across the x-axis, AND always
              // include the last point (otherwise the rightmost label drops
              // off — the user-visible bug where "May 22" rendered as "May 2"
              // when its position rounded down). The text is anchored 'end' on
              // the rightmost so it never overflows the chart edge.
              const stride = Math.max(1, Math.floor(points.length / 7))
              const isLast = i === points.length - 1
              const isFirst = i === 0
              if (!(isLast || isFirst || i % stride === 0)) return null
              return (
                <text
                  key={i}
                  x={PAD_L + i * step}
                  y={H - 8}
                  textAnchor={isLast ? 'end' : isFirst ? 'start' : 'middle'}
                  className="chart-axis-text"
                >
                  {shortLabel(p.x)}
                </text>
              )
            })}
            <path d={area} fill="url(#area-grad)" />
            {/* Previous-period dashed line — drawn UNDER the current line so
                the current period reads as the primary signal. */}
            {prevXy && prevXy.length > 1 && (
              <path d={toPath(prevXy)} className="chart-line dim" />
            )}
            <path d={toPath(xy)} className="chart-line" />
            {/* Crosshair + tooltip — rendered only while the cursor is over
                the SVG. The tooltip snaps to the nearest data point's x and
                clamps to the chart bounds so it never overflows the right
                edge. Mouse handlers live on the <svg>. */}
            {hp && (
              <>
                <line
                  x1={hp[0]}
                  x2={hp[0]}
                  y1={PAD_T}
                  y2={PAD_T + innerH}
                  className="chart-crosshair"
                />
                <circle cx={hp[0]} cy={hp[1]} r="4" className="chart-dot" />
                <g transform={`translate(${Math.min(hp[0] + 10, W - 130)}, ${Math.max(PAD_T, hp[1] - 28)})`}>
                  <rect width="120" height="34" rx="6" fill="var(--d-surface)" stroke="var(--border-strong)" />
                  <text
                    x="10"
                    y="14"
                    style={{ fontFamily: 'var(--d-font-mono)', fontSize: 9.5, fill: 'var(--fg-4)' }}
                  >
                    {hoverLabel.toUpperCase()}
                  </text>
                  <text
                    x="10"
                    y="28"
                    style={{ fontFamily: 'var(--d-font-mono)', fontSize: 11, fontWeight: 600, fill: 'var(--d-fg)' }}
                  >
                    {hoverValue.toLocaleString()} chats
                  </text>
                </g>
              </>
            )}
          </svg>
          <div className="volume-aside" style={{ borderLeft: '1px solid var(--d-border)' }}>
            <div className="aside-stat">
              <div className="l">Period total</div>
              <div className="v num">{fmt(total)}</div>
              <div className="d">
                {prevTotal != null ? (
                  <>
                    vs <span className="num">{fmt(prevTotal)}</span> previous
                    {periodDelta != null && (
                      <>
                        {' '}·{' '}
                        <span
                          style={{
                            color: periodDelta > 0 ? 'var(--pos)' : periodDelta < 0 ? 'var(--neg)' : 'var(--fg-4)',
                            fontFamily: 'var(--d-font-mono)',
                            fontWeight: 600,
                          }}
                        >
                          {periodDelta > 0 ? '+' : ''}
                          {periodDelta}%
                        </span>
                      </>
                    )}
                  </>
                ) : (
                  <>across {points.length} days</>
                )}
              </div>
            </div>
            <div className="aside-stat">
              <div className="l">Peak day</div>
              <div className="v num">{fmt(peakValue)}</div>
              <div className="d">{peakLabel}</div>
            </div>
            <div className="aside-stat">
              <div className="l">Average / day</div>
              <div className="v num">{fmt(avg)}</div>
              <div className="d">rolling window</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Gauge card (sentiment / resolution)
//
// Carries an optional 3-stat row beneath the dial: Self-resolved / Escalated
// / Abandoned. The numbers come from the surrounding metrics (totalChats +
// escWeek) because the gauge itself only carries a single scalar value.
// ─────────────────────────────────────────────────────────────────────
function GaugeCard({
  field,
  totalChats,
  escWeek,
}: {
  field: PublicFieldValue
  totalChats: PublicFieldValue | null
  escWeek: PublicFieldValue | null
}) {
  const v = field.value as GaugeValue
  if (!v) return null
  const range = v.max - v.min
  const pct = range === 0 ? 0 : (v.value - v.min) / range
  const clamped = Math.max(0, Math.min(1, pct))
  const cx = 100
  const cy = 100
  const rad = 80
  // Parameterize the upper semicircle going CLOCKWISE from theta=π (left, screen
  // 9 o'clock) through theta=3π/2 (top, screen 12 o'clock) to theta=2π (right,
  // screen 3 o'clock). In SVG y-down, increasing theta = clockwise on screen,
  // which traces the UPPER half of the circle for this start/end pair.
  const start = Math.PI
  const end = Math.PI * (1 + clamped)
  const x1 = cx + rad * Math.cos(start)
  const y1 = cy + rad * Math.sin(start)
  const x2 = cx + rad * Math.cos(end)
  const y2 = cy + rad * Math.sin(end)
  // large-arc-flag MUST be 0 — the fill arc is at most 180° (a semicircle),
  // never bigger, so we always want the small arc. The earlier `pct > 0.5 ? 1 : 0`
  // formula was wrong: it forced SVG to draw the LARGE 200°+ arc through the
  // bottom for any pct > 0.5, which then gets clipped outside the viewBox and
  // shows only as two line-cap fragments at the rim.
  const fullArc = `M ${cx - rad} ${cy} A ${rad} ${rad} 0 0 1 ${cx + rad} ${cy}`
  const fillArc = `M ${x1} ${y1} A ${rad} ${rad} 0 0 1 ${x2} ${y2}`

  // Sentiment-style (-1..+1) vs percentage-style (0..100)
  const isPct = v.min === 0 && v.max === 100
  const displayValue = isPct ? v.value.toFixed(0) : v.value.toFixed(2)
  const tone =
    !isPct && v.value > 0.2
      ? 'Positive'
      : !isPct && v.value < -0.2
        ? 'Negative'
        : !isPct
          ? 'Mixed'
          : null

  // Derive the 3-stat row from siblings — same shape as the v3 design's
  // Self-resolved / Escalated / Abandoned breakdown. We don't have a real
  // abandoned signal yet, so we leave it blank rather than fabricate one.
  const totalN = totalChats ? (totalChats.value as MetricValue).value : null
  const escN = escWeek ? (escWeek.value as MetricValue).value : null
  const selfN =
    typeof totalN === 'number' && typeof escN === 'number'
      ? Math.max(0, totalN - escN)
      : null

  return (
    <div className="pub-card">
      <div className="pub-card-head">
        <span className="t">
          {field.label}
          <InfoTip text={FIELD_INFO.sentiment_gauge} />
        </span>
        <span className="sub">{isPct ? '0–100%' : '-1.0 → +1.0'}</span>
      </div>
      <div className="gauge">
        {/* viewBox matches the design's 200×110 (clips the unused bottom half) */}
        <svg viewBox="0 0 200 110">
          <path d={fullArc} className="gauge-rail" />
          <path d={fillArc} className="gauge-fill" />
        </svg>
        <div style={{ marginTop: -28, textAlign: 'center' }}>
          <div className="v num">
            {displayValue}
            {isPct && <span className="pct">%</span>}
          </div>
          {tone && <div className="l">{tone}</div>}
        </div>
        {(selfN != null || escN != null) && (
          <div className="gauge-stat-row">
            <div>
              <div className="num">{selfN != null ? fmt(selfN) : '—'}</div>
              <div className="lbl">Self-resolved</div>
            </div>
            <div>
              <div className="num" style={{ color: 'var(--neg)' }}>
                {escN != null ? fmt(escN) : '—'}
              </div>
              <div className="lbl">Escalated</div>
            </div>
            <div>
              <div className="num">—</div>
              <div className="lbl">Abandoned</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Revenue card — primary AED amount, then a 3-row secondary strip with
// USD equivalent · Bookings closed · Avg ticket. Matches the v3 Convo AI
// Dashboard.html Booking-revenue tile in §02.
// ─────────────────────────────────────────────────────────────────────
function RevenueCard({
  primary,
  usd,
  bookings,
}: {
  primary: PublicFieldValue
  usd: PublicFieldValue | null
  bookings: PublicFieldValue | null
}) {
  const pv = primary.value as MetricValue
  if (!pv) return null
  const uv = usd ? (usd.value as MetricValue) : null
  const bv = bookings ? (bookings.value as MetricValue) : null
  const ticket =
    bv && pv && typeof bv.value === 'number' && bv.value > 0
      ? Math.round(pv.value / bv.value)
      : null

  return (
    <div className="pub-card">
      <div className="pub-card-head">
        <span className="t">Booking revenue</span>
        <span className="sub">attributed to AI</span>
      </div>
      <div className="rev-card">
        <div>
          <div
            style={{
              fontFamily: 'var(--d-font-mono)',
              fontSize: 10.5,
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--fg-4)',
              marginBottom: 6,
            }}
          >
            Primary ({pv.unit || 'AED'})
          </div>
          <div className="rev-primary">
            <span className="num">{pv.value.toLocaleString()}</span>
            <span className="ccy">{pv.unit || 'AED'}</span>
          </div>
        </div>
        <div className="rev-secondary">
          <div>
            USD equivalent
            <span className="v num">
              {uv ? `$${uv.value.toLocaleString()}` : '—'}
            </span>
          </div>
          <div>
            Bookings closed
            <span className="v num">{bv ? bv.value.toLocaleString() : '—'}</span>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            Avg ticket
            <span className="v num">
              {ticket != null ? `${ticket.toLocaleString()} ${pv.unit || 'AED'}` : '—'}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Escalation card — total handoffs + a stacked sentiment-at-handoff bar
// (positive / neutral / negative). Pulls from the three escalated_*
// metric fields the backend emits.
// ─────────────────────────────────────────────────────────────────────
function EscalationCard({
  total,
  pos,
  neu,
  neg,
}: {
  total: PublicFieldValue | null
  pos: PublicFieldValue | null
  neu: PublicFieldValue | null
  neg: PublicFieldValue | null
}) {
  const numOf = (f: PublicFieldValue | null): number => {
    if (!f) return 0
    const v = f.value as MetricValue
    return typeof v?.value === 'number' ? v.value : 0
  }
  const posN = numOf(pos)
  const neuN = numOf(neu)
  const negN = numOf(neg)
  const totalN = total ? numOf(total) : posN + neuN + negN
  const denom = posN + neuN + negN || 1
  const posPct = (posN / denom) * 100
  const neuPct = (neuN / denom) * 100
  const negPct = (negN / denom) * 100

  return (
    <div className="pub-card esc-card">
      <div className="pub-card-head" style={{ padding: 0, border: 0, marginBottom: 10 }}>
        <span className="t">Human escalations</span>
        <span className="sub">by sentiment at handoff</span>
      </div>
      <div className="esc-total">
        <span className="v num">{totalN}</span>
        <span className="l">handoffs to staff this week</span>
      </div>
      <div className="esc-stack">
        <div style={{ width: `${posPct}%`, background: 'var(--pos)' }} />
        <div style={{ width: `${neuPct}%`, background: 'var(--fg-4)' }} />
        <div style={{ width: `${negPct}%`, background: 'var(--neg)' }} />
      </div>
      <div className="esc-leg">
        <div>
          <span className="pip" style={{ background: 'var(--pos)' }} />
          Positive <strong>{posN}</strong>
        </div>
        <div>
          <span className="pip" style={{ background: 'var(--fg-4)' }} />
          Neutral <strong>{neuN}</strong>
        </div>
        <div>
          <span className="pip" style={{ background: 'var(--neg)' }} />
          Negative <strong>{negN}</strong>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Intent breakdown (stacked bar + legend)
// ─────────────────────────────────────────────────────────────────────
function IntentBreakdown({ field }: { field: PublicFieldValue }) {
  const v = field.value as PieValue
  if (!v?.slices) return null
  const total = v.slices.reduce((s, x) => s + x.value, 0) || 1
  const COLORS = ['var(--accent)', '#6366f1', '#0891b2', '#ca8a04', '#db2777', '#65a30d']
  return (
    <div className="pub-card">
      <div className="pub-card-head">
        <span className="t">{field.label}</span>
        <span className="sub">{total.toLocaleString()} chats</span>
      </div>
      <div className="pub-card-body">
        <div className="intent-stack">
          {v.slices.map((s, i) => (
            <div
              key={s.label}
              style={{
                width: `${(s.value / total) * 100}%`,
                background: COLORS[i % COLORS.length],
              }}
              title={`${s.label}: ${(s.pct ?? (s.value / total) * 100).toFixed(1)}%`}
            />
          ))}
        </div>
        <div>
          {v.slices.map((s, i) => (
            <div key={s.label} className="intent-row">
              <span className="intent-pip" style={{ background: COLORS[i % COLORS.length] }} />
              <span className="label">{s.label}</span>
              <span className="pct">{(s.pct ?? (s.value / total) * 100).toFixed(1)}%</span>
              <span className="n">{s.value.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Topics
// ─────────────────────────────────────────────────────────────────────
function TopicsCard({ field }: { field: PublicFieldValue }) {
  const v = field.value as TagCloudValue
  if (!v?.tags || v.tags.length === 0) return null
  const max = Math.max(...v.tags.map((t) => t.weight), 1)
  return (
    <div className="pub-card">
      <div className="pub-card-head">
        <span className="t">{field.label}</span>
        <span className="sub">AI-extracted · {v.tags.length} tags</span>
      </div>
      <div className="topics">
        {v.tags.map((t) => {
          const scale = 0.85 + (t.weight / max) * 0.6
          return (
            <span key={t.label} className="topic-chip" style={{ fontSize: `${12 * scale}px` }}>
              {t.label}
              <span className="n">{t.weight}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Geo map — hand-drawn world with country bubbles
// ─────────────────────────────────────────────────────────────────────

/** Lookup table: country name OR ISO 3166-1 alpha-2 code (case-insensitive)
 *  → [lat, lng]. Covers both representations because the backend emits ISO
 *  codes from GA4 (AE, US, GB…) AND full names from chat-row country fields.
 *  Same approach as the design's countries array — values are stable so
 *  bubbles don't shift between renders. */
const COUNTRY_LATLNG: Record<string, [number, number]> = {
  // GCC + MENA
  'ae': [24.5, 54.5], 'uae': [24.5, 54.5], 'united arab emirates': [24.5, 54.5],
  'sa': [24.0, 45.0], 'saudi arabia': [24.0, 45.0], 'saudi': [24.0, 45.0],
  'kw': [29.3, 47.5], 'kuwait': [29.3, 47.5],
  'qa': [25.3, 51.2], 'qatar': [25.3, 51.2],
  'om': [21.0, 56.0], 'oman': [21.0, 56.0],
  'bh': [26.0, 50.6], 'bahrain': [26.0, 50.6],
  'jo': [31.3, 36.0], 'jordan': [31.3, 36.0],
  'lb': [33.9, 35.9], 'lebanon': [33.9, 35.9],
  'eg': [27.0, 30.0], 'egypt': [27.0, 30.0],
  'iq': [33.2, 43.7], 'iraq': [33.2, 43.7],
  'ir': [32.4, 53.7], 'iran': [32.4, 53.7],
  'sy': [34.8, 38.9], 'syria': [34.8, 38.9],
  'ye': [15.6, 48.5], 'yemen': [15.6, 48.5],
  'tr': [39.0, 35.0], 'turkey': [39.0, 35.0], 'türkiye': [39.0, 35.0],
  'il': [31.0, 34.9], 'israel': [31.0, 34.9],
  'ps': [31.9, 35.2], 'palestine': [31.9, 35.2],
  // Africa
  'ma': [31.7, -7.0], 'morocco': [31.7, -7.0],
  'tn': [33.9, 9.5], 'tunisia': [33.9, 9.5],
  'dz': [28.0, 1.7], 'algeria': [28.0, 1.7],
  'ly': [26.3, 17.2], 'libya': [26.3, 17.2],
  'sd': [12.9, 30.2], 'sudan': [12.9, 30.2],
  'za': [-30.6, 22.9], 'south africa': [-30.6, 22.9],
  'ng': [9.1, 8.7], 'nigeria': [9.1, 8.7],
  'ke': [-0.0, 37.9], 'kenya': [-0.0, 37.9],
  'ug': [1.4, 32.3], 'uganda': [1.4, 32.3],
  'et': [9.1, 40.5], 'ethiopia': [9.1, 40.5],
  'gh': [7.9, -1.0], 'ghana': [7.9, -1.0],
  'tz': [-6.4, 34.9], 'tanzania': [-6.4, 34.9],
  // Europe + UK
  'gb': [54.0, -2.0], 'uk': [54.0, -2.0], 'united kingdom': [54.0, -2.0],
  'de': [51.2, 10.5], 'germany': [51.2, 10.5],
  'fr': [46.6, 2.5], 'france': [46.6, 2.5],
  'it': [41.9, 12.6], 'italy': [41.9, 12.6],
  'es': [40.5, -3.7], 'spain': [40.5, -3.7],
  'nl': [52.1, 5.3], 'netherlands': [52.1, 5.3],
  'pt': [39.4, -8.2], 'portugal': [39.4, -8.2],
  'ie': [53.4, -8.2], 'ireland': [53.4, -8.2],
  'be': [50.5, 4.5], 'belgium': [50.5, 4.5],
  'ch': [46.8, 8.2], 'switzerland': [46.8, 8.2],
  'at': [47.5, 14.6], 'austria': [47.5, 14.6],
  'se': [60.1, 18.6], 'sweden': [60.1, 18.6],
  'no': [60.5, 8.5], 'norway': [60.5, 8.5],
  'dk': [56.3, 9.5], 'denmark': [56.3, 9.5],
  'fi': [61.9, 25.7], 'finland': [61.9, 25.7],
  'pl': [51.9, 19.1], 'poland': [51.9, 19.1],
  'gr': [39.1, 21.8], 'greece': [39.1, 21.8],
  'cz': [49.8, 15.5], 'czech republic': [49.8, 15.5], 'czechia': [49.8, 15.5],
  'ro': [45.9, 24.9], 'romania': [45.9, 24.9],
  'hu': [47.2, 19.5], 'hungary': [47.2, 19.5],
  'ua': [48.4, 31.2], 'ukraine': [48.4, 31.2],
  // Asia
  'in': [22.0, 78.9], 'india': [22.0, 78.9],
  'pk': [30.4, 69.3], 'pakistan': [30.4, 69.3],
  'bd': [23.7, 90.4], 'bangladesh': [23.7, 90.4],
  'lk': [7.9, 80.8], 'sri lanka': [7.9, 80.8],
  'np': [28.4, 84.1], 'nepal': [28.4, 84.1],
  'cn': [35.9, 104.2], 'china': [35.9, 104.2],
  'jp': [36.2, 138.3], 'japan': [36.2, 138.3],
  'kr': [36.0, 127.8], 'south korea': [36.0, 127.8],
  'tw': [23.7, 121.0], 'taiwan': [23.7, 121.0],
  'hk': [22.3, 114.2], 'hong kong': [22.3, 114.2],
  'ph': [13.0, 122.0], 'philippines': [13.0, 122.0],
  'th': [15.9, 101.0], 'thailand': [15.9, 101.0],
  'my': [4.2, 101.9], 'malaysia': [4.2, 101.9],
  'id': [-0.8, 113.9], 'indonesia': [-0.8, 113.9],
  'sg': [1.3, 103.8], 'singapore': [1.3, 103.8],
  'vn': [14.1, 108.3], 'vietnam': [14.1, 108.3],
  'kz': [48.0, 66.9], 'kazakhstan': [48.0, 66.9],
  'uz': [41.4, 64.6], 'uzbekistan': [41.4, 64.6],
  'af': [33.9, 67.7], 'afghanistan': [33.9, 67.7],
  // Americas
  'us': [39.0, -97.0], 'usa': [39.0, -97.0], 'united states': [39.0, -97.0],
  'ca': [56.1, -106.0], 'canada': [56.1, -106.0],
  'mx': [23.6, -102.5], 'mexico': [23.6, -102.5],
  'br': [-14.2, -51.9], 'brazil': [-14.2, -51.9],
  'ar': [-38.4, -63.6], 'argentina': [-38.4, -63.6],
  'cl': [-35.7, -71.5], 'chile': [-35.7, -71.5],
  'co': [4.6, -74.3], 'colombia': [4.6, -74.3],
  'pe': [-9.2, -75.0], 'peru': [-9.2, -75.0],
  // Oceania
  'au': [-25.7, 134.5], 'australia': [-25.7, 134.5],
  'nz': [-41.0, 171.8], 'new zealand': [-41.0, 171.8],
  // Russia + CIS
  'ru': [61.5, 105.3], 'russia': [61.5, 105.3],
  'by': [53.7, 27.9], 'belarus': [53.7, 27.9],
  'ge': [42.3, 43.4], 'georgia': [42.3, 43.4],
  'am': [40.1, 45.0], 'armenia': [40.1, 45.0],
  'az': [40.1, 47.6], 'azerbaijan': [40.1, 47.6],
}

/** ISO 3166-1 alpha-2 → display name. Used so the map callout reads
 *  "United Arab Emirates" instead of the bare "AE" code. Falls back to
 *  whatever the backend sent when there's no entry. */
const COUNTRY_NAME: Record<string, string> = {
  AE: 'United Arab Emirates', SA: 'Saudi Arabia', KW: 'Kuwait', QA: 'Qatar',
  OM: 'Oman', BH: 'Bahrain', JO: 'Jordan', LB: 'Lebanon', EG: 'Egypt',
  IQ: 'Iraq', IR: 'Iran', SY: 'Syria', YE: 'Yemen', TR: 'Turkey',
  IL: 'Israel', PS: 'Palestine',
  MA: 'Morocco', TN: 'Tunisia', DZ: 'Algeria', LY: 'Libya', SD: 'Sudan',
  ZA: 'South Africa', NG: 'Nigeria', KE: 'Kenya', UG: 'Uganda',
  ET: 'Ethiopia', GH: 'Ghana', TZ: 'Tanzania',
  GB: 'United Kingdom', UK: 'United Kingdom', DE: 'Germany', FR: 'France',
  IT: 'Italy', ES: 'Spain', NL: 'Netherlands', PT: 'Portugal', IE: 'Ireland',
  BE: 'Belgium', CH: 'Switzerland', AT: 'Austria', SE: 'Sweden',
  NO: 'Norway', DK: 'Denmark', FI: 'Finland', PL: 'Poland', GR: 'Greece',
  CZ: 'Czech Republic', RO: 'Romania', HU: 'Hungary', UA: 'Ukraine',
  IN: 'India', PK: 'Pakistan', BD: 'Bangladesh', LK: 'Sri Lanka',
  NP: 'Nepal', CN: 'China', JP: 'Japan', KR: 'South Korea',
  TW: 'Taiwan', HK: 'Hong Kong', PH: 'Philippines', TH: 'Thailand',
  MY: 'Malaysia', ID: 'Indonesia', SG: 'Singapore', VN: 'Vietnam',
  KZ: 'Kazakhstan', UZ: 'Uzbekistan', AF: 'Afghanistan',
  US: 'United States', CA: 'Canada', MX: 'Mexico', BR: 'Brazil',
  AR: 'Argentina', CL: 'Chile', CO: 'Colombia', PE: 'Peru',
  AU: 'Australia', NZ: 'New Zealand',
  RU: 'Russia', BY: 'Belarus', GE: 'Georgia', AM: 'Armenia', AZ: 'Azerbaijan',
}

function latLngFor(name: string): [number, number] | null {
  const k = name.toLowerCase().trim()
  return COUNTRY_LATLNG[k] ?? null
}

/** Expand an ISO code to its display name; pass-through for full names. */
function displayCountry(raw: string): string {
  const up = raw.trim().toUpperCase()
  return COUNTRY_NAME[up] || raw
}

function GeoCard({
  mapField,
  countryBar,
  accent,
}: {
  mapField: PublicFieldValue | null
  countryBar: PublicFieldValue | null
  accent: string
}) {
  // Prefer the map widget's points if backend provided them; fall back to
  // the country bar (label → lookup → lat/lng). Either way we end up with
  // a list of {label, lat, lng, n} to project as bubbles.
  type Point = { label: string; lat: number; lng: number; n: number }
  let points: Point[] = []
  let total = 0
  let title = mapField?.label ?? countryBar?.label ?? 'Guest origin'

  if (mapField) {
    const v = mapField.value as MapValue
    if (v?.points) {
      for (const p of v.points) {
        const ll = latLngFor(p.country)
        if (ll) points.push({ label: displayCountry(p.country), lat: ll[0], lng: ll[1], n: p.value })
      }
      // Use the BACKEND's `total` as the headline ("109 signals") — it
      // counts every country, including any we couldn't geocode. The fall-
      // back sums only the geocoded ones (legacy behavior).
      total = v.total ?? points.reduce((s, p) => s + p.n, 0)
    }
  }
  if (points.length === 0 && countryBar) {
    const v = countryBar.value as BarValue
    if (v?.bars) {
      for (const b of v.bars) {
        const ll = latLngFor(b.label)
        if (ll) points.push({ label: displayCountry(b.label), lat: ll[0], lng: ll[1], n: b.value })
      }
      total = v.bars.reduce((s, b) => s + b.value, 0)
    }
  }

  const max = Math.max(...points.map((p) => p.n), 1)
  const topCountry = points.slice().sort((a, b) => b.n - a.n)[0] ?? null
  const intlShare =
    total > 0 && topCountry
      ? Math.round(((total - topCountry.n) / total) * 1000) / 10
      : null

  // Bubble sizing: linear scale, but in PIXEL radii (Leaflet's CircleMarker
  // uses pixel radius, not km radius — so the bubbles stay the same visual
  // size regardless of zoom level, matching the Looker-Studio reference).
  const bubbleRadius = (n: number) => 5 + (n / max) * 22

  return (
    <div className="pub-card map-card">
      <div className="pub-card-head">
        <span className="t">{title}</span>
        <span className="sub">
          {fmt(total)} {total === 1 ? 'signal' : 'signals'} · {points.length}{' '}
          {points.length === 1 ? 'country' : 'countries'}
        </span>
      </div>
      <div className="map-svg" style={{ position: 'relative' }}>
        {/* Real Google-Maps-look tiled basemap via Leaflet. CartoDB Positron
            is the same light-gray ramp Google uses for their "lighter" basemap,
            but is free + open under OSM-derived data. No API key needed.
            Scroll-wheel zoom is enabled per user request — drag-to-pan + scroll-
            to-zoom both work, matching the Google Maps interaction model. */}
        <MapContainer
          center={topCountry ? [topCountry.lat, topCountry.lng] : [20, 10]}
          zoom={topCountry ? 3 : 2}
          minZoom={2}
          maxZoom={8}
          worldCopyJump
          scrollWheelZoom
          zoomControl={false}
          attributionControl={false}
          style={{ width: '100%', height: 420, background: 'var(--bg-muted)' }}
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
            subdomains={['a', 'b', 'c', 'd']}
            // Required attribution — Carto's TOS, blends into the corner via
            // CSS .leaflet-control-attribution.
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          />
          <ZoomControl position="bottomright" />
          {points.map((p) => (
            <CircleMarker
              key={`${p.label}-${p.lat}-${p.lng}`}
              center={[p.lat, p.lng]}
              radius={bubbleRadius(p.n)}
              pathOptions={{
                color: accent,
                fillColor: accent,
                fillOpacity: 0.55,
                opacity: 0.85,
                weight: 1.5,
              }}
              eventHandlers={{
                mouseover: (e) => e.target.setStyle({ fillOpacity: 0.85 }),
                mouseout:  (e) => e.target.setStyle({ fillOpacity: 0.55 }),
              }}
            >
              {/* Leaflet tooltip — sticky=true so it follows the cursor; the
                  CSS in admin.css restyles `.leaflet-tooltip` to match the
                  volume-chart tooltip's mono uppercase / value-line look. */}
              <Tooltip direction="top" offset={[0, -bubbleRadius(p.n)]} sticky>
                <div className="map-tip">
                  <div className="map-tip-l">{p.label}</div>
                  <div className="map-tip-v">
                    {p.n.toLocaleString()} {p.n === 1 ? 'chat' : 'chats'}
                  </div>
                </div>
              </Tooltip>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>
      <div className="map-meta">
        {topCountry && (
          <>
            <span>
              Primary market <strong>{topCountry.label}</strong>
            </span>
            {intlShare != null && (
              <>
                <span style={{ color: 'var(--fg-4)' }}>·</span>
                <span>
                  International share <strong>{intlShare}%</strong>
                </span>
              </>
            )}
          </>
        )}
        <span style={{ marginLeft: 'auto' }} className="mono">
          {fmt(total)} total
        </span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Ranked list (Languages / Countries / etc.)
// ─────────────────────────────────────────────────────────────────────
function RankedCard({
  field,
  title,
  showPct,
}: {
  field: PublicFieldValue
  title: string
  showPct?: boolean
}) {
  const v = field.value as BarValue
  if (!v?.bars || v.bars.length === 0) return null
  const total = v.bars.reduce((s, b) => s + b.value, 0) || 1
  const max = Math.max(...v.bars.map((b) => b.value), 1)
  return (
    <div className="pub-card">
      <div className="pub-card-head">
        <span className="t">{title}</span>
      </div>
      <div className="ranked">
        {v.bars.slice(0, 8).map((b, i) => {
          const pct = (b.value / total) * 100
          return (
            <div key={b.label} className="ranked-row">
              <span className="rk">{String(i + 1).padStart(2, '0')}</span>
              <span className="l">{b.label}</span>
              <div className="bar">
                <div style={{ width: `${(b.value / max) * 100}%` }} />
              </div>
              <span className="v">{showPct ? `${pct.toFixed(0)}%` : b.value.toLocaleString()}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Recent conversations table
// ─────────────────────────────────────────────────────────────────────
const ARABIC_RE = /[؀-ۿ]/

function RecentTable({ field }: { field: PublicFieldValue }) {
  const v = field.value as TableValue
  if (!v?.rows || v.rows.length === 0) return null

  return (
    <div className="pub-card">
      <div className="pub-card-head">
        <span className="t">{field.label}</span>
        <span className="sub">{v.rows.length} rows · newest first</span>
      </div>
      <table className="pub-table">
        <thead>
          <tr>
            {v.columns.map((c) => (
              <th key={c}>{c.replace(/_/g, ' ')}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {v.rows.map((row, i) => (
            <tr key={i}>
              {v.columns.map((c) => {
                const raw = row[c]
                if (c === 'ai_sentiment' && typeof raw === 'string') {
                  const cls = raw === 'positive' ? 'pos' : raw === 'negative' ? 'neg' : 'neu'
                  return (
                    <td key={c}>
                      <span className={`sent`}>
                        <span className={`pip ${cls}`} />
                        {raw}
                      </span>
                    </td>
                  )
                }
                if (c === 'ai_intent' && typeof raw === 'string') {
                  const cls = raw === 'praise' ? 'pos' : raw === 'complaint' ? 'neg' : 'neu'
                  return (
                    <td key={c}>
                      <span className={`pill ${cls}`}>{raw}</span>
                    </td>
                  )
                }
                if (c === 'status' && typeof raw === 'string') {
                  // Status pill colors per the PDF design:
                  // escalated → warn (orange), converted → pos (green), resolved → neu (gray)
                  const cls =
                    raw === 'converted'
                      ? 'pos'
                      : raw === 'escalated'
                        ? 'warn'
                        : 'neu'
                  return (
                    <td key={c}>
                      <span className={`pill ${cls}`}>{raw}</span>
                    </td>
                  )
                }
                if (c === 'Message' && typeof raw === 'string') {
                  const isArabic = ARABIC_RE.test(raw)
                  return (
                    <td
                      key={c}
                      style={
                        isArabic
                          ? { direction: 'rtl', textAlign: 'right', maxWidth: 520 }
                          : { maxWidth: 520 }
                      }
                    >
                      <span className="guest">{raw}</span>
                    </td>
                  )
                }
                if (c === 'Timestamp' && typeof raw === 'string') {
                  const d = new Date(raw)
                  return (
                    <td key={c}>
                      <span className="ts">
                        {!isNaN(d.getTime())
                          ? d.toLocaleString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : raw}
                      </span>
                    </td>
                  )
                }
                return (
                  <td key={c}>
                    {raw == null || raw === '' ? <span style={{ color: 'var(--fg-4)' }}>—</span> : String(raw)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Custom widgets (big_number, donut, funnel, progress_bar)
// ─────────────────────────────────────────────────────────────────────
function BigNumberCard({ field }: { field: PublicFieldValue }) {
  const v = field.value as BigNumberValue
  if (!v) return null
  const spark = v.sparkline ?? []
  const max = spark.length ? Math.max(...spark, 1) : 1
  return (
    <div className="pub-card" style={{ padding: '20px 22px' }}>
      <div className="kpi-label">{field.label}</div>
      <div className="kpi-value num" style={{ fontSize: 44, marginTop: 6 }}>
        {fmt(v.value)}
        {v.unit && <span className="unit">{v.unit}</span>}
      </div>
      {v.delta_pct != null && (
        <div style={{ marginTop: 8, fontSize: 12, color: v.delta_pct >= 0 ? 'var(--pos)' : 'var(--neg)', fontFamily: 'var(--d-font-mono)' }}>
          {v.delta_pct > 0 ? '+' : ''}{v.delta_pct.toFixed(1)}% vs prev
        </div>
      )}
      {spark.length > 1 && (
        <svg viewBox={`0 0 ${spark.length * 8} 28`} preserveAspectRatio="none" style={{ width: '100%', height: 28, marginTop: 12 }}>
          <path
            d={spark.map((y, i) => `${i === 0 ? 'M' : 'L'}${i * 8},${28 - (y / max) * 26}`).join(' ')}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      )}
    </div>
  )
}

function DonutCard({ field }: { field: PublicFieldValue }) {
  const v = field.value as DonutValue
  if (!v?.slices?.length) return null
  const COLORS = ['var(--accent)', '#6366f1', '#0891b2', '#ca8a04', '#db2777', '#65a30d']
  // Build an SVG donut from cumulative arc lengths
  const r = 56, cx = 70, cy = 70, circ = 2 * Math.PI * r
  let offset = 0
  return (
    <div className="pub-card">
      <div className="pub-card-head">
        <span className="t">{field.label}</span>
        <span className="sub">{v.total.toLocaleString()} total</span>
      </div>
      <div style={{ display: 'flex', gap: 18, padding: 18, alignItems: 'center' }}>
        <svg viewBox="0 0 140 140" width="140" height="140" style={{ flexShrink: 0 }}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--bg-muted)" strokeWidth="16" />
          {v.slices.map((s, i) => {
            const len = (s.value / v.total) * circ
            const el = (
              <circle
                key={s.label}
                cx={cx} cy={cy} r={r}
                fill="none"
                stroke={COLORS[i % COLORS.length]}
                strokeWidth="16"
                strokeDasharray={`${len} ${circ - len}`}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${cx} ${cy})`}
              />
            )
            offset += len
            return el
          })}
          <text x={cx} y={cy - 4} textAnchor="middle" style={{ fontSize: 18, fontWeight: 600, fill: 'var(--d-fg)' }}>
            {v.total.toLocaleString()}
          </text>
          <text x={cx} y={cy + 14} textAnchor="middle" style={{ fontSize: 9, fontFamily: 'var(--d-font-mono)', fill: 'var(--fg-4)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {v.center_label || 'total'}
          </text>
        </svg>
        <div style={{ flex: 1, minWidth: 0 }}>
          {v.slices.slice(0, 6).map((s, i) => (
            <div key={s.label} className="intent-row">
              <span className="intent-pip" style={{ background: COLORS[i % COLORS.length] }} />
              <span className="label">{s.label}</span>
              <span className="pct">{s.pct.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function FunnelCard({ field }: { field: PublicFieldValue }) {
  const v = field.value as FunnelValue
  if (!v?.stages?.length) return null
  return (
    <div className="pub-card">
      <div className="pub-card-head">
        <span className="t">{field.label}</span>
        <span className="sub">{v.stages.length} stages</span>
      </div>
      <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {v.stages.map((s, i) => (
          <div key={s.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
              <span style={{ color: 'var(--d-fg)', fontWeight: 500 }}>{s.label}</span>
              <span className="mono" style={{ color: 'var(--fg-3)' }}>
                {s.value.toLocaleString()}
                <span style={{ color: 'var(--fg-4)', marginLeft: 8 }}>
                  {s.pct_of_top.toFixed(0)}%
                </span>
              </span>
            </div>
            <div style={{ height: 8, background: 'var(--bg-muted)', borderRadius: 4, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${s.pct_of_top}%`,
                  height: '100%',
                  background: 'var(--accent)',
                  opacity: 1 - i * 0.12,
                  transition: 'width 220ms ease',
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ProgressBarCard({ field }: { field: PublicFieldValue }) {
  const v = field.value as ProgressBarValue
  if (!v) return null
  const meetsTarget = v.direction === 'lower_is_better' ? v.value <= v.target : v.value >= v.target
  return (
    <div className="pub-card" style={{ padding: '18px 20px' }}>
      <div className="kpi-label">{field.label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
        <span className="kpi-value num" style={{ fontSize: 28 }}>{fmt(v.value)}</span>
        {v.unit && <span className="unit" style={{ fontSize: 12, color: 'var(--fg-3)' }}>{v.unit}</span>}
        <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-4)' }}>
          target {fmt(v.target)}{v.unit ? ' ' + v.unit : ''}
        </span>
      </div>
      <div style={{ height: 8, background: 'var(--bg-muted)', borderRadius: 4, overflow: 'hidden', marginTop: 12 }}>
        <div
          style={{
            width: `${v.pct}%`,
            height: '100%',
            background: meetsTarget ? 'var(--pos)' : 'var(--accent)',
            transition: 'width 220ms ease',
          }}
        />
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--d-font-mono)' }}>
        {v.pct.toFixed(0)}% of target {meetsTarget ? '· met ✓' : ''}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Theme toggle (light/dark)
// ─────────────────────────────────────────────────────────────────────
function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'light'
  })
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('convo-ai-theme', theme)
  }, [theme])
  return (
    <button
      className="icon-btn"
      title="Toggle theme"
      onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
    >
      <Glyph name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Inline glyphs
// ─────────────────────────────────────────────────────────────────────
function Glyph({ name, size = 14 }: { name: string; size?: number }) {
  const p: React.SVGProps<SVGSVGElement> = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }
  switch (name) {
    case 'clock':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      )
    case 'refresh':
      return (
        <svg {...p}>
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
      )
    case 'copy':
      return (
        <svg {...p}>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )
    case 'check':
      return (
        <svg {...p}>
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )
    case 'globe':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      )
    case 'moon':
      return (
        <svg {...p}>
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )
    case 'sun':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      )
    case 'download':
      return (
        <svg {...p}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      )
    default:
      return null
  }
}

// ─────────────────────────────────────────────────────────────────────
// Loading / error states
// ─────────────────────────────────────────────────────────────────────
function LoadingState({ style }: { style: AccentStyle }) {
  // Cycle the eyebrow status through three stages so the loader feels alive
  // instead of frozen. Pure presentational — doesn't gate on real network
  // events, just gives the user something to read while React Query fetches.
  const [stage, setStage] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setStage((s) => (s + 1) % 3), 1100)
    return () => clearInterval(id)
  }, [])
  const phases = ['Connecting to Convo AI', 'Fetching dashboard config', 'Aggregating chat rows']
  return (
    <div className="pub-root pub-loading" style={style}>
      <div className="pub-loading-card">
        {/* Concentric pulsing rings in the accent color — the only piece
            of motion on the page, matches the v3 register (no spinners,
            no skeletons, just a hairline pulse). */}
        <div className="pub-loading-rings" aria-hidden>
          <span className="ring ring-1" />
          <span className="ring ring-2" />
          <span className="ring ring-3" />
          <span className="ring-core" />
        </div>
        <div className="pub-loading-eyebrow">
          <span className="dot" />
          {phases[stage]}…
        </div>
        <div className="pub-loading-title">Loading your dashboard</div>
        <div className="pub-loading-meta">
          <span className="mono">v2.4.0</span>
          <span className="sep">·</span>
          <span>Powered by Next AI Lab</span>
        </div>
      </div>
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="pub-root">
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ textAlign: 'center', maxWidth: 380 }}>
          <div className="eyebrow" style={{ justifyContent: 'center', marginBottom: 12 }}>
            Dashboard unavailable
          </div>
          <h1
            style={{
              fontSize: 24,
              fontWeight: 600,
              letterSpacing: '-0.025em',
              margin: '0 0 8px',
            }}
          >
            We couldn't load this view.
          </h1>
          <p style={{ fontSize: 13, color: 'var(--fg-3)', margin: '0 0 16px' }}>{message}</p>
          <button className="ghost-btn primary" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────
/** Fill in missing days between the first and last point so the volume chart
 *  renders a continuous line instead of jumping across gaps. Days that had no
 *  chat activity in the seed data come back as y=0 — visually identical to
 *  "no rows that day", but the line stays continuous (matches v3's
 *  "Last 7/14 days · daily totals" smooth curve).
 *
 *  Only operates on date-like x values (YYYY-MM-DD or ISO timestamps). For
 *  non-date series (e.g. GA4 source pageviews labelled by hour), the function
 *  bails out and returns the original array untouched. */
function densify(points: { x: string; y: number }[]): { x: string; y: number }[] {
  if (points.length < 2) return points
  // Need every x to parse as a date for densification to make sense.
  const dated = points.map((p) => {
    const iso = p.x.length >= 10 ? p.x.slice(0, 10) : p.x
    const d = new Date(iso + 'T00:00:00Z')
    return { iso, d, y: p.y }
  })
  if (dated.some((p) => isNaN(p.d.getTime()))) return points
  const sorted = [...dated].sort((a, b) => a.d.getTime() - b.d.getTime())
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const byIso = new Map(sorted.map((p) => [p.iso, p.y]))
  const out: { x: string; y: number }[] = []
  const cursor = new Date(first.d)
  const DAY = 86_400_000
  while (cursor.getTime() <= last.d.getTime()) {
    const iso = cursor.toISOString().slice(0, 10)
    out.push({ x: iso, y: byIso.get(iso) ?? 0 })
    cursor.setTime(cursor.getTime() + DAY)
  }
  return out
}

/** Strip the seed's operator-prefix ("Chat Export - ") and any trailing date
 *  suffix from a dashboard name so the page title reads cleanly. */
function cleanDashboardName(name: string): string {
  let out = name
  // Drop the "Chat Export - " operator prefix (the seed adds it for every
  // dashboard generated from a sheets export).
  out = out.replace(/^chat export\s*-\s*/i, '')
  // Drop a trailing " - YYYY-MM-DD" date suffix.
  out = out.replace(/\s*-\s*\d{4}-\d{2}-\d{2}\s*$/, '')
  return out.trim() || name
}

/** Map known KPI field IDs to the short labels the v3 design uses
 *  ("AVERAGE RESPONSE TIME" → "AVG RESPONSE"). Falls through to the raw
 *  label when the ID isn't in the table so admin-defined custom metrics
 *  still display whatever the operator typed. */
const KPI_LABEL_OVERRIDES: Record<string, string> = {
  total_chats:          'Total chats',
  unique_users:         'Unique users',
  user_messages:        'User messages',
  avg_interactions:     'Avg interactions',
  avg_response_time:    'Avg response',
  in_house_guests:      'In-house guests',
  booking_links_shared: 'Booking links',
  revenue_aed:          'Revenue (AED)',
  revenue_usd:          'Revenue (USD)',
  total_bookings:       'Bookings',
  chats_today:          'Chats today',
  chats_week:           'Chats · 7d',
  chats_month:          'Chats · 30d',
  escalations_week:     'Escalations · 7d',
}

function shortLabel(x: string): string {
  const iso = x.length >= 10 ? x.slice(0, 10) : null
  const d = iso ? new Date(iso) : null
  if (d && !isNaN(d.getTime())) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  return x
}
