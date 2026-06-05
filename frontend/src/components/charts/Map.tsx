import { useMemo } from 'react'
import { ComposableMap, Geographies, Geography, Marker } from 'react-simple-maps'

import type { MapValue } from '@/types'

const WORLD_TOPO = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json'

// ISO-3166 alpha-2 → [lng, lat]. Covers everything we see in GA4 mock plus
// the long tail surfaced by phone-derived country (Africa + MENA + Asia).
// Missing countries just don't render (no crash, no zero-pin clutter).
const COUNTRY_COORDS: Record<string, [number, number]> = {
  // GCC + Levant + MENA
  AE: [54.0, 24.0], SA: [45.0, 24.0], KW: [47.5, 29.3], QA: [51.2, 25.3],
  OM: [56.0, 21.0], BH: [50.6, 26.0], JO: [36.0, 31.3], EG: [30.0, 27.0],
  LB: [35.9, 33.9], SY: [38.0, 35.0], IQ: [43.7, 33.2], YE: [48.5, 15.6],
  PS: [35.2, 32.0], IL: [34.9, 31.5], TR: [35.0, 39.0],
  // North Africa + Sub-Saharan
  MA: [-7.0, 31.7], DZ: [3.0, 28.0],  TN: [9.5, 33.9],  LY: [17.0, 27.0],
  SD: [30.2, 12.9], UG: [32.3, 1.4],  KE: [37.9, -0.0], ET: [40.5, 9.1],
  NG: [8.7, 9.1],   ZA: [22.9, -30.6], GH: [-1.0, 7.9],
  // Asia
  IN: [78.9, 22.0], PK: [69.3, 30.4], BD: [90.4, 23.7], LK: [80.7, 7.9],
  PH: [122.0, 13.0], TH: [101.0, 15.9], MY: [101.9, 4.2], ID: [113.9, -0.8],
  SG: [103.8, 1.3], VN: [108.3, 14.1], CN: [104.2, 35.9], JP: [138.3, 36.2],
  KR: [127.8, 36.0],
  // Europe + Russia
  RU: [105.3, 61.5], GB: [-2.0, 54.0], DE: [10.5, 51.2], FR: [2.5, 46.6],
  IT: [12.6, 41.9], ES: [-3.7, 40.5], NL: [5.3, 52.1], BE: [4.5, 50.5],
  CH: [8.2, 46.8],  AT: [14.6, 47.5], PL: [19.1, 51.9], SE: [18.6, 60.1],
  GR: [21.8, 39.1], PT: [-8.2, 39.4], IE: [-8.2, 53.4],
  // Americas
  US: [-97.0, 39.0], CA: [-106.0, 56.1], MX: [-102.5, 23.6], BR: [-51.9, -14.2],
  AR: [-63.6, -38.4], CO: [-74.3, 4.6],
  // Oceania
  AU: [134.5, -25.7], NZ: [171.8, -41.0],
}

export default function Map({ value }: { value: MapValue }) {
  if (value.points && value.points.length > 0) {
    return <BubbleMap value={value} />
  }
  return <EmbedMap value={value} />
}

function EmbedMap({ value }: { value: MapValue }) {
  const q = (value.q || '').trim()
  if (!q) {
    return <div className="text-sm text-muted italic">No location configured.</div>
  }
  const params = new URLSearchParams({ q, output: 'embed' })
  if (value.zoom) params.set('z', String(value.zoom))
  return (
    <div className="aspect-[16/9] overflow-hidden rounded-lg border border-line2">
      <iframe
        title={q}
        src={`https://maps.google.com/maps?${params.toString()}`}
        className="w-full h-full"
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
      />
    </div>
  )
}

function BubbleMap({ value }: { value: MapValue }) {
  const points = value.points ?? []
  const maxValue = useMemo(
    () => points.reduce((m, p) => Math.max(m, p.value), 0) || 1,
    [points],
  )
  const radiusFor = (v: number) => 3 + (v / maxValue) * 14

  return (
    <div>
      <div className="aspect-[16/10] overflow-hidden rounded-lg border border-line2 bg-canvas">
        <ComposableMap projectionConfig={{ scale: 130 }} style={{ width: '100%', height: '100%' }}>
          <Geographies geography={WORLD_TOPO}>
            {({ geographies }) =>
              geographies.map((geo) => (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  fill="#E2E8F0"
                  stroke="#CBD5E1"
                  strokeWidth={0.4}
                  style={{
                    default: { outline: 'none' },
                    hover: { outline: 'none', fill: '#CBD5E1' },
                    pressed: { outline: 'none' },
                  }}
                />
              ))
            }
          </Geographies>
          {points.map((p) => {
            const coords = COUNTRY_COORDS[p.country]
            if (!coords) return null
            const r = radiusFor(p.value)
            return (
              <Marker key={p.country} coordinates={coords}>
                <circle r={r * 2} fill="var(--b-primary)" fillOpacity={0.15} />
                <circle r={r * 1.4} fill="var(--b-primary)" fillOpacity={0.25} />
                <circle r={r} fill="var(--b-primary)" />
                <title>{`${p.country}: ${p.value.toLocaleString()}`}</title>
              </Marker>
            )
          })}
        </ComposableMap>
      </div>
      {value.total != null && (
        <div className="text-muted text-[11.5px] mt-3 font-mono">
          {points.length} countries · {value.total.toLocaleString()} signals
        </div>
      )}
    </div>
  )
}
