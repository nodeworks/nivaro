import type {
  ClientRect,
  Collision,
  CollisionDetection,
  DroppableContainer,
  KeyboardCoordinateGetter
} from '@dnd-kit/core'
import {
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  type PlacementPatch,
  UNGROUPED_KEY
} from '../../../lib/layout-ops'
import type { DesignTarget } from '../design-context'

// Typed drag and drop for the layout editor canvas (spec §7.5): what may land
// where, measured against the live layout on every move.

/**
 * What a node is to drag and drop. An item is one placement in a zone (a
 * group's fields, the Ungrouped zone, a slot inside a group); a group is a
 * member of its parent's order (top-level groups, the Ungrouped zone and the
 * slot cards share one order; tabs share their container's).
 */
export type DndRole =
  | { kind: 'item'; zone: string | null }
  | { kind: 'header' }
  | { kind: 'group'; key: string; parent: string | null; body: boolean }
  /** A tab / step / container-tab pane: takes fields for group `key`, nothing else. */
  | { kind: 'body'; key: string }

export type DropSide = 'before' | 'after'

/** Something new dragged from the Add panel: dropped, it becomes one `place` op. */
export interface AddSource {
  field: string
  /** Plain words for the undo step ("Add <label>") and the announcements. */
  label: string
  patch?: PlacementPatch
  /** Told the ops a drop applied (the Add panel selects what it added). */
  onAdded?: (ops: LayoutOp[]) => void
}

/** What every registered node carries in dnd-kit's data ref. */
export interface DndNodeData {
  target: DesignTarget
  role: DndRole
  /** A group's header strip height, measured live (0 or absent: none). */
  headerHeight?: () => number
  /** Set on an Add panel row: the drag places something new instead of moving. */
  add?: AddSource
}

/**
 * Where the drop goes relative to the collided node. `body`: a field into a
 * group's body — before = first in the group, after = last.
 */
export interface DropHint {
  side: DropSide
  axis: 'x' | 'y'
  body: boolean
}

/** The two extra forms of a table layout: zones with no group row, fields only. */
export const TABLE_FORM_ZONES: readonly string[] = ['__apply_values__', '__create_with_defaults__']

export function dndRole(bundle: LayoutBundle, t: DesignTarget): DndRole | null {
  switch (t.kind) {
    case 'field':
      return { kind: 'item', zone: t.group_key }
    case 'slot':
      return isCanvasSlot(t)
        ? { kind: 'group', key: t.field, parent: null, body: false }
        : { kind: 'item', zone: t.group_key }
    case 'header':
      return { kind: 'header' }
    case 'group': {
      if (t.key === UNGROUPED_KEY) return { kind: 'group', key: t.key, parent: null, body: true }
      if (TABLE_FORM_ZONES.includes(t.key))
        return { kind: 'group', key: t.key, parent: null, body: true }
      const g = bundle.groups.find((x) => x.key === t.key)
      if (!g) return null
      return { kind: 'group', key: g.key, parent: g.parent_key, body: g.type !== 'container' }
    }
  }
}

/** Fields land on fields and group bodies; groups on groups of the same parent. */
export function accepts(active: DndRole, over: DndRole): boolean {
  switch (active.kind) {
    case 'item':
      return over.kind === 'item' || over.kind === 'body' || (over.kind === 'group' && over.body)
    case 'header':
      return over.kind === 'header'
    case 'group':
      return over.kind === 'group' && over.parent === active.parent
    case 'body':
      return false
  }
}

/** The zone a group body holds: the Ungrouped zone is group_key null. */
export const bodyZone = (key: string) => (key === UNGROUPED_KEY ? null : key)

export function nodeData(v: unknown): DndNodeData | null {
  const d = v as DndNodeData | null | undefined
  return d?.target && d.role ? d : null
}

type Point = { x: number; y: number }
type Cand = { c: DroppableContainer; d: DndNodeData; r: ClientRect }

// A pointer this close to a target (and inside no other) still counts.
const NEAR = 24

const center = (r: ClientRect): Point => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
const contains = (r: ClientRect, p: Point) =>
  p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom
const edgeDistance = (r: ClientRect, p: Point) =>
  Math.hypot(Math.max(r.left - p.x, 0, p.x - r.right), Math.max(r.top - p.y, 0, p.y - r.bottom))
const nearest = (list: Cand[], p: Point) =>
  list.reduce<Cand | null>(
    (best, x) => (!best || edgeDistance(x.r, p) < edgeDistance(best.r, p) ? x : best),
    null
  )

const sameSpace = (a: DndRole, b: DndRole) =>
  (a.kind === 'item' && b.kind === 'item' && a.zone === b.zone) ||
  (a.kind === 'group' && b.kind === 'group' && a.parent === b.parent) ||
  (a.kind === 'header' && b.kind === 'header')

// Members of one order that sit side by side (tabs, header tiles, half-width
// fields) read left to right; stacked ones top to bottom.
function axisOf(hit: Cand, cands: Cand[]): 'x' | 'y' {
  const r = hit.r
  const beside = cands.some(
    (x) =>
      x !== hit &&
      sameSpace(x.d.role, hit.d.role) &&
      x.r.top < r.bottom - 1 &&
      x.r.bottom > r.top + 1 &&
      (x.r.left >= r.right - 1 || x.r.right <= r.left + 1)
  )
  return beside ? 'x' : 'y'
}

function sideOf(hit: Cand, cands: Cand[], p: Point): Omit<DropHint, 'body'> {
  const axis = axisOf(hit, cands)
  const c = center(hit.r)
  return { axis, side: (axis === 'x' ? p.x < c.x : p.y < c.y) ? 'before' : 'after' }
}

function candidates(
  containers: DroppableContainer[],
  rects: Map<DroppableContainer['id'], ClientRect>,
  active: DndNodeData
): Cand[] {
  const list: Cand[] = []
  for (const c of containers) {
    if (c.disabled) continue
    const d = nodeData(c.data.current)
    const r = rects.get(c.id)
    if (d && r && accepts(active.role, d.role)) list.push({ c, d, r })
  }
  return list
}

const collision = (x: Cand, hint: DropHint): Collision => ({
  id: x.c.id,
  data: { droppableContainer: x.c, hint }
})

/**
 * dnd-kit collision detection filtered by type: fields collide only with
 * field slots and group bodies/headers, groups only with groups of the same
 * parent (tabs with tabs of their container), header tiles with header
 * tiles. The innermost match under the pointer wins (the keyboard sensor has
 * no pointer: the dragged rect's centre stands in). A field over a group's
 * header goes first in it; over the rest of a group body it lands by the
 * nearest field there, or last when the group is empty. The winning
 * collision carries a DropHint in `data.hint`.
 */
export const typedCollision: CollisionDetection = (args) => {
  const active = nodeData(args.active.data.current)
  if (!active) return []
  const p = args.pointerCoordinates ?? center(args.collisionRect)
  const list = candidates(args.droppableContainers, args.droppableRects, active)
  const isBody = (x: Cand) =>
    active.role.kind === 'item' && (x.d.role.kind === 'group' || x.d.role.kind === 'body')

  const within = list
    .filter((x) => contains(x.r, p))
    .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height)
  let hit: Cand | null = within[0] ?? null
  if (!hit) {
    hit = nearest(
      list.filter((x) => !isBody(x)),
      p
    )
    if (!hit || edgeDistance(hit.r, p) > NEAR) return []
  }

  if (isBody(hit) && (hit.d.role.kind === 'group' || hit.d.role.kind === 'body')) {
    const header = hit.d.headerHeight?.() ?? 0
    if (header > 0 && p.y < hit.r.top + header)
      return [collision(hit, { side: 'before', axis: 'y', body: true })]
    const zone = bodyZone(hit.d.role.key)
    const fields = list.filter((x) => x.d.role.kind === 'item' && x.d.role.zone === zone)
    const near = nearest(fields, p)
    if (!near) return [collision(hit, { side: 'after', axis: 'y', body: true })]
    hit = near
  }
  return [collision(hit, { ...sideOf(hit, list, p), body: false })]
}

const FORWARD = ['ArrowDown', 'ArrowRight']
const BACK = ['ArrowUp', 'ArrowLeft']

/**
 * Keyboard drags step through the places the dragged node may land, in
 * reading order: arrow down/right moves after the next one, up/left before
 * the previous one. Fields also stop on empty groups.
 */
export const typedKeyboardCoordinates: KeyboardCoordinateGetter = (event, ctx) => {
  const forward = FORWARD.includes(event.code)
  if (!forward && !BACK.includes(event.code)) return undefined
  const { active, collisionRect, droppableRects, droppableContainers } = ctx.context
  const data = nodeData(active?.data.current)
  if (!active || !collisionRect || !data) return undefined
  event.preventDefault()

  const list = candidates(droppableContainers.getEnabled(), droppableRects, data)
  const filled = new Set(
    list.flatMap((x) => (x.d.role.kind === 'item' ? [x.d.role.zone ?? UNGROUPED_KEY] : []))
  )
  // A tab's pane stands for the tab: one stop per empty tab.
  const panes = new Set(list.flatMap((x) => (x.d.role.kind === 'body' ? [x.d.role.key] : [])))
  const stops = list
    .filter((x) => {
      if (data.role.kind !== 'item') return true
      if (x.d.role.kind === 'group' && panes.has(x.d.role.key)) return false
      return (x.d.role.kind !== 'group' && x.d.role.kind !== 'body') || !filled.has(x.d.role.key)
    })
    .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
  const p = center(collisionRect)
  const here = stops
    .filter((x) => contains(x.r, p))
    .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height)[0]
  const at = stops.indexOf(here ?? nearest(stops, p) ?? stops[0])
  const next = stops[at + (forward ? 1 : -1)]
  if (!next) return ctx.currentCoordinates
  const c = center(next.r)
  const nudge = forward ? 1 : -1
  return {
    x: ctx.currentCoordinates.x + c.x + nudge - p.x,
    y: ctx.currentCoordinates.y + c.y + nudge - p.y
  }
}
