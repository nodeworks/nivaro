import {
  applyLayoutOps,
  type GroupRow,
  HEADER_GROUP_KEY,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  type PlacementPatch,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import type { DesignTarget } from './design-context'

// Where the Add panel puts things: right after whatever is selected on the
// canvas. Pure, so the rules are tested apart from the panel.

// Renumbered copy: every row's `sort` is then its index in its container.
const normalize = (b: LayoutBundle) => applyLayoutOps(b, [{ op: 'layout_update', patch: {} }])

const FIELD_HOLDERS = new Set(['section', 'tab', 'metadata'])

export interface Spot {
  group_key: string | null
  index: number
}

const zoneSize = (b: LayoutBundle, groupKey: string | null) =>
  b.placements.filter((p) => p.group_key === groupKey && !isCanvasSlot(p)).length

const topLevel = (b: LayoutBundle) => b.groups.filter((g) => g.parent_key === null)

/** The first group fields can go in, in page order (tabs inside containers count). */
function firstHolder(b: LayoutBundle): GroupRow | null {
  const ordered = [...topLevel(b)].sort((a, c) => a.sort - c.sort)
  for (const g of ordered) {
    if (FIELD_HOLDERS.has(g.type)) return g
    if (g.type === 'container') {
      const tab = b.groups.filter((t) => t.parent_key === g.key).sort((a, c) => a.sort - c.sort)[0]
      if (tab) return tab
    }
  }
  return null
}

function placementOf(t: DesignTarget | null): { field: string; group_key: string | null } | null {
  if (!t) return null
  if (t.kind === 'header') return { field: t.field, group_key: HEADER_GROUP_KEY }
  if (t.kind === 'field' || t.kind === 'slot') return { field: t.field, group_key: t.group_key }
  return null
}

/**
 * Where a field (or widget) lands: after the selected placement in its zone;
 * at the end of a selected section/tab (a container: its first tab); at the
 * end of the header strip when `to` is 'header'; otherwise at the end of the
 * first section (the Ungrouped zone when the form has none).
 */
export function fieldSpot(
  bundle: LayoutBundle,
  selected: DesignTarget | null,
  to: 'form' | 'header' = 'form'
): Spot {
  const b = normalize(bundle)
  const at = placementOf(selected)
  if (to === 'header') {
    if (at?.group_key === HEADER_GROUP_KEY) {
      const row = b.placements.find((p) => p.field === at.field && p.group_key === HEADER_GROUP_KEY)
      if (row) return { group_key: HEADER_GROUP_KEY, index: row.sort + 1 }
    }
    return { group_key: HEADER_GROUP_KEY, index: zoneSize(b, HEADER_GROUP_KEY) }
  }
  if (at && at.group_key !== HEADER_GROUP_KEY) {
    const row = b.placements.find((p) => p.field === at.field && p.group_key === at.group_key)
    if (row && !isCanvasSlot(row)) return { group_key: row.group_key, index: row.sort + 1 }
  }
  if (selected?.kind === 'group') {
    if (selected.key === UNGROUPED_KEY) return { group_key: null, index: zoneSize(b, null) }
    const g = b.groups.find((x) => x.key === selected.key)
    if (g && FIELD_HOLDERS.has(g.type)) return { group_key: g.key, index: zoneSize(b, g.key) }
    if (g?.type === 'container') {
      const tab = b.groups.filter((t) => t.parent_key === g.key).sort((a, c) => a.sort - c.sort)[0]
      if (tab) return { group_key: tab.key, index: zoneSize(b, tab.key) }
    }
  }
  const holder = firstHolder(b)
  return holder
    ? { group_key: holder.key, index: zoneSize(b, holder.key) }
    : { group_key: null, index: zoneSize(b, null) }
}

/** The top-level position just after the selection (its section when a field is selected). */
function topLevelAfter(b: LayoutBundle, selected: DesignTarget | null): number {
  const count = topLevel(b).length + b.placements.filter(isCanvasSlot).length
  if (!selected) return count
  const at = placementOf(selected)
  if (at) {
    const row = b.placements.find((p) => p.field === at.field && p.group_key === at.group_key)
    if (row && isCanvasSlot(row)) return row.sort + 1
    const key = at.group_key === null ? UNGROUPED_KEY : at.group_key
    return groupTopIndex(b, key, count)
  }
  if (selected.kind === 'group') return groupTopIndex(b, selected.key, count)
  return count
}

function groupTopIndex(b: LayoutBundle, key: string, fallback: number): number {
  let g = b.groups.find((x) => x.key === key)
  if (g?.parent_key) g = b.groups.find((x) => x.key === g?.parent_key)
  return g ? g.sort + 1 : fallback
}

/** A slot card (pipeline, comments, …) goes in the page order after the selection. */
export function slotSpot(bundle: LayoutBundle, selected: DesignTarget | null): Spot {
  return { group_key: null, index: topLevelAfter(normalize(bundle), selected) }
}

/** A key no group in the layout uses yet: `section`, `section_2`, … */
export function newGroupKey(bundle: LayoutBundle, base: string): string {
  const used = new Set(bundle.groups.map((g) => g.key))
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`
}

/**
 * A new section after the selection. When a tab (or a field in one) is
 * selected the new group is another tab of the same container — labelled
 * Step or Tab as the container shows them.
 */
export function sectionOp(bundle: LayoutBundle, selected: DesignTarget | null): LayoutOp {
  const b = normalize(bundle)
  const at = placementOf(selected)
  const key = selected?.kind === 'group' ? selected.key : (at?.group_key ?? null)
  const g = key ? b.groups.find((x) => x.key === key) : undefined
  const container =
    g?.type === 'container'
      ? g
      : g?.parent_key
        ? b.groups.find((x) => x.key === g.parent_key)
        : null
  if (container) {
    const steps = (container.tab_mode ?? b.layout.tab_mode) === 'steps'
    const tabs = b.groups.filter((x) => x.parent_key === container.key)
    const index = g && g.parent_key === container.key ? g.sort + 1 : tabs.length
    return {
      op: 'group_create',
      key: newGroupKey(b, steps ? 'step' : 'tab'),
      label: steps ? 'New step' : 'New tab',
      group_type: 'tab',
      parent_key: container.key,
      index
    }
  }
  return {
    op: 'group_create',
    key: newGroupKey(b, 'section'),
    label: 'New section',
    group_type: 'section',
    parent_key: null,
    index: topLevelAfter(b, selected)
  }
}

/** A gap on the canvas (#3181): in a field zone, or between the form's top-level parts. */
export type Gap = (Spot & { top: false }) | { top: true; index: number }

/**
 * The gap beside a canvas node: before or after a field (or header tile), at
 * the end of a section, tab or Ungrouped (a holder: its first tab), and for a
 * panel card or text block the top-level slot before or after it.
 */
export function gapSpot(bundle: LayoutBundle, t: DesignTarget, before: boolean): Gap | null {
  const b = normalize(bundle)
  if (t.kind === 'group') {
    if (t.key === UNGROUPED_KEY) return { top: false, group_key: null, index: zoneSize(b, null) }
    const g = b.groups.find((x) => x.key === t.key)
    if (!g) return null
    if (FIELD_HOLDERS.has(g.type) || g.type === 'container')
      return { top: false, ...fieldSpot(b, { kind: 'group', key: g.key }) }
    if (g.parent_key !== null) return null
    return { top: true, index: before ? g.sort : g.sort + 1 }
  }
  const gk = t.kind === 'header' ? HEADER_GROUP_KEY : t.group_key
  const row = b.placements.find((p) => p.field === t.field && p.group_key === gk)
  if (!row) return null
  if (isCanvasSlot(row)) return { top: true, index: before ? row.sort : row.sort + 1 }
  return { top: false, group_key: row.group_key, index: before ? row.sort : row.sort + 1 }
}

/** One `place` op for a field, widget or slot at `spot`. */
export function placeOp(field: string, spot: Spot, patch?: PlacementPatch): LayoutOp {
  return {
    op: 'place',
    field,
    group_key: spot.group_key,
    index: spot.index,
    ...(patch ? { patch } : {})
  }
}
