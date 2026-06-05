export default function EmptyState({
  title,
  copy,
  action,
}: {
  title: string
  copy?: string
  action?: React.ReactNode
}) {
  return (
    <div className="card p-10 text-center">
      <div className="font-display text-xl mb-1">{title}</div>
      {copy && <div className="text-muted text-sm max-w-md mx-auto">{copy}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
