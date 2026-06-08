import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import { clamp, GAP, GItem, GRID_COLS, resolveCollisions, ROW_H } from '@/lib/grid'
import type { FieldLayout } from '@/types'

export type BlockItem = { id: string; title: string; layout: FieldLayout; node: ReactNode }
export type BlockGridMode = 'view' | 'edit'

/**
 * Block-level freeform grid. Same drag/resize/no-overlap behaviour as the
 * field-level DashboardGrid, but each cell is a whole *magazine card* (KPI
 * ribbon, volume chart, sentiment, booking revenue, …) rather than a single
 * field. The public page renders this read-only (mode="view"); the admin
 * Layout editor renders the SAME blocks in edit mode — so what the operator
 * arranges is exactly what the client sees, and the cards stay pixel-identical
 * to the polished magazine because they ARE the magazine components.
 */
export default function BlockGrid({
  blocks,
  mode,
  onLayoutChange,
  onRemove,
}: {
  blocks: BlockItem[]
  mode: BlockGridMode
  onLayoutChange?: (layouts: Record<string, FieldLayout>) => void
  onRemove?: (ids: string[]) => void
}) {
  // Clean any overlaps up-front so the grid is never "scattered" on load.
  const layoutById = new Map<string, FieldLayout>()
  for (const b of blocks) layoutById.set(b.id, b.layout)
  {
    const cleaned = resolveCollisions(
      blocks.map((b) => ({ id: b.id, x: b.layout.x, y: b.layout.y, w: b.layout.w, h: b.layout.h, static: b.layout.static })),
      new Set<string>(),
    )
    for (const r of cleaned) {
      layoutById.set(r.id, { x: r.x, y: r.y, w: r.w, h: r.h, ...(r.static ? { static: true } : {}) })
    }
  }

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const colW = width > 0 ? (width - (GRID_COLS - 1) * GAP) / GRID_COLS : 0
  const unitX = colW + GAP
  const unitY = ROW_H + GAP
  const pxX = (x: number) => x * unitX
  const pxY = (y: number) => y * unitY
  const pxW = (w: number) => w * colW + (w - 1) * GAP
  const pxH = (h: number) => h * ROW_H + (h - 1) * GAP

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const liveSelected = new Set([...selected].filter((id) => layoutById.has(id)))

  const active = useRef<
    | { kind: 'move'; sx: number; sy: number; items: { el: HTMLElement; ox: number; oy: number }[] }
    | { kind: 'resize'; sx: number; sy: number; id: string; el: HTMLElement; ow: number; oh: number }
    | null
  >(null)

  const rows = Math.max(1, ...blocks.map((b) => {
    const l = layoutById.get(b.id)!
    return l.y + l.h
  }))
  const canvasHeight = pxY(rows) + ROW_H

  function elFor(id: string): HTMLElement | null {
    return containerRef.current?.querySelector<HTMLElement>(`[data-block-id="${id}"]`) ?? null
  }

  function resolveAll(changed: Record<string, FieldLayout>, priority: Set<string>): Record<string, FieldLayout> {
    const items: GItem[] = blocks.map((b) => {
      const v = changed[b.id] ?? layoutById.get(b.id)!
      return { id: b.id, x: v.x, y: v.y, w: v.w, h: v.h, static: v.static }
    })
    const out: Record<string, FieldLayout> = {}
    for (const r of resolveCollisions(items, priority)) {
      out[r.id] = { x: r.x, y: r.y, w: r.w, h: r.h, ...(r.static ? { static: true } : {}) }
    }
    return out
  }

  function startMove(e: ReactPointerEvent, id: string) {
    if (mode !== 'edit' || colW === 0) return
    e.stopPropagation()
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const n = new Set(prev)
        n.has(id) ? n.delete(id) : n.add(id)
        return n
      })
      return
    }
    const moveIds = liveSelected.has(id) && liveSelected.size > 1 ? [...liveSelected] : [id]
    if (!(liveSelected.has(id) && liveSelected.size > 1)) setSelected(new Set([id]))
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const items = moveIds
      .map((mid) => {
        const el = mid === id ? (e.currentTarget as HTMLElement) : elFor(mid)
        if (!el) return null
        const l = layoutById.get(mid)!
        el.style.transition = 'none'
        el.classList.add('grid-dragging')
        return { el, ox: pxX(l.x), oy: pxY(l.y) }
      })
      .filter((x): x is { el: HTMLElement; ox: number; oy: number } => !!x)
    active.current = { kind: 'move', sx: e.clientX, sy: e.clientY, items }
  }

  function startResize(e: ReactPointerEvent, id: string) {
    if (mode !== 'edit' || colW === 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = (e.currentTarget as HTMLElement).closest('.grid-item') as HTMLElement | null
    if (!el) return
    const l = layoutById.get(id)!
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    el.style.transition = 'none'
    el.classList.add('grid-dragging')
    active.current = { kind: 'resize', sx: e.clientX, sy: e.clientY, id, el, ow: pxW(l.w), oh: pxH(l.h) }
  }

  function onPointerMove(e: ReactPointerEvent) {
    const a = active.current
    if (!a) return
    const dx = e.clientX - a.sx
    const dy = e.clientY - a.sy
    if (a.kind === 'move') {
      for (const it of a.items) {
        it.el.style.left = Math.max(0, it.ox + dx) + 'px'
        it.el.style.top = Math.max(0, it.oy + dy) + 'px'
      }
    } else {
      a.el.style.width = Math.max(colW * 2 + GAP, a.ow + dx) + 'px'
      a.el.style.height = Math.max(ROW_H * 2 + GAP, a.oh + dy) + 'px'
    }
  }

  function onPointerUp(e: ReactPointerEvent) {
    const a = active.current
    if (!a) return
    active.current = null
    const dx = e.clientX - a.sx
    const dy = e.clientY - a.sy
    if (a.kind === 'move') {
      const moved: Record<string, FieldLayout> = {}
      const movedIds = new Set<string>()
      for (const it of a.items) {
        const id = it.el.getAttribute('data-block-id')!
        const l = layoutById.get(id)!
        const x = clamp(Math.round(Math.max(0, it.ox + dx) / unitX), 0, GRID_COLS - l.w)
        const y = Math.max(0, Math.round(Math.max(0, it.oy + dy) / unitY))
        moved[id] = { ...l, x, y }
        movedIds.add(id)
      }
      const out = resolveAll(moved, movedIds)
      for (const it of a.items) {
        const id = it.el.getAttribute('data-block-id')!
        const r = out[id]
        it.el.style.transition = ''
        it.el.style.left = pxX(r.x) + 'px'
        it.el.style.top = pxY(r.y) + 'px'
        it.el.classList.remove('grid-dragging')
      }
      onLayoutChange?.(out)
    } else {
      const l = layoutById.get(a.id)!
      const cw = Math.max(colW * 2 + GAP, a.ow + dx)
      const ch = Math.max(ROW_H * 2 + GAP, a.oh + dy)
      const w = clamp(Math.round((cw + GAP) / unitX), 2, GRID_COLS - l.x)
      const h = Math.max(2, Math.round((ch + GAP) / unitY))
      const out = resolveAll({ [a.id]: { ...l, w, h } }, new Set([a.id]))
      const r = out[a.id]
      a.el.style.transition = ''
      a.el.style.width = pxW(r.w) + 'px'
      a.el.style.height = pxH(r.h) + 'px'
      a.el.style.left = pxX(r.x) + 'px'
      a.el.style.top = pxY(r.y) + 'px'
      a.el.classList.remove('grid-dragging')
      onLayoutChange?.(out)
    }
  }

  useEffect(() => {
    if (mode !== 'edit') return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      if (liveSelected.size === 0) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        onRemove?.([...liveSelected])
        setSelected(new Set())
      } else if (e.key === 'Escape') {
        setSelected(new Set())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div
      ref={containerRef}
      className={'dash-grid mode-' + mode}
      style={{
        position: 'relative',
        width: '100%',
        height: canvasHeight,
        ...(mode === 'edit' && colW > 0
          ? {
              backgroundImage:
                'linear-gradient(to right, rgba(148,163,184,0.11) 1px, transparent 1px),' +
                'linear-gradient(to bottom, rgba(148,163,184,0.07) 1px, transparent 1px)',
              backgroundSize: `${unitX}px ${unitY}px`,
            }
          : null),
      }}
      onPointerMove={mode === 'edit' ? onPointerMove : undefined}
      onPointerUp={mode === 'edit' ? onPointerUp : undefined}
      onPointerCancel={mode === 'edit' ? onPointerUp : undefined}
    >
      {colW > 0 &&
        blocks.map((b) => {
          const l = layoutById.get(b.id)!
          const isSel = liveSelected.has(b.id)
          return (
            <div
              key={b.id}
              data-block-id={b.id}
              className={'grid-item' + (isSel ? ' grid-selected' : '')}
              onPointerDown={mode === 'edit' ? (e) => startMove(e, b.id) : undefined}
              style={{
                position: 'absolute',
                left: pxX(l.x),
                top: pxY(l.y),
                width: pxW(l.w),
                height: pxH(l.h),
                transition:
                  'left .16s cubic-bezier(.2,.7,.3,1), top .16s cubic-bezier(.2,.7,.3,1), width .16s cubic-bezier(.2,.7,.3,1), height .16s cubic-bezier(.2,.7,.3,1)',
              }}
            >
              {mode === 'edit' && (
                <button
                  type="button"
                  className="grid-del"
                  title="Remove card"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove?.([b.id])
                    setSelected((prev) => {
                      const n = new Set(prev)
                      n.delete(b.id)
                      return n
                    })
                  }}
                >
                  ✕
                </button>
              )}
              <div className="grid-content">{b.node}</div>
              {mode === 'edit' && (
                <div className="grid-resize" title="Drag to resize" onPointerDown={(e) => startResize(e, b.id)} />
              )}
            </div>
          )
        })}
    </div>
  )
}
