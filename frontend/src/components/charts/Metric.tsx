import type { MetricValue } from '@/types'

function format(n: number) {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (Math.abs(n) >= 10_000) return (n / 1_000).toFixed(1) + 'k'
  // 1 decimal place so averages (e.g. 13.8 msgs/chat, 6.3 s) keep their
  // fractional precision. Integers like 302 still render without a
  // trailing .0 because `maximumFractionDigits` truncates trailing zeros.
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n)
}

// Mirror of Dashboard.tsx's redundancy heuristic. Kept local here so this
// component stays a self-contained renderer.
function isUnitRedundant(label: string, unit: string): boolean {
  const expand = (s: string) =>
    s
      .toLowerCase()
      .replace(/\bmsgs?\b/g, 'message')
      .replace(/[^a-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const l = expand(label)
  const u = expand(unit)
  if (!u) return false
  const singular = u.replace(/s$/, '')
  return l.includes(u) || (singular.length > 2 && l.includes(singular))
}

// Mirror of Dashboard.tsx's shortenUnit map. `msgs/chat` → `msgs` (drop
// the "/chat" since it's contextually obvious). `seconds` stays whole.
const UNIT_SHORT: Record<string, string> = {
  'msgs/chat': 'msgs',
  'msgs/conversation': 'msgs',
}
function shortenUnit(unit: string): string {
  return UNIT_SHORT[unit.toLowerCase()] ?? unit
}

// Pick how to render the label and unit together.
//
// Step 0: abbreviate "Average " → "Avg " so labels fit at 3-col card
//   width (~145px) without wrapping.
// Rule 1: if the label ends with " chats", strip it and use "chats" as
//   the unit slot. "In-house guest chats" → label "In-house guest",
//   unit "chats" rendered next to the number — same shape as "5.9 s".
// Rule 2: otherwise, if the unit is redundant with the label, drop it.
//   "Booking links shared" / unit "links shared" → unit dropped.
// Rule 3: pass through with shortening ("seconds" → "s", "msgs/chat" → "ms").
function deriveDisplay(label: string, unit: string | undefined) {
  const abbreviated = label.replace(/^Average\s+/i, 'Avg ')
  const trailingChats = abbreviated.match(/^(.+?)\s+chats\s*$/i)
  if (trailingChats && trailingChats[1].trim().length > 0) {
    return { label: trailingChats[1].trim(), unit: 'chats' }
  }
  if (unit && !isUnitRedundant(label, unit)) {
    return { label: abbreviated, unit: shortenUnit(unit) }
  }
  return { label: abbreviated, unit: null as string | null }
}

// Standard KPI card — used for individual metrics that aren't grouped
// into a composed tile (User Messages, Unique Users, Avg Interactions,
// Avg Response Time, In-house Guest, etc.).
//
// Number is 36px — sized to fit comfortably at the narrowest allotment
// the dashboard uses for these cards (3/24 cols ≈ 147px wide). The unit
// rides at 14px on the same baseline. `h-full flex flex-col` lets the
// card stretch to the row's tallest sibling, `mt-auto` pins the number
// to the bottom so excess height becomes breathing room above it, and
// the eyebrow label at the top aligns with every other top-row tile.
export default function Metric({ label, value }: { label: string; value: MetricValue }) {
  const display = deriveDisplay(label, value.unit)

  // Delta footer — matches the magazine KPI tiles. For response time and
  // escalations a DROP is good, so flip the tone there.
  const delta = value.delta_pct ?? null
  const lowerBetter =
    label.toLowerCase().includes('response') || label.toLowerCase().includes('escalat')
  const dir =
    delta == null
      ? 'neu'
      : lowerBetter
        ? delta < 0 ? 'pos' : delta > 0 ? 'neg' : 'neu'
        : delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'neu'
  const windowLabel = value.window_days ? `vs prev ${value.window_days}d` : ''

  return (
    <section className="ux-card p-4 h-full flex flex-col">
      <div className="ux-label">{display.label}</div>
      <div className="mt-auto">
        <div className="flex items-baseline gap-2">
          <div className="num text-[36px] font-bold leading-none">{format(value.value)}</div>
          {display.unit && (
            <div className="text-[14px] text-muted font-mono">{display.unit}</div>
          )}
        </div>
        {windowLabel && (
          <div className="kpi-foot" style={{ marginTop: 8 }}>
            {/* Every windowed metric gets a footer for a consistent row:
                a real ▲/▼ delta where it exists, a neutral 0.0% when flat,
                and an em-dash when no comparison is possible (e.g. 0 vs 0). */}
            <span className={'kpi-delta ' + dir}>
              {delta == null ? (
                '—'
              ) : (
                <>
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
                </>
              )}
            </span>
            <span className="kpi-vs">{windowLabel}</span>
          </div>
        )}
      </div>
    </section>
  )
}
