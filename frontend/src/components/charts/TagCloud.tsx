import type { TagCloudValue } from '@/types'

// Weighted-size pills. Each tag's font-size scales with its weight relative
// to the most common tag in the set. Floor at 11px so the long tail still
// reads.
export default function TagCloud({ value }: { value: TagCloudValue }) {
  if (!value.tags.length) return <div className="text-muted text-sm">No topics yet.</div>
  const max = Math.max(...value.tags.map((t) => t.weight))
  const min = 11
  const ceiling = 17
  return (
    <div className="flex flex-wrap gap-2">
      {value.tags.map((t) => {
        const size = min + (t.weight / max) * (ceiling - min)
        return (
          <span key={t.label} className="ux-tag" style={{ fontSize: `${size}px` }}>
            <span>{t.label}</span>
            <span className="ux-tag-n">{t.weight}</span>
          </span>
        )
      })}
    </div>
  )
}
