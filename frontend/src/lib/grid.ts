// Shared geometry + collision math for the freeform widget/block grids.
// Used by both DashboardGrid (field-level) and BlockGrid (magazine-card
// level) so the drag/resize/no-overlap behaviour is identical everywhere.

export const GRID_COLS = 12
export const ROW_H = 56 // px per grid row
export const GAP = 12 // px gutter between cells

export type GItem = { id: string; x: number; y: number; w: number; h: number; static?: boolean }

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

export function gridCollides(a: GItem, b: GItem): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** Vertical-push collision resolution (à la react-grid-layout). Items in
 *  `priority` keep their position; every other item that would overlap an
 *  already-placed item is pushed straight down until it sits clear. Placing
 *  priority items first means the dragged/resized item "wins" and the rest
 *  reflow beneath it — so two items can never occupy the same cells. With an
 *  empty `priority` set it simply compacts any overlaps in reading order,
 *  which is how both grids guarantee a tidy layout on load. */
export function resolveCollisions(items: GItem[], priority: Set<string>): GItem[] {
  const sorted = [...items].sort((a, b) => {
    const pa = priority.has(a.id) ? 0 : 1
    const pb = priority.has(b.id) ? 0 : 1
    if (pa !== pb) return pa - pb
    return a.y - b.y || a.x - b.x
  })
  const placed: GItem[] = []
  for (const it of sorted) {
    let cur: GItem = { ...it }
    let guard = 0
    let hit = placed.find((p) => gridCollides(cur, p))
    while (hit && guard++ < 300) {
      cur = { ...cur, y: hit.y + hit.h }
      hit = placed.find((p) => gridCollides(cur, p))
    }
    placed.push(cur)
  }
  return placed
}
