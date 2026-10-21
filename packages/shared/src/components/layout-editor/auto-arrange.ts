import type { LayoutBundle, LayoutOp, PlacementRow } from '../../lib/layout-ops'
import {
  fieldZones,
  flagOn,
  GRID_WIDTHS,
  keyOf,
  normalizedBundle,
  storedWidth,
  widthOf,
  zoneItems
} from './field-zones'

// Auto-arrange (#2604): pack each section's fields into tidy rows of the
// record form's 12-column grid and close the gaps. The grid places fields in
// order and starts a new row when one does not fit, so a ½ field after a ⅓
// one leaves a hole at the end of the row. Packing pulls a later field that
// fits into the hole (looking a few fields ahead, so the order mostly holds);
// a row that still has room can have its fields widened to fill it. Pure:
// the editor shows the plan, then applies its ops as one undoable step.

const COLS = 12

/** Rows the grid makes from widths in this order (indexes into `widths`). */
export function gridRows(widths: number[]): number[][] {
  const rows: number[][] = []
  let used = COLS
  widths.forEach((w, i) => {
    if (used + w > COLS) {
      rows.push([i])
      used = w
    } else {
      rows[rows.length - 1].push(i)
      used += w
    }
  })
  return rows
}

/** Rows with room left at the end. */
export function gapCount(widths: number[]): number {
  return gridRows(widths).filter((r) => r.reduce((s, i) => s + widths[i], 0) < COLS).length
}

/**
 * Pack widths into rows, keeping their order where it can: each row starts
 * with the next field, then takes the widest of the following `lookahead`
 * fields that fits the room left, until none does.
 */
export function packRows(widths: number[], lookahead = 3): number[][] {
  const pending = widths.map((_, i) => i)
  const rows: number[][] = []
  while (pending.length) {
    const first = pending.shift() as number
    const row = [first]
    let room = COLS - widths[first]
    while (room > 0) {
      // Best fit: the widest of the next few that fits (the earliest on a tie).
      let j = -1
      pending.slice(0, lookahead).forEach((i, k) => {
        if (widths[i] <= room && (j < 0 || widths[i] > widths[pending[j]])) j = k
      })
      if (j < 0) break
      const [i] = pending.splice(j, 1)
      row.push(i)
      room -= widths[i]
    }
    rows.push(row)
  }
  return rows
}

/**
 * Widths that fill one row exactly, none narrower than it was: the smallest
 * total widening, then the most even. Null when the row is full or cannot be
 * filled with the grid's widths.
 */
export function fillRow(widths: number[]): number[] | null {
  if (widths.reduce((s, w) => s + w, 0) >= COLS) return null
  let best: { ws: number[]; grow: number; spread: number } | null = null
  const walk = (i: number, acc: number[], sum: number) => {
    if (sum > COLS) return
    if (i === widths.length) {
      if (sum !== COLS) return
      const grow = acc.reduce((s, w, k) => s + w - widths[k], 0)
      const spread = Math.max(...acc) - Math.min(...acc)
      if (!best || grow < best.grow || (grow === best.grow && spread < best.spread))
        best = { ws: [...acc], grow, spread }
      return
    }
    for (const w of [...GRID_WIDTHS].reverse())
      if (w >= widths[i]) walk(i + 1, [...acc, w], sum + w)
  }
  walk(0, [], 0)
  return (best as { ws: number[] } | null)?.ws ?? null
}

export interface ArrangedZone {
  key: string | null
  label: string
  /** Fields that change place. */
  moved: number
  widened: Array<{ field: string; from: number; to: number }>
  rowsBefore: number
  rowsAfter: number
  gapsBefore: number
  gapsAfter: number
}

export interface ArrangePlan {
  ops: LayoutOp[]
  /** Zones the plan changes. */
  zones: ArrangedZone[]
  /** Zones looked at (changed or already tidy). */
  checked: number
}

export interface ArrangeOptions {
  /** Only this zone (a group key, null = Ungrouped); absent = the whole form. */
  zone?: string | null
  /** Widen fields so rows with room left fill up. Default true. */
  widen?: boolean
  lookahead?: number
}

/** A row hidden on the form takes no room: it rides along after the field before it. */
const takesRoom = (p: PlacementRow) => !flagOn(p, 'hidden') && p.is_visible !== false

export function planAutoArrange(bundle: LayoutBundle, opts: ArrangeOptions = {}): ArrangePlan {
  const b = normalizedBundle(bundle)
  const widen = opts.widen ?? true
  const all = fieldZones(b)
  const zones = opts.zone === undefined ? all : all.filter((z) => z.key === opts.zone)
  const ops: LayoutOp[] = []
  const changed: ArrangedZone[] = []
  for (const zone of zones) {
    const items = zoneItems(b, zone.key)
    const shown = items.filter(takesRoom)
    if (shown.length === 0) continue
    const before = shown.map(widthOf)
    const rows = packRows(before, opts.lookahead)
    const after = [...before]
    const widened: ArrangedZone['widened'] = []
    if (widen)
      for (const row of rows) {
        const filled = fillRow(row.map((i) => before[i]))
        if (!filled) continue
        row.forEach((i, k) => {
          if (filled[k] === before[i]) return
          after[i] = filled[k]
          widened.push({ field: shown[i].field, from: before[i], to: filled[k] })
        })
      }
    // New order of the shown rows; hidden ones follow the row they came after.
    const packed = rows.flat().map((i) => shown[i])
    const order: PlacementRow[] = items.filter((p) => !takesRoom(p) && !precededByShown(items, p))
    for (const p of packed) {
      order.push(p)
      for (let k = items.indexOf(p) + 1; k < items.length && !takesRoom(items[k]); k++)
        order.push(items[k])
    }
    // Moves: bring each row of the new order to its index, front to back.
    const cur = [...items]
    let moved = 0
    order.forEach((p, i) => {
      if (cur[i] === p) return
      cur.splice(cur.indexOf(p), 1)
      cur.splice(i, 0, p)
      ops.push({ op: 'move', from: keyOf(p), to_group_key: zone.key, index: i })
      moved++
    })
    for (const w of widened) {
      const p = shown.find((x) => x.field === w.field) as PlacementRow
      ops.push({ op: 'update_placement', at: keyOf(p), patch: { col_span: storedWidth(w.to) } })
    }
    if (moved === 0 && widened.length === 0) continue
    const packedWidths = rows.flat().map((i) => after[i])
    changed.push({
      key: zone.key,
      label: zone.label,
      moved,
      widened,
      rowsBefore: gridRows(before).length,
      rowsAfter: gridRows(packedWidths).length,
      gapsBefore: gapCount(before),
      gapsAfter: gapCount(packedWidths)
    })
  }
  return { ops, zones: changed, checked: zones.length }
}

function precededByShown(items: PlacementRow[], p: PlacementRow): boolean {
  for (let k = items.indexOf(p) - 1; k >= 0; k--) if (takesRoom(items[k])) return true
  return false
}
