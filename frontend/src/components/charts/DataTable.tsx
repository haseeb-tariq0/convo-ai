import type { TableValue } from '@/types'

// Conversation table. Sentiment + intent values render as colored pills.
// Timestamp + UserId render mono. Message is given the most horizontal
// space; everything else fits to its content. Arabic text gets RTL +
// right-aligned so it doesn't read as broken Latin.

const ARABIC_RE = /[؀-ۿ]/

function sentimentPill(v: string): { cls: string; label: string } {
  if (v === 'positive') return { cls: 'ux-pill ux-pill-ok', label: v }
  if (v === 'negative') return { cls: 'ux-pill ux-pill-bad', label: v }
  return { cls: 'ux-pill ux-pill-neu', label: v }
}

function intentPill(v: string): string {
  switch (v) {
    case 'praise':
      return 'ux-pill ux-pill-ok'
    case 'complaint':
      return 'ux-pill ux-pill-bad'
    case 'request':
      return 'ux-pill ux-pill-brand'
    default:
      return 'ux-pill ux-pill-neu'
  }
}

function isMonoColumn(c: string): boolean {
  return c === 'Timestamp' || c === 'UserId' || c === 'occurred_at' || c === 'ai_sentiment_score'
}

function formatCell(c: string, raw: unknown): string {
  if (raw == null || raw === '') return '—'
  if (c === 'Timestamp' && typeof raw === 'string') {
    const d = new Date(raw)
    if (!isNaN(d.getTime())) {
      return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    }
  }
  return String(raw)
}

export default function DataTable({ value }: { value: TableValue }) {
  if (!value.rows.length) return <div className="text-muted text-sm">No rows yet.</div>
  return (
    <div className="overflow-x-auto">
      <table className="ux-table w-full">
        <thead>
          <tr>
            {value.columns.map((c) => (
              <th key={c}>{c.replace(/_/g, ' ')}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {value.rows.map((row, i) => {
            const sentiment = row['ai_sentiment']
            const isEscalation =
              (typeof sentiment === 'string' && sentiment === 'negative') ||
              row['ai_intent'] === 'complaint'
            return (
              <tr
                key={i}
                style={
                  isEscalation
                    ? { background: 'linear-gradient(90deg, rgba(220,38,38,0.04), transparent 60%)' }
                    : undefined
                }
              >
                {value.columns.map((c) => {
                  const raw = row[c]
                  const isMono = isMonoColumn(c)
                  const display = formatCell(c, raw)
                  if (c === 'ai_sentiment' && typeof raw === 'string') {
                    const { cls, label } = sentimentPill(raw)
                    return (
                      <td key={c}>
                        <span className={cls}>{label}</span>
                      </td>
                    )
                  }
                  if (c === 'ai_intent' && typeof raw === 'string') {
                    return (
                      <td key={c}>
                        <span className={intentPill(raw)}>{raw}</span>
                      </td>
                    )
                  }
                  if (c === 'Message') {
                    const text = display
                    const isArabic = typeof raw === 'string' && ARABIC_RE.test(raw)
                    return (
                      <td key={c}>
                        <div
                          className="max-w-[520px] line-clamp-2"
                          style={isArabic ? { direction: 'rtl', textAlign: 'right' } : undefined}
                        >
                          {text}
                        </div>
                      </td>
                    )
                  }
                  return (
                    <td
                      key={c}
                      className={
                        isMono
                          ? 'font-mono text-[11.5px] text-muted whitespace-nowrap'
                          : ''
                      }
                    >
                      {display}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
