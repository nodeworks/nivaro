import {
  applyLayoutOps,
  type GroupRow,
  HEADER_GROUP_KEY,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  type PlacementKey,
  type PlacementRow,
  TABLE_FORM_GROUP_KEYS,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import { titleCase } from '../../lib/utils'
import { type DesignTarget, isMultiSelectable } from './design-context'
import { readOverrides, withOverride } from './inspector/model'

// The places fields live on a form, in page order, and the bulk edits the
// canvas selection, the placements table and the keyboard make on them. Pure:
// every function returns ops for the draft's apply (one call = one undo step).

/** Renumbered copy: every row's `sort` is then its index in its container. */
export function normalizedBundle(b: LayoutBundle): LayoutBundle {
  try {
    return applyLayoutOps(b, [{ op: 'layout_update', patch: {} }])
  } catch {
    return b
  }
}

const bySort = <T extends { sort: number }>(rows: T[]) => [...rows].sort((a, c) => a.sort - c.sort)

/** Groups that take fields (a container takes tabs, a text block takes text). */
export const FIELD_HOLDERS = new Set(['section', 'tab', 'metadata'])

export interface FieldZone {
  /** group_key of the placements in it; null = the Ungrouped zone. */
  key: string | null
  /** "Basic information", "Details › Billing", "Ungrouped". */
  label: string
}

const groupLabel = (g: GroupRow) => g.label || titleCase(g.key)

/**
 * Every zone a field can sit in, top to bottom: top-level sections, the tabs
 * of each tabs/steps holder, and the Ungrouped zone where it shows. Table
 * layouts: the columns, then their two extra forms.
 */
export function fieldZones(bundle: LayoutBundle): FieldZone[] {
  const b = normalizedBundle(bundle)
  if (b.layout.layout_type === 'table')
    return [
      { key: null, label: 'Columns' },
      { key: TABLE_FORM_GROUP_KEYS[0] as string, label: 'Apply values' },
      { key: TABLE_FORM_GROUP_KEYS[1] as string, label: 'Create with defaults' }
    ]
  const hasUngrouped =
    b.groups.some((g) => g.key === UNGROUPED_KEY) ||
    b.placements.some((p) => p.group_key === null && !isCanvasSlot(p))
  const out: FieldZone[] = []
  const top = bySort(b.groups.filter((g) => g.parent_key === null))
  for (const g of top) {
    if (g.key === UNGROUPED_KEY) {
      out.push({ key: null, label: 'Ungrouped' })
      continue
    }
    if (FIELD_HOLDERS.has(g.type)) out.push({ key: g.key, label: groupLabel(g) })
    else if (g.type === 'container')
      for (const tab of bySort(b.groups.filter((t) => t.parent_key === g.key)))
        if (FIELD_HOLDERS.has(tab.type))
          out.push({ key: tab.key, label: `${groupLabel(g)} › ${groupLabel(tab)}` })
  }
  if (hasUngrouped && !out.some((z) => z.key === null)) out.push({ key: null, label: 'Ungrouped' })
  return out
}

/** A zone's placements in order (page cards excluded: they sit in the page order). */
export function zoneItems(bundle: LayoutBundle, zone: string | null): PlacementRow[] {
  return bySort(bundle.placements.filter((p) => p.group_key === zone && !isCanvasSlot(p)))
}

export const keyOf = (p: { field: string; group_key: string | null }): PlacementKey => ({
  field: p.field,
  group_key: p.group_key
})

export const sameKey = (a: PlacementKey, b: PlacementKey) =>
  a.field === b.field && a.group_key === b.group_key

/** The placements a selection names (fields and in-section panels this layout owns). */
export function selectedPlacements(bundle: LayoutBundle, sel: DesignTarget[]): PlacementRow[] {
  const out: PlacementRow[] = []
  for (const t of sel) {
    if (!isMultiSelectable(t) || (t.kind !== 'field' && t.kind !== 'slot')) continue
    const row = bundle.placements.find((p) => p.field === t.field && p.group_key === t.group_key)
    if (row && !out.includes(row)) out.push(row)
  }
  return out
}

/** Page order of placements: by zone (fieldZones), then position in the zone. */
export function inPageOrder(bundle: LayoutBundle, rows: PlacementRow[]): PlacementRow[] {
  const b = normalizedBundle(bundle)
  const zones = fieldZones(b).map((z) => z.key)
  const pos = (p: PlacementRow) => {
    const n = b.placements.find((x) => sameKey(x, p))
    const z = zones.indexOf(p.group_key)
    return [z < 0 ? zones.length : z, n?.sort ?? 0] as const
  }
  return [...rows].sort((a, c) => {
    const [za, sa] = pos(a)
    const [zc, sc] = pos(c)
    return za - zc || sa - sc
  })
}

/** Widths the record form's 12-column grid takes (resolveColSpan); anything else is full. */
export const GRID_WIDTHS = [12, 6, 4, 3] as const

export const WIDTH_LABELS: Record<number, string> = { 12: 'Full', 6: '½', 4: '⅓', 3: '¼' }

export function widthOf(p: { col_span: number | null }): number {
  return (GRID_WIDTHS as readonly number[]).includes(p.col_span ?? 12) ? (p.col_span ?? 12) : 12
}

/** col_span as stored: full width is "not set". */
export const storedWidth = (w: number): number | null => (w === 12 ? null : w)

/** Fields only: panels and widgets have no required / read-only setting. */
export const isFieldRow = (p: { field: string }) => !p.field.startsWith('__')

export type FlagKey = 'required' | 'readonly' | 'hidden'

export const flagOn = (p: PlacementRow, k: FlagKey) => readOverrides(p)[k] === true

/** One width for every row given: update_placement per row whose width differs. */
export function widthOps(rows: PlacementRow[], width: number): LayoutOp[] {
  return rows
    .filter((p) => widthOf(p) !== width || (width === 12 && p.col_span != null))
    .map((p) => ({ op: 'update_placement', at: keyOf(p), patch: { col_span: storedWidth(width) } }))
}

/** Required / read-only / hidden on or off for every field given. */
export function flagOps(rows: PlacementRow[], k: FlagKey, on: boolean): LayoutOp[] {
  return rows
    .filter((p) => (k === 'hidden' || isFieldRow(p)) && flagOn(p, k) !== on)
    .map((p) => ({
      op: 'update_placement',
      at: keyOf(p),
      patch: { overrides: withOverride(p, k, on ? true : undefined) }
    }))
}

export interface MovePlan {
  ops: LayoutOp[]
  /** Where each moved placement is afterwards, in page order. */
  moved: PlacementKey[]
  /** Already there, or the zone already holds that field. */
  skipped: number
}

/**
 * Move placements to the end of `to`, keeping their page order. A field the
 * zone already holds (a twin) stays where it is; so do panels that would turn
 * into page cards in the Ungrouped zone.
 */
export function moveToZoneOps(bundle: LayoutBundle, rows: PlacementRow[], to: string | null) {
  const b = normalizedBundle(bundle)
  const ops: LayoutOp[] = []
  const moved: PlacementKey[] = []
  let skipped = 0
  let end = zoneItems(b, to).length
  const taken = new Set(b.placements.filter((p) => p.group_key === to).map((p) => p.field))
  for (const p of inPageOrder(b, rows)) {
    if (
      p.group_key === to ||
      taken.has(p.field) ||
      isCanvasSlot({ field: p.field, group_key: to })
    ) {
      skipped++
      if (p.group_key === to) moved.push(keyOf(p))
      continue
    }
    ops.push({ op: 'move', from: keyOf(p), to_group_key: to, index: end++ })
    taken.add(p.field)
    moved.push({ field: p.field, group_key: to })
  }
  return { ops, moved, skipped } satisfies MovePlan
}

/** The design target a placement key is selected as. */
export function targetOfKey(k: PlacementKey): DesignTarget {
  if (k.group_key === HEADER_GROUP_KEY) return { kind: 'header', field: k.field }
  return {
    kind: k.field.startsWith('__') ? 'slot' : 'field',
    field: k.field,
    group_key: k.group_key
  }
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
