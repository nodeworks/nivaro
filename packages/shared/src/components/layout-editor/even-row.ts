import { isFolded, readGroupStructure } from '../../lib/form-structure'
import {
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type LayoutOp,
  type PlacementRow
} from '../../lib/layout-ops'
import { gridRows } from './auto-arrange'
import type { DesignTarget } from './design-context'
import {
  flagOn,
  GRID_WIDTHS,
  keyOf,
  normalizedBundle,
  plural,
  selectedPlacements,
  storedWidth,
  WIDTH_LABELS,
  widthOf,
  zoneItems
} from './field-zones'
import { checked, refuse, type StructurePlan } from './structure-ops'

// Even out a row (#3180): every field in the row of the selected field takes
// the same width, the row's 12 columns split evenly (2 → ½ each, 3 → ⅓,
// 4 → ¼). With several selected, every row they touch. Rows are the ones the
// record form's grid makes: fields in order, a new row when the next does not
// fit; hidden and folded fields take no room, and a "side by side under one
// label" row group is one full-width unit whose members even out together.
// The evened row fills its 12 columns exactly, so no other row reflows. One
// apply = one undo step.

const COLS = 12

/** Takes room in the grid: shown, not behind the fold. */
const takesRoom = (p: PlacementRow) =>
  !flagOn(p, 'hidden') && p.is_visible !== false && !isFolded(p.overrides)

export interface EvenRow {
  zone: string | null
  members: PlacementRow[]
  /** The width each takes afterwards. */
  width: number
}

/** The grid row a placement sits in, or null (hidden, folded, header, table). */
export function rowOfPlacement(bundle: LayoutBundle, p: PlacementRow): PlacementRow[] | null {
  if (p.group_key === HEADER_GROUP_KEY || !takesRoom(p)) return null
  const b = normalizedBundle(bundle)
  const items = zoneItems(b, p.group_key)
  const group = p.group_key ? b.groups.find((g) => g.key === p.group_key) : null
  const rowGroups = readGroupStructure(group?.swap_config).rows
  const present = new Set(items.filter(takesRoom).map((x) => x.field))
  // A row group with two or more fields shown renders as one unit.
  const live = rowGroups.filter((r) => r.fields.filter((f) => present.has(f)).length >= 2)
  const own = live.find((r) => r.fields.includes(p.field))
  if (own) return items.filter((x) => takesRoom(x) && own.fields.includes(x.field))
  // Plain grid: each row-group unit is one full-width cell.
  const units: Array<{ width: number; members: PlacementRow[] }> = []
  const placed = new Set<string>()
  for (const x of items) {
    if (!takesRoom(x)) continue
    const rg = live.find((r) => r.fields.includes(x.field))
    if (rg) {
      if (placed.has(rg.key)) continue
      placed.add(rg.key)
      units.push({ width: COLS, members: [] })
      continue
    }
    units.push({ width: widthOf(x), members: [x] })
  }
  const rows = gridRows(units.map((u) => u.width))
  for (const r of rows) {
    const members = r.flatMap((i) => units[i].members)
    if (members.some((m) => m.field === p.field && m.group_key === p.group_key)) {
      // A row holding a row-group unit is that unit alone: nothing to share.
      return r.some((i) => units[i].members.length === 0) ? [p] : members
    }
  }
  return null
}

/** The even width for `n` fields side by side, if the grid has one. */
export function evenWidth(n: number): number | null {
  if (n < 1 || COLS % n !== 0) return null
  const w = COLS / n
  return (GRID_WIDTHS as readonly number[]).includes(w) ? w : null
}

const rowKey = (members: PlacementRow[]) =>
  members.map((m) => `${m.group_key ?? ''}:${m.field}`).join('|')

/** The rows a selection touches, each with the width it evens out to. */
export function rowsToEven(bundle: LayoutBundle, selection: DesignTarget[]): EvenRow[] {
  if (bundle.layout.layout_type === 'table') return []
  const out: EvenRow[] = []
  const seen = new Set<string>()
  for (const p of selectedPlacements(bundle, selection)) {
    const members = rowOfPlacement(bundle, p)
    if (!members) continue
    const k = rowKey(members)
    if (seen.has(k)) continue
    seen.add(k)
    // Five or more can only be a row group (its members share by width): ⅓ each is even.
    const width = evenWidth(members.length) ?? 4
    out.push({ zone: p.group_key, members, width })
  }
  return out
}

/** Why the action is not offered for this selection, or null. */
export function evenRowBlocked(bundle: LayoutBundle, selection: DesignTarget[]): string | null {
  const plan = evenRowPlan(bundle, selection)
  return plan.ok ? null : plan.reason
}

/** Even out the row of each selected field: one batch of width changes. */
export function evenRowPlan(bundle: LayoutBundle, selection: DesignTarget[]): StructurePlan {
  if (bundle.layout.layout_type === 'table') return refuse('Table columns have no rows')
  if (selectedPlacements(bundle, selection).length === 0)
    return refuse('Select a field in the row first')
  const rows = rowsToEven(bundle, selection)
  const shared = rows.filter((r) => r.members.length > 1)
  if (shared.length === 0)
    return refuse(
      rows.length ? 'The field is alone in its row' : 'Hidden and folded fields take no row'
    )
  const ops: LayoutOp[] = []
  let changed = 0
  for (const r of shared) {
    const before = ops.length
    for (const m of r.members)
      if (widthOf(m) !== r.width || (r.width === COLS && m.col_span != null))
        ops.push({
          op: 'update_placement',
          at: keyOf(m),
          patch: { col_span: storedWidth(r.width) }
        })
    if (ops.length > before) changed++
  }
  if (ops.length === 0)
    return refuse(shared.length === 1 ? 'This row is already even' : 'These rows are already even')
  const one = shared.length === 1 ? shared[0] : null
  const label = one
    ? `Even out a row: ${one.members.length} fields at ${WIDTH_LABELS[one.width]}`
    : `Even out ${plural(changed, 'row')}`
  return checked(bundle, { ok: true, ops, label, notes: [] })
}
