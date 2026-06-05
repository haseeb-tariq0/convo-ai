import { cn } from '@/lib/cn'

export function Skeleton({ className }: { className?: string }) {
  // SPEC §12: shaped placeholders, not spinners.
  return <div className={cn('animate-pulse bg-hairline/60 rounded-sm', className)} />
}

export function CardSkeleton({ height = 'h-32' }: { height?: string }) {
  return (
    <div className="card p-5">
      <Skeleton className="h-3 w-20 mb-3" />
      <Skeleton className={`w-full ${height}`} />
    </div>
  )
}
