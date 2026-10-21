import {
  HEADER_GROUP_KEY,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import { titleCase } from '../../lib/utils'
import type { DesignTarget } from './design-context'
import { fieldZones, normalizedBundle, zoneItems } from './field-zones'
import { pinLocked, pinnedZone } from './pin'

// Alt+arrow on the canvas (#2603): the selected field or section moves one
// place in one keystroke — one apply, one undo step — without starting a
// keyboard drag (Space still picks a node up for dnd-kit).
//
// Fields: ↑ / ↓ one place within their section, ← / → to the end of the
// previous section / the start of the next (sections already holding that
// field are skipped). Sections and page cards: ↑ / ↓ one place in the page
// order; tabs and steps also take ← / →. Header tiles: any arrow, one place.

export type ArrowDir = 'up' | 'down' | 'left' | 'right'

export interface KeyMove {
  ops: LayoutOp[]
  label: string
  /** The moved thing afterwards (a field that changed section has a new key). */
  next: DesignTarget
}

export const ARROW_DIRS: Record<string, ArrowDir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right'
}

const step = (dir: ArrowDir) => (dir === 'up' || dir === 'left' ? -1 : 1)

// One parent's order: groups, plus — at the top level — the page cards.
function siblings(b: LayoutBundle, parent: string | null): string[] {
  const rows = [
    ...b.groups.filter((g) => g.parent_key === parent).map((g) => ({ key: g.key, sort: g.sort })),
    ...(parent === null
      ? b.placements.filter((p) => isCanvasSlot(p)).map((p) => ({ key: p.field, sort: p.sort }))
      : [])
  ]
  return rows.sort((x, y) => x.sort - y.sort).map((r) => r.key)
}

function groupName(b: LayoutBundle, key: string): string {
  if (key === UNGROUPED_KEY) return 'ungrouped fields'
  const g = b.groups.find((x) => x.key === key)
  if (!g) return 'panel'
  return `${g.type === 'tab' ? 'tab' : 'section'} "${g.label || titleCase(g.key)}"`
}

function moveInZone(
  b: LayoutBundle,
  t: DesignTarget & { field: string },
  zone: string | null,
  dir: ArrowDir
): KeyMove | null {
  const items = zoneItems(b, zone)
  const i = items.findIndex((p) => p.field === t.field)
  const to = i + step(dir)
  if (i < 0 || to < 0 || to >= items.length) return null
  return {
    ops: [{ op: 'move', from: { field: t.field, group_key: zone }, to_group_key: zone, index: to }],
    label: `Move ${t.kind === 'header' ? 'header tile' : 'field'} ${step(dir) < 0 ? 'up' : 'down'}`,
    next: t
  }
}

/** The ops one Alt+arrow makes for the selected `t`; null when it cannot move that way. */
export function altArrowMove(bundle: LayoutBundle, t: DesignTarget, dir: ArrowDir): KeyMove | null {
  const b = normalizedBundle(bundle)
  // Pinned sections (#2628) stay put and take nothing in.
  if (pinLocked(b, t)) return null

  if (t.kind === 'header') return moveInZone(b, t, HEADER_GROUP_KEY, dir)

  if ((t.kind === 'field' || t.kind === 'slot') && !isCanvasSlot(t)) {
    const zone = t.group_key
    if (!b.placements.some((p) => p.field === t.field && p.group_key === zone)) return null
    if (dir === 'up' || dir === 'down') return moveInZone(b, t, zone, dir)
    const zones = fieldZones(b)
    const at = zones.findIndex((z) => z.key === zone)
    if (at < 0) return null
    for (let k = at + step(dir); k >= 0 && k < zones.length; k += step(dir)) {
      const z = zones[k]
      if (b.placements.some((p) => p.field === t.field && p.group_key === z.key)) continue
      if (pinnedZone(b, z.key)) continue
      // A panel moved into the Ungrouped zone would turn into a page card.
      if (isCanvasSlot({ field: t.field, group_key: z.key })) continue
      const index = dir === 'left' ? zoneItems(b, z.key).length : 0
      return {
        ops: [
          { op: 'move', from: { field: t.field, group_key: zone }, to_group_key: z.key, index }
        ],
        label: `Move field to ${z.label}`,
        next: { kind: t.kind, field: t.field, group_key: z.key }
      }
    }
    return null
  }

  // Sections, tabs, the Ungrouped zone and page cards: one place in their parent's order.
  const key = t.kind === 'group' ? t.key : t.field
  const g = b.groups.find((x) => x.key === key)
  const parent = g ? g.parent_key : null
  if ((dir === 'left' || dir === 'right') && parent === null) return null
  const order = siblings(b, parent)
  const i = order.indexOf(key)
  const to = i + step(dir)
  if (i < 0 || to < 0 || to >= order.length) return null
  return {
    ops: [{ op: 'group_move', key, parent_key: parent, index: to }],
    label: `Move ${t.kind === 'group' ? groupName(b, key) : 'panel'} ${
      parent === null ? (step(dir) < 0 ? 'up' : 'down') : step(dir) < 0 ? 'left' : 'right'
    }`,
    next: t
  }
}
