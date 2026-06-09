import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

import type { BlockItem } from '@/components/public/BlockGrid'

/**
 * Magazine cards in a 12-column auto-height CSS grid. Each card spans
 * `block.layout.w` columns; rows form automatically and every card sizes to
 * its own content — so it stays as polished as the flowing magazine, never
 * gappy. In edit mode the cards are drag-sortable (grab a card, drop it in a
 * new spot, the rest reflow) and show a ✕ to remove. Public renders the same
 * cards read-only, so editor === public.
 */
export default function SortableMagazine({
  blocks,
  edit,
  onReorder,
  onRemove,
  onResize,
}: {
  blocks: BlockItem[]
  edit?: boolean
  onReorder?: (orderedIds: string[]) => void
  onRemove?: (id: string) => void
  onResize?: (id: string, dims: { w?: number; h?: number }) => void
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const ids = blocks.map((b) => b.id)

  const grid = (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(12, 1fr)',
        gap: 16,
        alignItems: 'start',
      }}
    >
      {blocks.map((b) => (
        <SortableCard key={b.id} block={b} edit={!!edit} onRemove={onRemove} onResize={onResize} />
      ))}
    </div>
  )

  if (!edit) return grid

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIndex = ids.indexOf(active.id as string)
    const newIndex = ids.indexOf(over.id as string)
    if (oldIndex < 0 || newIndex < 0) return
    onReorder?.(arrayMove(ids, oldIndex, newIndex))
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        {grid}
      </SortableContext>
    </DndContext>
  )
}

const ROW = 64 // px per height unit when a card has a fixed height

function SortableCard({
  block,
  edit,
  onRemove,
  onResize,
}: {
  block: BlockItem
  edit: boolean
  onRemove?: (id: string) => void
  onResize?: (id: string, dims: { w?: number; h?: number }) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
    disabled: !edit,
  })
  const cardRef = useRef<HTMLElement | null>(null)
  const setRefs = (el: HTMLElement | null) => {
    setNodeRef(el)
    cardRef.current = el
  }

  // Resize: right edge = width (column span 2–12), bottom edge = height (row
  // units), corner = both. Height is only fixed once dragged; until then the
  // card auto-sizes to its content (stays clean).
  const resizing = useRef<
    { axis: 'x' | 'y' | 'xy'; startX: number; startY: number; colW: number; span: number; startH: number } | null
  >(null)
  function resizeDown(axis: 'x' | 'y' | 'xy') {
    return (e: ReactPointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const el = cardRef.current
      if (!el) return
      resizing.current = {
        axis,
        startX: e.clientX,
        startY: e.clientY,
        colW: el.offsetWidth / block.layout.w,
        span: block.layout.w,
        startH: el.offsetHeight,
      }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    }
  }
  function calc(e: ReactPointerEvent) {
    const r = resizing.current!
    const out: { w?: number; h?: number } = {}
    if (r.axis === 'x' || r.axis === 'xy') {
      const dCols = Math.round((e.clientX - r.startX) / Math.max(1, r.colW))
      out.w = Math.max(2, Math.min(12, r.span + dCols))
    }
    if (r.axis === 'y' || r.axis === 'xy') {
      const newPx = Math.max(2 * ROW, r.startH + (e.clientY - r.startY))
      out.h = Math.max(2, Math.round(newPx / ROW))
    }
    return out
  }
  function resizeMove(e: ReactPointerEvent) {
    if (!resizing.current) return
    e.preventDefault()
    const el = cardRef.current
    if (!el) return
    const d = calc(e)
    if (d.w !== undefined) el.style.gridColumn = `span ${d.w}` // live width
    if (d.h !== undefined) el.style.height = d.h * ROW + 'px' // live height
  }
  function resizeUp(e: ReactPointerEvent) {
    if (!resizing.current) return
    const d = calc(e)
    resizing.current = null
    onResize?.(block.id, d)
  }

  const fixedH = block.layout.h > 0
  const style: CSSProperties = {
    gridColumn: `span ${block.layout.w}`,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    zIndex: isDragging ? 10 : undefined,
    position: 'relative',
    cursor: edit ? 'grab' : 'default',
    ...(fixedH ? { height: block.layout.h * ROW, display: 'flex', flexDirection: 'column' } : {}),
  }
  const handleBase: CSSProperties = { position: 'absolute', zIndex: 6, touchAction: 'none' }
  return (
    <div ref={setRefs} style={style} {...(edit ? { ...attributes, ...listeners } : {})}>
      {edit && onRemove && (
        <button
          type="button"
          title="Remove card"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onRemove(block.id)
          }}
          style={{
            position: 'absolute', top: 6, right: 6, zIndex: 7,
            width: 24, height: 24, borderRadius: 7, cursor: 'pointer',
            border: '1px solid var(--line)', background: 'var(--bg-1, #fff)',
            color: 'var(--neg, #d33)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 13, lineHeight: 1,
            boxShadow: '0 1px 4px rgba(0,0,0,.12)',
          }}
        >
          ✕
        </button>
      )}
      <div style={fixedH ? { flex: 1, minHeight: 0, overflow: 'hidden' } : undefined}>{block.node}</div>
      {edit && onResize && (
        <>
          {/* right edge → width */}
          <div title="Drag to resize width" onPointerDown={resizeDown('x')} onPointerMove={resizeMove} onPointerUp={resizeUp} onPointerCancel={resizeUp}
            style={{ ...handleBase, top: 0, right: -4, bottom: 0, width: 12, cursor: 'ew-resize' }} />
          {/* bottom edge → height */}
          <div title="Drag to resize height" onPointerDown={resizeDown('y')} onPointerMove={resizeMove} onPointerUp={resizeUp} onPointerCancel={resizeUp}
            style={{ ...handleBase, left: 0, right: 0, bottom: -4, height: 12, cursor: 'ns-resize' }} />
          {/* corner → both, with a visible grip */}
          <div title="Drag to resize" onPointerDown={resizeDown('xy')} onPointerMove={resizeMove} onPointerUp={resizeUp} onPointerCancel={resizeUp}
            style={{
              ...handleBase, right: 0, bottom: 0, width: 22, height: 22, cursor: 'nwse-resize',
              borderRight: '3px solid var(--accent, #6366f1)', borderBottom: '3px solid var(--accent, #6366f1)',
              borderBottomRightRadius: 8, opacity: 0.65,
            }} />
        </>
      )}
    </div>
  )
}
