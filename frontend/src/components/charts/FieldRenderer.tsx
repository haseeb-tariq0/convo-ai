import type {
  BarValue,
  ErrorValue,
  GaugeValue,
  LineValue,
  MapValue,
  MetricValue,
  PieValue,
  PublicFieldValue,
  TableValue,
  TagCloudValue,
} from '@/types'

import Bar from './Bar'
import DataTable from './DataTable'
import Gauge from './Gauge'
import Line from './Line'
import Map from './Map'
import Metric from './Metric'
import Pie from './Pie'
import TagCloud from './TagCloud'

function isErr(v: unknown): v is ErrorValue {
  return !!v && typeof v === 'object' && 'error' in (v as Record<string, unknown>)
}

// FieldRenderer is now layout-aware:
// - 'metric' owns its full card chrome (KPI tile w/ icon).
// - Everything else gets a standard card frame (label + body).
// - 'table' uses an alternate frame with a heavier divider for the header
//   row so it reads as a full content block, not a chart.
//
// Each chart body is unaware of its card chrome — keeps the visual system
// composable from Dashboard.tsx when buckets need to override layout.
export default function FieldRenderer({ field }: { field: PublicFieldValue }) {
  const v = field.value

  if (isErr(v)) {
    return (
      <section className="ux-card p-5 h-full">
        <div className="ux-label">{field.label}</div>
        <div className="mt-2 text-sm text-muted italic">{v.error}</div>
      </section>
    )
  }

  if (field.type === 'metric') {
    return <Metric label={field.label} value={v as MetricValue} />
  }

  if (field.type === 'table') {
    return (
      <section className="ux-card overflow-hidden h-full flex flex-col">
        <div className="px-5 py-4 border-b border-line2 flex items-center justify-between flex-shrink-0">
          <div>
            <div className="ux-label">{field.label}</div>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          <DataTable value={v as TableValue} />
        </div>
      </section>
    )
  }

  // All other widgets: the card fills its grid cell and the chart body flexes
  // to fill the space below the label, so resizing the card grows the content
  // instead of leaving empty space.
  return (
    <section className="ux-card p-6 h-full flex flex-col">
      <div className="ux-label mb-3.5 flex-shrink-0">{field.label}</div>
      {/* Top-aligned + clipped: charts (line/gauge/pie) are h-full and fill
          this box, while list widgets (bar/tag cloud) start under the label
          and clip if they're taller than the card — never overflowing UP
          into the label. (justify-center used to push tall lists over it.) */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {renderBody(field)}
      </div>
    </section>
  )
}

function renderBody(field: PublicFieldValue): React.ReactNode {
  const v = field.value
  switch (field.type) {
    case 'gauge':
      return <Gauge value={v as GaugeValue} />
    case 'line':
      return <Line value={v as LineValue} />
    case 'bar':
      return <Bar value={v as BarValue} />
    case 'pie':
      return <Pie value={v as PieValue} />
    case 'tag_cloud':
      return <TagCloud value={v as TagCloudValue} />
    case 'map':
      return <Map value={v as MapValue} />
    default:
      return (
        <div className="text-sm text-muted italic">
          Unsupported field type: {field.type}
        </div>
      )
  }
}

// Grid-span hint for the bucket layout in Dashboard.tsx. The buckets
// (KPI / hero / triple / wide / table) own their own grid; this is only
// used as a fallback for any field type that doesn't slot cleanly.
export function fieldSpanClass(type: string): string {
  switch (type) {
    case 'metric':
    case 'gauge':
      return 'col-span-12 sm:col-span-6 lg:col-span-3'
    case 'pie':
    case 'bar':
      return 'col-span-12 lg:col-span-4'
    case 'line':
    case 'tag_cloud':
      return 'col-span-12 lg:col-span-8'
    case 'map':
      return 'col-span-12 lg:col-span-8'
    case 'table':
      return 'col-span-12'
    default:
      return 'col-span-12 lg:col-span-4'
  }
}
