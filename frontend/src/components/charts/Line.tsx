import { useId, useMemo, useRef, useState } from 'react'

import type { LineValue } from '@/types'

// Hand-rolled SVG line chart with cursor-driven tooltip.
//
// - Smooth cubic-bezier path with brand-gradient fill underneath.
// - Tooltip is hover-driven: nothing is drawn until the cursor enters the
//   plot area, then a vertical guideline + active dot + dark callout track
//   the data point nearest the cursor X. Leave the area and they all hide.
// - Math: x is linear over point index (equal spacing — the backend returns
//   one point per day in a bounded window). y is 0 → yMax with 10% headroom.
//   Smoothing is Catmull-Rom → cubic Bezier in one pass.

const W = 700
const H = 230
const PAD = { l: 40, r: 20, t: 24, b: 28 }

function xTicks<T>(points: T[]): number[] {
  if (points.length <= 6) return points.map((_, i) => i)
  const step = (points.length - 1) / 5
  return Array.from({ length: 6 }, (_, i) => Math.round(i * step))
}

function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return ''
  if (pts.length === 1) return `M ${pts[0].x},${pts[0].y}`
  const d: string[] = [`M ${pts[0].x},${pts[0].y}`]
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d.push(`C ${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`)
  }
  return d.join(' ')
}

function shortLabel(x: string): string {
  const iso = x.length >= 10 ? x.slice(0, 10) : null
  const d = iso ? new Date(iso) : null
  if (d && !isNaN(d.getTime())) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  return x
}

function fmtNum(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (Math.abs(n) >= 10_000) return (n / 1_000).toFixed(1) + 'k'
  return n.toLocaleString('en-US')
}

export default function Line({ value }: { value: LineValue }) {
  const points = value.points
  const gradId = useId().replace(/:/g, '_')
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const projected = useMemo(() => {
    if (!points.length) return { coords: [], yMax: 0 }
    const yMaxRaw = Math.max(...points.map((p) => p.y), 0)
    const yMax = yMaxRaw === 0 ? 1 : yMaxRaw * 1.1
    const xStep = (W - PAD.l - PAD.r) / Math.max(1, points.length - 1)
    const innerH = H - PAD.t - PAD.b
    const coords = points.map((p, i) => ({
      x: PAD.l + i * xStep,
      y: PAD.t + innerH - (p.y / yMax) * innerH,
      label: p.x,
      v: p.y,
    }))
    return { coords, yMax }
  }, [points])

  if (!points.length) {
    return <div className="text-muted text-sm">No data yet.</div>
  }

  const { coords, yMax } = projected
  const linePath = smoothPath(coords)
  const lastX = coords[coords.length - 1].x
  const firstX = coords[0].x
  const baseY = H - PAD.b
  const areaPath = `${linePath} L ${lastX},${baseY} L ${firstX},${baseY} Z`
  const xtIdxs = xTicks(points)
  const yTicks = [0, yMax * 0.25, yMax * 0.5, yMax * 0.75, yMax]
  const yToScreen = (yv: number) =>
    PAD.t + (H - PAD.t - PAD.b) - (yv / yMax) * (H - PAD.t - PAD.b)

  // Map a clientX (mouse event) into the SVG's internal viewBox coords, then
  // pick the data point with the nearest x. Using getBoundingClientRect +
  // ratio is more reliable than `nativeEvent.offsetX` across browsers and
  // when the SVG is scaled by CSS.
  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current
    if (!svg || coords.length === 0) return
    const rect = svg.getBoundingClientRect()
    if (rect.width === 0) return
    const xInView = ((e.clientX - rect.left) / rect.width) * W
    // Bail out if cursor is outside the plot area (over axis labels / padding).
    if (xInView < PAD.l - 8 || xInView > W - PAD.r + 8) {
      setHoverIdx(null)
      return
    }
    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < coords.length; i++) {
      const d = Math.abs(coords[i].x - xInView)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    setHoverIdx(bestIdx)
  }

  function handleMouseLeave() {
    setHoverIdx(null)
  }

  const active = hoverIdx !== null ? coords[hoverIdx] : null
  // Position the callout above the active point, clamped horizontally so it
  // never hangs off the edge of the SVG.
  const TIP_W = 132
  const TIP_H = 42
  const tipX = active ? Math.min(Math.max(active.x - TIP_W / 2, PAD.l - 6), W - PAD.r - TIP_W + 6) : 0
  const tipY = active ? Math.max(active.y - TIP_H - 12, PAD.t - 6) : 0

  // Aside stats — mirror the magazine line card: period total (+ vs previous),
  // peak day, and rolling average, computed from this field's own points.
  const total = points.reduce((s, p) => s + p.y, 0)
  const avg = points.length ? Math.round(total / points.length) : 0
  const peakIdx = points.reduce((b, p, i) => (p.y > points[b].y ? i : b), 0)
  const prevPts = value.previous_points ?? null
  const prevTotal = prevPts && prevPts.length ? prevPts.reduce((s, p) => s + p.y, 0) : null
  const periodDelta =
    prevTotal != null && prevTotal !== 0
      ? Math.round(((total - prevTotal) / prevTotal) * 1000) / 10
      : null

  return (
    <div className="volume-wrap" style={{ height: '100%' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: '100%', minHeight: 70, cursor: active ? 'crosshair' : 'default' }}
        onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <defs>
        <linearGradient id={`area-${gradId}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--accent, var(--b-primary))" stopOpacity={0.22} />
          <stop offset="100%" stopColor="var(--accent, var(--b-primary))" stopOpacity={0} />
        </linearGradient>
      </defs>
      {/* y grid */}
      <g stroke="#EEF0F3" strokeWidth="1">
        {yTicks.map((t, i) => (
          <line key={i} x1={PAD.l} y1={yToScreen(t)} x2={W - PAD.r} y2={yToScreen(t)} />
        ))}
      </g>
      {/* y labels */}
      <g fontFamily="JetBrains Mono" fontSize="10" fill="#94A3B8">
        {yTicks.map((t, i) => (
          <text key={i} x={PAD.l - 8} y={yToScreen(t) + 4} textAnchor="end">
            {Math.round(t)}
          </text>
        ))}
      </g>
      {/* x labels */}
      <g fontFamily="Inter" fontSize="11" fill="#94A3B8" textAnchor="middle">
        {xtIdxs.map((i) => (
          <text key={i} x={coords[i].x} y={H - 8}>
            {shortLabel(points[i].x)}
          </text>
        ))}
      </g>
      {/* area + line */}
      <path d={areaPath} fill={`url(#area-${gradId})`} />
      <path
        d={linePath}
        fill="none"
        stroke="var(--accent, var(--b-primary))"
        strokeWidth="2.25"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* base dots — drawn for every point regardless of hover state */}
      <g fill="#fff" stroke="var(--accent, var(--b-primary))" strokeWidth="2">
        {coords.map((c, i) =>
          // Skip the dot under the hover point so the active emphasis isn't
          // double-rendered.
          i === hoverIdx ? null : <circle key={i} cx={c.x} cy={c.y} r="3.25" />,
        )}
      </g>
      {/* Hover overlay — guideline + active dot + tooltip card */}
      {active && (
        <g pointerEvents="none">
          <line
            x1={active.x}
            y1={active.y}
            x2={active.x}
            y2={baseY}
            stroke="var(--accent, var(--b-primary))"
            strokeWidth="1"
            strokeDasharray="3 3"
            opacity="0.5"
          />
          <circle cx={active.x} cy={active.y} r="5.5" fill="#fff" stroke="var(--accent, var(--b-primary))" strokeWidth="2.5" />
          <g transform={`translate(${tipX}, ${tipY})`}>
            <rect width={TIP_W} height={TIP_H} rx="6" fill="#0F172A" />
            <text x="12" y="17" fontSize="10" fontFamily="JetBrains Mono" fill="#94A3B8">
              {shortLabel(active.label).toUpperCase()}
            </text>
            <text x="12" y="33" fontSize="13" fontFamily="Inter" fill="#fff" fontWeight="600">
              {active.v} {active.v === 1 ? 'chat' : 'chats'}
            </text>
          </g>
        </g>
      )}
      {/* Invisible hit area so mousemove fires even where there's no visible
          geometry. Sits at the bottom of the SVG so the path is still painted
          on top. */}
      <rect
        x="0"
        y="0"
        width={W}
        height={H}
        fill="transparent"
        style={{ pointerEvents: 'all' }}
      />
      </svg>
      <div className="volume-aside">
        <div className="aside-stat">
          <div className="l">Period total</div>
          <div className="v num">{fmtNum(total)}</div>
          {prevTotal != null && (
            <div className="d">
              vs <span className="num">{fmtNum(prevTotal)}</span> previous
              {periodDelta != null && (
                <>
                  {' · '}
                  <span
                    className="num"
                    style={{ color: periodDelta >= 0 ? 'var(--pos)' : 'var(--neg)' }}
                  >
                    {periodDelta > 0 ? '+' : ''}
                    {periodDelta}%
                  </span>
                </>
              )}
            </div>
          )}
        </div>
        <div className="aside-stat">
          <div className="l">Peak day</div>
          <div className="v num">{points[peakIdx].y.toLocaleString()}</div>
          <div className="d">{shortLabel(points[peakIdx].x)}</div>
        </div>
        <div className="aside-stat">
          <div className="l">Average / day</div>
          <div className="v num">{avg.toLocaleString()}</div>
          <div className="d">rolling window</div>
        </div>
      </div>
    </div>
  )
}
