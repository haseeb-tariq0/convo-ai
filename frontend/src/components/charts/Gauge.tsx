import { useId } from 'react'

import type { GaugeValue } from '@/types'

// Sentiment / score gauge. 180° arc with a brand-gradient stroke and a
// needle. Below the gauge, the score value + qualitative label.
//
// The arc is roughly π·r long. Filling = pct × arc length, set via
// stroke-dasharray. Needle angle: -90° at min, +90° at max.
export default function Gauge({ value }: { value: GaugeValue }) {
  const gradId = useId().replace(/:/g, '_') // useId returns characters illegal in a CSS url()
  const range = value.max - value.min
  const pct = range === 0 ? 0 : (value.value - value.min) / range
  const clamped = Math.max(0, Math.min(1, pct))
  const angleDeg = -90 + clamped * 180

  // r = 90, arc length = π·r ≈ 282.7
  const ARC = Math.PI * 90
  const filled = clamped * ARC

  // Tone copy under the value. Conservative thresholds.
  const tone =
    value.value > 0.2 ? 'Mostly positive' : value.value < -0.2 ? 'Mostly negative' : 'Mixed'
  const toneColor =
    value.value > 0.2 ? '#15803D' : value.value < -0.2 ? '#B91C1C' : '#92400E'

  return (
    <div className="flex flex-col items-center justify-center h-full">
      <svg viewBox="0 0 220 140" className="w-full max-w-[360px]" style={{ maxHeight: '78%' }}>
        <defs>
          <linearGradient id={`gauge-${gradId}`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#DC2626" />
            <stop offset="50%" stopColor="var(--b-accent)" />
            <stop offset="100%" stopColor="var(--accent, var(--b-primary))" />
          </linearGradient>
        </defs>
        {/* track */}
        <path
          d="M 20 120 A 90 90 0 0 1 200 120"
          fill="none"
          stroke="#F1F5F9"
          strokeWidth="14"
          strokeLinecap="round"
        />
        {/* filled arc */}
        <path
          d="M 20 120 A 90 90 0 0 1 200 120"
          fill="none"
          stroke={`url(#gauge-${gradId})`}
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${ARC}`}
        />
        {/* needle */}
        <g transform={`translate(110,120) rotate(${angleDeg})`}>
          <line x1="0" y1="0" x2="0" y2="-86" stroke="#0F172A" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="0" cy="0" r="6" fill="#0F172A" />
          <circle cx="0" cy="0" r="2.5" fill="#fff" />
        </g>
        {/* tick labels */}
        <text x="20" y="138" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9.5" fill="#94A3B8">
          {value.min.toFixed(1)}
        </text>
        <text x="110" y="138" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9.5" fill="#94A3B8">
          0
        </text>
        <text x="200" y="138" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9.5" fill="#94A3B8">
          +{value.max.toFixed(1)}
        </text>
      </svg>
      <div className="num text-[30px] font-bold mt-1">{value.value.toFixed(2)}</div>
      <div
        className="text-[10.5px] font-semibold uppercase tracking-wider mt-1"
        style={{ color: toneColor }}
      >
        {tone}
      </div>
    </div>
  )
}
