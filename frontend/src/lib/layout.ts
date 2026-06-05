import type { FieldConfig, FieldLayout } from '@/types'

/**
 * Sensible default grid placement for each widget type. Used when a
 * widget's `field_config` entry doesn't carry an explicit `layout`
 * (i.e. dashboards configured before drag-and-drop landed, or newly
 * dropped widgets that haven't been positioned yet).
 *
 * Grid is 12 columns wide. Row units are 70px tall (matches the
 * GRID_ROW_HEIGHT constant on <DashboardGrid />). Sizes were tuned to
 * roughly mirror what the old chaptered layout produced:
 *   - KPI tile: 2w × 2h  (six fit across)
 *   - Hero KPI: 3w × 2h  (slightly wider, for the first revenue tile)
 *   - Chart card: 8w × 4h
 *   - Side stat: 4w × 4h
 *   - Wide table: 12w × 5h
 *   - Map / hero: 8w × 6h
 *
 * `idx` is the widget's index in the field_config array — used to
 * stack widgets vertically when no layout is set (1st widget at y=0,
 * 2nd below it, etc.) so old dashboards don't pile up at (0,0).
 */
const TYPE_DEFAULTS: Record<string, { w: number; h: number }> = {
  metric:        { w: 2,  h: 2 },
  gauge:         { w: 4,  h: 5 },
  line:          { w: 8,  h: 5 },
  bar:           { w: 4,  h: 4 },
  pie:           { w: 4,  h: 4 },
  tag_cloud:     { w: 8,  h: 4 },
  table:         { w: 12, h: 5 },
  map:           { w: 8,  h: 6 },
  // New v2 types — see services/aggregations.py
  big_number:    { w: 4,  h: 3 },
  donut:         { w: 4,  h: 4 },
  funnel:        { w: 4,  h: 5 },
  progress_bar:  { w: 6,  h: 2 },
}

const GRID_COLS = 12

export function defaultLayoutFor(
  type: string,
  idx: number,
  existing: FieldConfig[] = [],
): FieldLayout {
  const size = TYPE_DEFAULTS[type] ?? { w: 4, h: 4 }
  // Walk through the prior widgets in array order and stack ours below
  // the last row that took ANY column we'd occupy. This isn't a full
  // bin-packing algorithm — that would be over-engineered for a one-off
  // default — but it produces a usable column stack that the user can
  // then drag/resize freely.
  let cursorX = 0
  let cursorY = 0
  for (let i = 0; i < idx; i++) {
    const prior = existing[i]
    const lay = prior?.layout
    if (!lay) continue
    // If the next widget fits to the right of this prior one on the
    // same row, place it there.
    if (cursorX + size.w <= GRID_COLS && lay.y === cursorY) {
      cursorX = Math.max(cursorX, lay.x + lay.w)
    } else {
      cursorY = Math.max(cursorY, lay.y + lay.h)
      cursorX = 0
    }
  }
  if (cursorX + size.w > GRID_COLS) {
    cursorY += size.h
    cursorX = 0
  }
  return { x: cursorX, y: cursorY, w: size.w, h: size.h }
}

/** Resolve every widget's layout — explicit if set, otherwise generated.
 *  Returns a list parallel to `fields`. Used by <DashboardGrid /> on
 *  every render so we don't have to mutate `field_config` to provide
 *  defaults. */
export function resolvedLayouts(fields: FieldConfig[]): FieldLayout[] {
  return fields.map((f, i) => f.layout ?? defaultLayoutFor(f.type, i, fields))
}

// Per-type sizes + reading-order rank that mirror the public chaptered
// §01–§06 layout. Used to SEED the admin layout editor so the operator
// starts by editing the arrangement they already see, not a blank grid.
const SEED_SIZE: Record<string, { w: number; h: number }> = {
  metric:       { w: 2,  h: 2 },  // compact KPI tiles — 6 across, ribbon-like
  big_number:   { w: 3,  h: 3 },
  line:         { w: 12, h: 5 },
  gauge:        { w: 4,  h: 4 },
  pie:          { w: 4,  h: 4 },
  donut:        { w: 4,  h: 4 },
  tag_cloud:    { w: 8,  h: 4 },
  map:          { w: 8,  h: 6 },
  bar:          { w: 4,  h: 4 },
  funnel:       { w: 4,  h: 5 },
  progress_bar: { w: 6,  h: 2 },
  table:        { w: 12, h: 5 },
}
const SEED_RANK: Record<string, number> = {
  metric: 0, big_number: 1, line: 2, gauge: 3,
  pie: 4, donut: 4, tag_cloud: 5, map: 6, bar: 7,
  funnel: 8, progress_bar: 9, table: 10,
}

/**
 * Seed grid coordinates that mirror the public chaptered layout's reading
 * order (KPI tiles → volume chart → gauge/pie/topics → map/bars → table),
 * row-packed into the 12-col grid. Used by the admin "Customize layout"
 * action so the editor opens on the default arrangement the operator
 * already sees, which they then tweak — rather than building from zero.
 * Returns a map of field id → layout.
 */
export function chapteredLayoutSeed(
  fields: { id: string; type: string }[],
): Record<string, FieldLayout> {
  const ordered = fields
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const ra = SEED_RANK[a.f.type] ?? 50
      const rb = SEED_RANK[b.f.type] ?? 50
      return ra - rb || a.i - b.i
    })
  const out: Record<string, FieldLayout> = {}
  let x = 0
  let y = 0
  let rowH = 0
  for (const { f } of ordered) {
    const size = SEED_SIZE[f.type] ?? { w: 4, h: 4 }
    if (x + size.w > GRID_COLS) {
      x = 0
      y += rowH
      rowH = 0
    }
    out[f.id] = { x, y, w: size.w, h: size.h }
    x += size.w
    rowH = Math.max(rowH, size.h)
  }
  return out
}

export { GRID_COLS }
