import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import { chapteredLayoutSeed, defaultLayoutFor, GRID_COLS } from '@/lib/layout'
import type { FieldConfig, FieldLayout, PublicFieldValue } from '@/types'

const ROW_H = 56 // px per grid row
const GAP = 12 // px gutter between cells

export type DashboardGridMode = 'view' | 'edit'

/**
 * Freeform 12-column widget grid — the single rendering system for both the
 * public dashboard (mode="view", locked) and the admin Layout builder
 * (mode="edit"). Each field is a card positioned from its FieldConfig
 * `layout`; fields without one fall back to the shared polished default seed,
 * so editor and public are pixel-identical.
 *
 * Edit mode is a small design tool: drag a card to move, drag the corner to
 * resize, click/shift-click or marquee to multi-select, move a selection
 * together, ✕ or Delete to remove, ⧉ or Ctrl/Cmd+D to duplicate. While a
 * drag is in flight we mutate the moving elements' style directly (a ref, no
 * setState) so the heavy widgets never re-render mid-drag — it stays smooth.
 */
export default function DashboardGrid({
  fields,
  config,
  mode,
  onLayoutChange,
  onDeleteWidgets,
  onDuplicateWidgets,
  renderWidget,
}: {
  fields: PublicFieldValue[]
  config: FieldConfig[]
  mode: DashboardGridMode
  onLayoutChange?: (layouts: Record<string, FieldLayout>) => void
  onDeleteWidgets?: (ids: string[]) => void
  onDuplicateWidgets?: (ids: string[]) => void
  renderWidget: (field: PublicFieldValue) => ReactNode
}) {
  const dataById = new Map(fields.map((f) => [f.id, f]))
  const ordered = config.filter((c) => dataById.has(c.id))

  // Resolve every widget's layout. CRITICAL: the default seed is computed over
  // the FULL `config` (not the filtered `ordered`), so a widget's default spot
  // is deterministic and independent of which widgets currently have data.
  // That's what makes the admin editor and the public page pixel-identical:
  // the editor renders extra placeholder cards (for widgets the backend hasn't
  // returned yet) but every real widget lands in the exact same position in
  // both views — no scatter, no overlap. Explicit saved layout wins per-field.
  const seed = chapteredLayoutSeed(config.map((c) => ({ id: c.id, type: c.type })))
  const layoutById = new Map<string, FieldLayout>()
  config.forEach((c, i) =>
    layoutById.set(c.id, c.layout ?? seed[c.id] ?? defaultLayoutFor(c.type, i, config)),
  )

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

  // ── Selection ─────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const liveSelected = new Set([...selected].filter((id) => layoutById.has(id)))

  // ── Active interaction (ref → pointermove mutates DOM, no re-render) ────
  const active = useRef<
    | { kind: 'move'; sx: number; sy: number; items: { el: HTMLElement; ox: number; oy: number }[] }
    | { kind: 'resize'; sx: number; sy: number; id: string; el: HTMLElement; ow: number; oh: number }
    | { kind: 'marquee'; sx: number; sy: number; rect: DOMRect }
    | null
  >(null)

  const rows = Math.max(
    1,
    ...ordered.map((c) => {
      const l = layoutById.get(c.id)!
      return l.y + l.h
    }),
  )
  const canvasHeight = pxY(rows) + ROW_H

  function elFor(id: string): HTMLElement | null {
    return containerRef.current?.querySelector<HTMLElement>(`[data-grid-id="${id}"]`) ?? null
  }

  function startMove(e: ReactPointerEvent, id: string) {
    if (mode !== 'edit' || colW === 0) return
    e.stopPropagation()
    // Shift/Ctrl/Cmd-click → toggle selection, no drag.
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const n = new Set(prev)
        n.has(id) ? n.delete(id) : n.add(id)
        return n
      })
      return
    }
    // Pressing a card inside a multi-selection moves the whole selection;
    // pressing any other card selects just it and moves it.
    const moveIds =
      liveSelected.has(id) && liveSelected.size > 1 ? [...liveSelected] : [id]
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

  function startMarquee(e: ReactPointerEvent) {
    // Only when pressing the empty canvas (not a card).
    if (mode !== 'edit' || e.target !== e.currentTarget) return
    if (!e.shiftKey && !e.metaKey && !e.ctrlKey) setSelected(new Set())
    const rect = containerRef.current!.getBoundingClientRect()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    active.current = { kind: 'marquee', sx: e.clientX, sy: e.clientY, rect }
    setMarquee({ x: e.clientX - rect.left, y: e.clientY - rect.top, w: 0, h: 0 })
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
    } else if (a.kind === 'resize') {
      a.el.style.width = Math.max(colW * 2 + GAP, a.ow + dx) + 'px'
      a.el.style.height = Math.max(ROW_H * 2 + GAP, a.oh + dy) + 'px'
    } else {
      const x = Math.min(a.sx, e.clientX) - a.rect.left
      const y = Math.min(a.sy, e.clientY) - a.rect.top
      setMarquee({ x, y, w: Math.abs(dx), h: Math.abs(dy) })
    }
  }

  function onPointerUp(e: ReactPointerEvent) {
    const a = active.current
    if (!a) return
    active.current = null
    const dx = e.clientX - a.sx
    const dy = e.clientY - a.sy

    if (a.kind === 'move') {
      const out: Record<string, FieldLayout> = {}
      for (const it of a.items) {
        const id = it.el.getAttribute('data-grid-id')!
        const l = layoutById.get(id)!
        const x = clamp(Math.round(Math.max(0, it.ox + dx) / unitX), 0, GRID_COLS - l.w)
        const y = Math.max(0, Math.round(Math.max(0, it.oy + dy) / unitY))
        it.el.style.transition = ''
        it.el.style.left = pxX(x) + 'px'
        it.el.style.top = pxY(y) + 'px'
        it.el.classList.remove('grid-dragging')
        out[id] = { ...l, x, y }
      }
      onLayoutChange?.(out)
    } else if (a.kind === 'resize') {
      const l = layoutById.get(a.id)!
      const cw = Math.max(colW * 2 + GAP, a.ow + dx)
      const ch = Math.max(ROW_H * 2 + GAP, a.oh + dy)
      const w = clamp(Math.round((cw + GAP) / unitX), 2, GRID_COLS - l.x)
      const h = Math.max(2, Math.round((ch + GAP) / unitY))
      a.el.style.transition = ''
      a.el.style.width = pxW(w) + 'px'
      a.el.style.height = pxH(h) + 'px'
      a.el.classList.remove('grid-dragging')
      onLayoutChange?.({ [a.id]: { ...l, w, h } })
    } else {
      // Marquee: select every card whose rect intersects the box.
      const mq = marquee
      setMarquee(null)
      if (mq && (mq.w > 4 || mq.h > 4)) {
        const hit = new Set<string>(e.shiftKey || e.metaKey || e.ctrlKey ? selected : [])
        ordered.forEach((c) => {
          const l = layoutById.get(c.id)!
          const left = pxX(l.x)
          const top = pxY(l.y)
          if (
            left < mq.x + mq.w &&
            left + pxW(l.w) > mq.x &&
            top < mq.y + mq.h &&
            top + pxH(l.h) > mq.y
          )
            hit.add(c.id)
        })
        setSelected(hit)
      }
    }
  }

  // ── Keyboard: Delete removes selection, Ctrl/Cmd+D duplicates, Esc clears.
  useEffect(() => {
    if (mode !== 'edit') return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      if (liveSelected.size === 0) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        onDeleteWidgets?.([...liveSelected])
        setSelected(new Set())
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault()
        onDuplicateWidgets?.([...liveSelected])
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
      onPointerDown={mode === 'edit' ? startMarquee : undefined}
      onPointerMove={mode === 'edit' ? onPointerMove : undefined}
      onPointerUp={mode === 'edit' ? onPointerUp : undefined}
      onPointerCancel={mode === 'edit' ? onPointerUp : undefined}
    >
      {mode === 'edit' && liveSelected.size > 0 && (
        <div className="grid-seltoolbar" onPointerDown={(e) => e.stopPropagation()}>
          <span className="n">{liveSelected.size} selected</span>
          <button
            type="button"
            onClick={() => onDuplicateWidgets?.([...liveSelected])}
            title="Duplicate (Ctrl/Cmd+D)"
          >
            Duplicate
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              onDeleteWidgets?.([...liveSelected])
              setSelected(new Set())
            }}
            title="Delete (Del)"
          >
            Delete
          </button>
        </div>
      )}

      {marquee && (
        <div
          className="grid-marquee"
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}

      {colW > 0 &&
        ordered.map((cfg) => {
          const field = dataById.get(cfg.id)!
          const l = layoutById.get(cfg.id)!
          const isSel = liveSelected.has(cfg.id)
          return (
            <div
              key={cfg.id}
              data-grid-id={cfg.id}
              className={'grid-item' + (isSel ? ' grid-selected' : '')}
              onPointerDown={mode === 'edit' ? (e) => startMove(e, cfg.id) : undefined}
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
                  title="Delete widget"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteWidgets?.([cfg.id])
                    setSelected((prev) => {
                      const n = new Set(prev)
                      n.delete(cfg.id)
                      return n
                    })
                  }}
                >
                  ✕
                </button>
              )}
              <div className="grid-content">{renderWidget(field)}</div>
              {mode === 'edit' && (
                <div className="grid-resize" title="Drag to resize" onPointerDown={(e) => startResize(e, cfg.id)} />
              )}
            </div>
          )
        })}
    </div>
  )
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
