import {
  applyLayoutOps,
  HEADER_GROUP_KEY,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  type PlacementRow,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import { titleCase } from '../../lib/utils'
import { sectionLabel } from './canvas-diff'
import type { DesignTarget } from './design-context'
import { normalizedBundle } from './field-zones'
import { restorePieceOps } from './restore-piece'
import { slotName } from './slot-names'
import { checked, refuse, type StructurePlan } from './structure-ops'
import { humanizeOpError } from './useLayoutDraft'

/**
 * Revert one element (#3197): a field or section put back the way it is in a
 * baseline — the last saved form, or the form as this editing session opened
 * it — as one undoable change; the rest of the form stays as it is. Built on
 * restore-piece (the History "Piece" restore), with the cases a baseline adds:
 *
 * - a field that moved since: back to its section and place there;
 * - a field (or section) the baseline does not have: taken off again, a new
 *   section's fields going back where the baseline had them (or off the form).
 */

const byOrder = (a: { sort: number }, b: { sort: number }) => a.sort - b.sort

const zone = (b: LayoutBundle, key: string | null) =>
  b.placements.filter((p) => p.group_key === key && !isCanvasSlot(p)).sort(byOrder)

const gkOf = (t: Exclude<DesignTarget, { kind: 'group' }>) =>
  t.kind === 'header' ? HEADER_GROUP_KEY : t.group_key

class Ops {
  list: LayoutOp[] = []
  /** The baseline does not have it: the revert takes it off. */
  isNew = false
  /** Where it ends up, to select afterwards. */
  select: DesignTarget | undefined
  constructor(public w: LayoutBundle) {}
  push(...ops: LayoutOp[]) {
    for (const op of ops) {
      this.w = applyLayoutOps(this.w, [op])
      this.list.push(op)
    }
  }
}

const groupExists = (b: LayoutBundle, key: string | null) =>
  key === null || key === HEADER_GROUP_KEY || b.groups.some((g) => g.key === key)

/** A field back where and how the baseline had it (its zone index included). */
function fieldBack(work: Ops, base: LayoutBundle, row: PlacementRow, home: PlacementRow) {
  work.select =
    home.group_key === HEADER_GROUP_KEY
      ? { kind: 'header', field: home.field }
      : {
          kind: home.field.startsWith('__') ? 'slot' : 'field',
          field: home.field,
          group_key: home.group_key
        }
  if (home.group_key !== row.group_key) {
    if (!groupExists(work.w, home.group_key))
      throw new Error(
        `Its saved section “${sectionLabel(base.groups, home.group_key)}” is not on the form — put that back first`
      )
    work.push({
      op: 'move',
      from: { field: row.field, group_key: row.group_key },
      to_group_key: home.group_key,
      index: Math.max(
        0,
        zone(base, home.group_key).findIndex((p) => p.field === home.field)
      )
    })
  }
  work.push(
    ...restorePieceOps(work.w, base, {
      kind: 'field',
      field: home.field,
      group_key: home.group_key
    })
  )
  // Its place among its neighbours, as the baseline had it.
  const want = zone(base, home.group_key).findIndex((p) => p.field === home.field)
  const now = zone(work.w, home.group_key).findIndex((p) => p.field === home.field)
  if (!isCanvasSlot(home) && want >= 0 && now >= 0 && want !== now) {
    const len = zone(work.w, home.group_key).length
    work.push({
      op: 'move',
      from: { field: home.field, group_key: home.group_key },
      to_group_key: home.group_key,
      index: Math.min(want, len - 1)
    })
  }
}

function revertField(
  current: LayoutBundle,
  base: LayoutBundle,
  t: Exclude<DesignTarget, { kind: 'group' }>
): Ops {
  const gk = gkOf(t)
  const row = current.placements.find((p) => p.field === t.field && p.group_key === gk)
  if (!row) throw new Error('That is no longer on this form')
  const work = new Ops(current)
  const same = base.placements.find((p) => p.field === t.field && p.group_key === gk)
  if (same) {
    fieldBack(work, base, row, same)
    return work
  }
  // Where the baseline had it and the form has it no more: it moved from there.
  const homes = base.placements.filter((p) => p.field === t.field)
  const free = homes.find(
    (h) => !current.placements.some((p) => p.field === h.field && p.group_key === h.group_key)
  )
  if (free) {
    fieldBack(work, base, row, free)
    return work
  }
  // Not on the baseline form here, nor moved from anywhere: it was added since.
  work.isNew = true
  work.push({ op: 'remove', at: { field: row.field, group_key: row.group_key } })
  return work
}

function revertGroup(current: LayoutBundle, base: LayoutBundle, key: string): Ops {
  if (key === UNGROUPED_KEY) throw new Error('Ungrouped is not a section')
  if (!current.groups.some((g) => g.key === key)) throw new Error('That section is no longer here')
  const work = new Ops(current)
  if (base.groups.some((g) => g.key === key)) {
    work.push(...restorePieceOps(current, base, { kind: 'group', key }))
    work.select = { kind: 'group', key }
    return work
  }
  work.isNew = true
  // A section added since: its tabs (deepest first) and it go; each field goes
  // back where the baseline had it when that place is free, else off the form.
  const order: string[] = []
  const visit = (k: string) => {
    for (const g of current.groups) if (g.parent_key === k) visit(g.key)
    order.push(k)
  }
  visit(key)
  for (const k of order) {
    if (base.groups.some((g) => g.key === k)) {
      // A saved tab that was moved under the new holder: back to where it was saved.
      work.push(...restorePieceOps(work.w, base, { kind: 'group', key: k }))
      continue
    }
    for (const p of zone(work.w, k)) {
      const home = base.placements.find(
        (h) =>
          h.field === p.field &&
          !work.w.placements.some((x) => x.field === h.field && x.group_key === h.group_key) &&
          groupExists(work.w, h.group_key) &&
          !order.includes(h.group_key ?? '')
      )
      if (home)
        work.push({
          op: 'move',
          from: { field: p.field, group_key: k },
          to_group_key: home.group_key,
          index: Math.max(
            0,
            zone(base, home.group_key).findIndex((x) => x.field === home.field)
          )
        })
      else work.push({ op: 'remove', at: { field: p.field, group_key: k } })
    }
    work.push({ op: 'group_remove', key: k, placements: 'delete' })
  }
  return work
}

export interface RevertOptions {
  fieldLabel?: (field: string) => string
  /** "saved" (the default) or "opened": the words the plan's label uses. */
  baseline?: 'saved' | 'opened'
}

/** The selected field or section back as `base` has it: one batch, or why it cannot. */
export function revertPlan(
  current: LayoutBundle,
  base: LayoutBundle | null,
  t: DesignTarget | null,
  opts: RevertOptions = {}
): StructurePlan {
  if (!t) return refuse('Select a field or section first')
  if (!base) return refuse('The saved form is still loading')
  const words = opts.baseline === 'opened' ? 'as it was when you opened the form' : 'as saved'
  const b = normalizedBundle(current)
  const sb = normalizedBundle(base)
  const name =
    t.kind === 'group'
      ? (() => {
          const g = b.groups.find((x) => x.key === t.key)
          return g ? g.label || titleCase(g.key) : titleCase(t.key)
        })()
      : t.field.startsWith('__')
        ? slotName(t.field)
        : (opts.fieldLabel?.(t.field) ?? titleCase(t.field))
  let work: Ops
  try {
    work = t.kind === 'group' ? revertGroup(b, sb, t.key) : revertField(b, sb, t)
  } catch (e) {
    return refuse(humanizeOpError((e as Error).message))
  }
  if (work.list.length === 0) return refuse(`${name} is already ${words}`)
  const isNew = work.isNew
  const notes = isNew
    ? [
        opts.baseline === 'opened'
          ? 'It was not on the form when you opened it: it comes off'
          : 'It is not on the saved form: it comes off'
      ]
    : []
  return checked(b, {
    ok: true,
    ops: work.list,
    label: isNew ? `Take ${name} off (not ${words})` : `Put ${name} back ${words}`,
    notes,
    select: isNew ? undefined : work.select
  })
}
