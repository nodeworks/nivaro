import type { CollisionDetection } from '@dnd-kit/core'
import {
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type LayoutOp,
  UNGROUPED_KEY
} from '../../../lib/layout-ops'
import { type DndNodeData, nodeData, TABLE_FORM_ZONES } from './collision'

// Drag something on the canvas onto the trash zone (bottom of the screen, shown only while a
// removable thing is dragged) to take it off this form. The same ops the inspector's Remove and
// the command bar use: a field, panel or header item loses its placement (its data is kept);
// a section goes with what it holds. One drop is one undo step, and nothing is saved until Save.

export const TRASH_DROP_ID = 'layout-trash'

export interface TrashDropData {
  layoutTrash: true
}

export function trashDropData(v: unknown): TrashDropData | null {
  const d = v as TrashDropData | null | undefined
  return d?.layoutTrash === true ? d : null
}

export interface TrashPlan {
  ops: LayoutOp[]
  /** 'section' drops what it holds too; the zone says so. */
  kind: 'field' | 'section'
  /** Placements a section takes with it. */
  holds: number
  /** Fields removed together (a dragged selection, #3178); absent = one. */
  count?: number
}

/** What dropping `d` on the trash does, or null when it cannot go there (an Add panel row,
 *  the Ungrouped zone, a table form zone, anything this layout does not own). */
export function trashPlan(bundle: LayoutBundle | null, d: DndNodeData | null): TrashPlan | null {
  if (!bundle || !d || d.add) return null
  const t = d.target
  if (t.kind === 'group') {
    if (t.key === UNGROUPED_KEY || TABLE_FORM_ZONES.includes(t.key)) return null
    if (!bundle.groups.some((g) => g.key === t.key)) return null
    // group_remove alone promotes child tabs into the removed group's place, so its tabs (and
    // theirs) go first, deepest first: the section leaves with everything it holds.
    const order: string[] = []
    const visit = (key: string) => {
      for (const g of bundle.groups) if (g.parent_key === key) visit(g.key)
      order.push(key)
    }
    visit(t.key)
    const under = new Set(order)
    const holds = bundle.placements.filter((p) => p.group_key && under.has(p.group_key)).length
    return {
      ops: order.map((key) => ({ op: 'group_remove', key, placements: 'delete' }) as LayoutOp),
      kind: 'section',
      holds
    }
  }
  const group = t.kind === 'header' ? HEADER_GROUP_KEY : (t.group_key ?? null)
  const placed = bundle.placements.some(
    (p) => p.field === t.field && (p.group_key ?? null) === group
  )
  if (!placed) return null
  return {
    ops: [{ op: 'remove', at: { field: t.field, group_key: group } }],
    kind: 'field',
    holds: 0
  }
}

/** What dropping several carried fields on the trash does (#3178): each loses its placement. */
export function trashPlanMany(
  bundle: LayoutBundle | null,
  list: Array<DndNodeData | null>
): TrashPlan | null {
  if (list.length <= 1) return trashPlan(bundle, list[0] ?? null)
  const plans = list.map((d) => trashPlan(bundle, d)).filter((p): p is TrashPlan => p != null)
  if (plans.length === 0) return null
  if (plans.length === 1) return plans[0]
  return { ops: plans.flatMap((p) => p.ops), kind: 'field', holds: 0, count: plans.length }
}

type Rect = { left: number; right: number; top: number; bottom: number }
const inside = (r: Rect, p: { x: number; y: number }) =>
  p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom

/**
 * `inner`, plus: a removable drag whose pointer is over the trash collides with the trash
 * first. Pointer only — from the keyboard, the inspector's Remove does the same.
 */
export function trashAwareCollision(
  inner: CollisionDetection,
  isTrashable: (d: DndNodeData | null) => boolean
): CollisionDetection {
  return (args) => {
    const p = args.pointerCoordinates
    if (p && isTrashable(nodeData(args.active.data.current))) {
      for (const c of args.droppableContainers) {
        if (c.disabled || !trashDropData(c.data.current)) continue
        const r = args.droppableRects.get(c.id)
        if (r && inside(r, p)) return [{ id: c.id, data: { droppableContainer: c } }]
      }
    }
    return inner(args)
  }
}
