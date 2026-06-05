import type { PieValue } from '@/types'

// Donut chart with a legend on the right. Slices use brand primary, brand
// accent, then a neutral ramp — keeps to ~3 distinct hues regardless of how
// many slices there are.
const COLORS = [
  'var(--accent, var(--b-primary))',
  'var(--b-accent)',
  '#94A3B8',
  '#CBD5E1',
  '#64748B',
  '#475569',
]

const R = 50
const CIRC = 2 * Math.PI * R

export default function Pie({ value }: { value: PieValue }) {
  if (!value.slices.length) return <div className="text-muted text-sm">No data yet.</div>
  const total = value.slices.reduce((s, x) => s + x.value, 0) || 1

  let offset = 0
  const arcs = value.slices.map((s, i) => {
    const frac = s.value / total
    const dash = frac * CIRC
    const node = {
      color: COLORS[i % COLORS.length],
      dash,
      offset: -offset,
      label: s.label,
      value: s.value,
      pct: s.pct,
    }
    offset += dash
    return node
  })

  return (
    <div className="flex items-center gap-5 h-full">
      <svg
        viewBox="0 0 140 140"
        className="flex-shrink-0 -rotate-90"
        style={{ height: '100%', width: 'auto', aspectRatio: '1', maxHeight: 240, minHeight: 96 }}
      >
        <circle cx="70" cy="70" r={R} fill="none" stroke="#F1F5F9" strokeWidth="18" />
        {arcs.map((a) => (
          <circle
            key={a.label}
            cx="70"
            cy="70"
            r={R}
            fill="none"
            stroke={a.color}
            strokeWidth="18"
            strokeDasharray={`${a.dash} ${CIRC}`}
            strokeDashoffset={a.offset}
          />
        ))}
      </svg>
      <div className="flex-1 min-w-0 space-y-2">
        {value.slices.map((s, i) => (
          <div key={s.label} className="flex items-center justify-between text-[13px]">
            <span className="flex items-center gap-2 min-w-0">
              <span
                className="ux-swatch flex-shrink-0"
                style={{ background: COLORS[i % COLORS.length] }}
              />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="num font-mono text-[11.5px] text-muted ml-2">
              {s.value.toLocaleString()} · {s.pct.toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
