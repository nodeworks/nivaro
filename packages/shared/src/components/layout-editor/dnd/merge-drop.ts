import type { Collision, CollisionDetection } from '@dnd-kit/core'
import type { CSSProperties } from 'react'
import { type DndNodeData, type DropHint, nodeData } from './collision'

// Drag a section onto another section's header to join them (#3198): the
// dragged one's fields follow the other's and it goes (section-structure.ts
// mergePlan, the same ops as Arrange → Join). The header's top edge still
// reorders — dropped there, the section goes before the other — so a
// section can be put back where it was without joining. Tabs and steps sit
// side by side: their middle joins, their outer quarters reorder.

/** How far into a stacked section's header the join zone starts, in px. */
export const MERGE_EDGE = 12

type Point = { x: number; y: number }
type Rect = { left: number; top: number; width: number; height: number }

/** Is `p` in the part of `over`'s header that joins (not the reorder edge)? */
export function inMergeZone(r: Rect, header: number, axis: 'x' | 'y', p: Point): boolean {
  if (header <= 0) return false
  if (p.y < r.top || p.y > r.top + header || p.x < r.left || p.x > r.left + r.width) return false
  if (axis === 'x') return p.x >= r.left + r.width / 4 && p.x <= r.left + (r.width * 3) / 4
  return p.y >= r.top + Math.min(MERGE_EDGE, header / 3)
}

/**
 * `inner`, plus: a section dragged (by pointer) over a section's header that
 * it may join collides as a merge (`hint.merge`). The keyboard keeps plain
 * reordering; Arrange → Join does the same from there.
 */
export function mergeAwareCollision(
  inner: CollisionDetection,
  canMerge: (active: DndNodeData, over: DndNodeData) => boolean
): CollisionDetection {
  return (args) => {
    const out = inner(args)
    const first = out[0] as Collision | undefined
    const p = args.pointerCoordinates
    const a = nodeData(args.active.data.current)
    if (!first || !p || !a || a.add || a.role.kind !== 'group') return out
    const data = first.data as {
      droppableContainer?: { data: { current?: unknown } }
      hint?: DropHint
    }
    const o = nodeData(data?.droppableContainer?.data.current)
    if (o?.role.kind !== 'group' || !data.hint) return out
    const r = args.droppableRects.get(first.id)
    const header = o.headerHeight?.() ?? 0
    if (!r || !inMergeZone(r, header, data.hint.axis, p) || !canMerge(a, o)) return out
    return [{ ...first, data: { ...data, hint: { ...data.hint, merge: true } } }, ...out.slice(1)]
  }
}

/** The join highlight over the header of the section the drop joins (no layout shift). */
export function mergeIndicatorStyle(headerHeight: number): CSSProperties {
  return {
    top: 0,
    left: 0,
    right: 0,
    height: headerHeight > 0 ? headerHeight : '100%',
    borderRadius: 8,
    backgroundColor: 'rgb(var(--nvr-cyan-rgb, 0 206 255) / 0.1)',
    boxShadow: 'inset 0 0 0 2px rgb(var(--nvr-cyan-rgb, 0 206 255))'
  }
}
