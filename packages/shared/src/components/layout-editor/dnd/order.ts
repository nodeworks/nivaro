import {
  applyLayoutOps,
  HEADER_GROUP_KEY,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  type PlacementKey,
  type PlacementPatch,
  UNGROUPED_KEY
} from '../../../lib/layout-ops'
import type { DesignTarget } from '../design-context'
import { bodyZone, type DndRole, type DropSide, dndRole } from './collision'

// One ordering model (spec §7.5): a drop becomes the same ops the server
// applies, with indexes counted in the order applyLayoutOps keeps — so the
// canvas after the drop and the form after a reload agree.

// Renumber the way applyLayoutOps does (its tie rules included), so the
// indexes below are counted in exactly the order the ops will see.
function normalized(bundle: LayoutBundle): LayoutBundle {
  try {
    return applyLayoutOps(bundle, [{ op: 'layout_update', patch: {} }])
  } catch {
    return bundle
  }
}

const bySort = <T extends { sort: number }>(rows: T[]) => [...rows].sort((a, b) => a.sort - b.sort)

/** A zone's placements in order (slot cards live in the canvas order instead). */
function zoneFields(b: LayoutBundle, zone: string | null): PlacementKey[] {
  return bySort(b.placements.filter((p) => p.group_key === zone && !isCanvasSlot(p))).map((p) => ({
    field: p.field,
    group_key: p.group_key
  }))
}

/** One parent's order: groups, plus — at the top level — the slot cards. */
function siblings(b: LayoutBundle, parent: string | null): string[] {
  const rows = [
    ...b.groups.filter((g) => g.parent_key === parent).map((g) => ({ key: g.key, sort: g.sort })),
    ...(parent === null
      ? b.placements.filter((p) => isCanvasSlot(p)).map((p) => ({ key: p.field, sort: p.sort }))
      : [])
  ]
  return bySort(rows).map((r) => r.key)
}

function parentOf(b: LayoutBundle, key: string): string | null | undefined {
  const g = b.groups.find((x) => x.key === key)
  if (g) return g.parent_key
  return b.placements.some((p) => p.field === key && isCanvasSlot(p)) ? null : undefined
}

function moveItem(
  b: LayoutBundle,
  from: PlacementKey,
  zone: string | null,
  at: (rest: PlacementKey[]) => number
): LayoutOp[] {
  const same = (p: PlacementKey) => p.field === from.field && p.group_key === from.group_key
  const current = zoneFields(b, from.group_key)
  if (!current.some(same)) return []
  if (zone !== from.group_key && zoneFields(b, zone).some((p) => p.field === from.field)) return []
  const rest = zoneFields(b, zone).filter((p) => !same(p))
  const index = at(rest)
  if (index < 0) return []
  if (zone === from.group_key && index === current.findIndex(same)) return []
  return [{ op: 'move', from, to_group_key: zone, index }]
}

// The member of `parent`'s order that `over` sits in: a field stands for its
// group, a tab for its container, an Ungrouped field for the Ungrouped zone.
function siblingFor(b: LayoutBundle, over: DndRole, parent: string | null): string | null {
  let key: string | null =
    over.kind === 'group' ? over.key : over.kind === 'item' ? (over.zone ?? UNGROUPED_KEY) : null
  for (let hops = 0; key !== null && hops < 8; hops++) {
    const p = parentOf(b, key)
    if (p === undefined) return null
    if (p === parent) return key
    key = p
  }
  return null
}

/**
 * A slot that would land in the Ungrouped zone but is a slot card there
 * (isCanvasSlot: owners, PDF, extension slots): it goes into the canvas order
 * beside the Ungrouped card, and that card is where the drop line shows.
 */
export function landsOnCanvas(bundle: LayoutBundle, active: DesignTarget, over: DesignTarget) {
  if (active.kind !== 'slot' || active.group_key === null) return false
  if (!isCanvasSlot({ field: active.field, group_key: null })) return false
  const o = dndRole(bundle, over)
  return (o?.kind === 'item' && o.zone === null) || (o?.kind === 'group' && o.key === UNGROUPED_KEY)
}

/**
 * The ops a drop of `active` over `over` makes, `pointer` saying which side
 * of `over` it lands on. Empty when the drop changes nothing or is not
 * allowed (a field onto a container or a slot card, a field into a group
 * that already holds it, a tab out of its container).
 *
 * Fields move as the one placement dragged (field + group_key), so a twin
 * elsewhere (header strip + body, two groups) stays where it is. Over a
 * group: `before` = first in it (the header), `after` = last.
 */
export function orderAfterDrop(
  bundle: LayoutBundle,
  active: DesignTarget,
  over: DesignTarget,
  pointer: DropSide
): LayoutOp[] {
  const b = normalized(bundle)
  const a = dndRole(b, active)
  const o = dndRole(b, over)
  if (!a || !o) return []
  const after = pointer === 'after' ? 1 : 0

  if (a.kind === 'header') {
    if (o.kind !== 'header' || active.kind !== 'header' || over.kind !== 'header') return []
    const from = { field: active.field, group_key: HEADER_GROUP_KEY }
    return moveItem(b, from, HEADER_GROUP_KEY, (rest) => {
      const i = rest.findIndex((p) => p.field === over.field)
      return i < 0 ? -1 : i + after
    })
  }

  if (a.kind === 'item') {
    if (active.kind === 'group' || active.kind === 'header') return []
    const from = { field: active.field, group_key: a.zone }
    if (landsOnCanvas(b, active, over)) {
      // Owners / PDF / extension slots leaving a section for the Ungrouped
      // zone become slot cards: placed in the canvas order beside the
      // Ungrouped card (above it for `before`, below for `after`).
      if (b.placements.some((p) => p.field === from.field && p.group_key === null)) return []
      const u = siblings(b, null).indexOf(UNGROUPED_KEY)
      if (u < 0) return []
      return [{ op: 'move', from, to_group_key: null, index: u + after }]
    }
    if (o.kind === 'item' && (over.kind === 'field' || over.kind === 'slot')) {
      return moveItem(b, from, o.zone, (rest) => {
        const i = rest.findIndex((p) => p.field === over.field)
        return i < 0 ? -1 : i + after
      })
    }
    if (o.kind === 'group' && o.body) {
      return moveItem(b, from, bodyZone(o.key), (rest) => (after ? rest.length : 0))
    }
    return []
  }

  // Groups, the Ungrouped zone and slot cards: reorder within the parent.
  if (a.kind !== 'group') return []
  const order = siblings(b, a.parent)
  const overKey = siblingFor(b, o, a.parent)
  if (!overKey || overKey === a.key || !order.includes(a.key)) return []
  const rest = order.filter((k) => k !== a.key)
  const index = rest.indexOf(overKey) + after
  if (index === order.indexOf(a.key)) return []
  return [{ op: 'group_move', key: a.key, parent_key: a.parent, index }]
}

/**
 * The ops a drop of something new from the Add panel makes: one `place` of
 * `field` where `over` (and `pointer`) say, counted the way orderAfterDrop
 * counts a move. Slot cards (pipeline, comments, owners, …) go into the page
 * order beside the section they are dropped on; fields and widgets beside a
 * field, first in a section (its header) or last in it; header tiles beside a
 * tile. Empty when the field is already in that group or the spot takes
 * nothing.
 */
export function placeAfterDrop(
  bundle: LayoutBundle,
  field: string,
  over: DesignTarget,
  pointer: DropSide,
  patch?: PlacementPatch
): LayoutOp[] {
  const b = normalized(bundle)
  const o = dndRole(b, over)
  if (!o) return []
  const after = pointer === 'after' ? 1 : 0
  const place = (zone: string | null, index: number): LayoutOp[] =>
    index < 0 || b.placements.some((p) => p.field === field && p.group_key === zone)
      ? []
      : [{ op: 'place', field, group_key: zone, index, ...(patch ? { patch } : {}) }]
  const beside = (zone: string | null, key: string) => {
    const i = zoneFields(b, zone).findIndex((p) => p.field === key)
    return i < 0 ? -1 : i + after
  }

  if (o.kind === 'header')
    return over.kind === 'header'
      ? place(HEADER_GROUP_KEY, beside(HEADER_GROUP_KEY, over.field))
      : []
  if (isCanvasSlot({ field, group_key: null })) {
    const overKey = siblingFor(b, o, null)
    return overKey ? place(null, siblings(b, null).indexOf(overKey) + after) : []
  }
  if (o.kind === 'item' && (over.kind === 'field' || over.kind === 'slot'))
    return place(o.zone, beside(o.zone, over.field))
  if (o.kind === 'group' && o.body) {
    const zone = bodyZone(o.key)
    return place(zone, after ? zoneFields(b, zone).length : 0)
  }
  return []
}

/** The undo/history label for a drop. */
export function dropLabel(bundle: LayoutBundle | null, active: DesignTarget): string {
  switch (active.kind) {
    case 'field':
      return 'Move field'
    case 'header':
      return 'Move header tile'
    case 'slot':
      return active.group_key === null ? 'Move panel' : 'Move field'
    case 'group': {
      if (active.key === UNGROUPED_KEY) return 'Move ungrouped fields'
      const g = bundle?.groups.find((x) => x.key === active.key)
      if (!g) return 'Move section'
      return `Move ${g.type === 'tab' ? 'tab' : 'section'} "${g.label}"`
    }
  }
}
