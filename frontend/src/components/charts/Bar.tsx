import type { BarValue } from '@/types'

// Stacked-row bar layout — each row has the label above the track, and the
// raw count + percentage on the right. Brand color rotates through primary /
// accent / neutral for visual variety without ever going rainbow.
const COLORS = ['var(--accent, var(--b-primary))', 'var(--b-accent)', '#16A34A', '#94A3B8', '#DC2626', '#0EA5E9']

export default function Bar({ value }: { value: BarValue }) {
  if (!value.bars.length) return <div className="text-muted text-sm">No data yet.</div>
  const total = value.bars.reduce((s, b) => s + b.value, 0) || 1
  const max = Math.max(...value.bars.map((b) => b.value))
  return (
    <div>
      {value.bars.map((b, i) => {
        const pct = (b.value / total) * 100
        const width = (b.value / max) * 100
        return (
          <div key={b.label} className="py-2.5 first:pt-0 last:pb-0 border-t border-line2 first:border-t-0">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[13px] truncate">{b.label}</span>
              <span className="num font-mono text-[11.5px] text-muted">
                {b.value.toLocaleString()} · {pct.toFixed(0)}%
              </span>
            </div>
            <div className="ux-bar-track">
              <div
                className="ux-bar-fill"
                style={{ width: `${width}%`, background: COLORS[i % COLORS.length] }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
