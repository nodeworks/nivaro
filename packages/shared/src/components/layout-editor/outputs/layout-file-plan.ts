import {
  applyLayoutOps,
  GROUP_PATCH_KEYS,
  type GroupRow,
  isCanvasSlot,
  LAYOUT_PATCH_KEYS,
  type LayoutBundle,
  type LayoutOp,
  newGroup,
  newPlacement,
  PLACEMENT_PATCH_KEYS,
  type PlacementRow,
  UNGROUPED_KEY
} from '../../../lib/layout-ops'
import { sameValue } from '../canvas-diff'

/**
 * Layout as a file (#3189), the editor half: the ops that turn the draft into
 * the layout an imported file describes (the API reads the YAML and answers
 * that target: routes/layout-file.ts). Applied as one undo step, saved like
 * any edit. The plan is checked by running it: whatever would still differ
 * afterwards is reported, never hidden.
 *
 * A field placed once on each side but in different sections MOVES (its row,
 * history and id stay); everything else is removed, placed or updated.
 */

export interface FileTarget {
  layout: Record<string, unknown>
  groups: GroupRow[]
  placements: PlacementRow[]
}

export interface FilePlan {
  ops: LayoutOp[]
  /** What would still differ after the ops (a refused op, an unknown shape). */
  remaining: string[]
  /** The draft as it would be with the ops applied. */
  after: LayoutBundle
}

type Obj = Record<string, unknown>
const GROUP_KEYS = GROUP_PATCH_KEYS as readonly string[]
const PLACEMENT_KEYS = PLACEMENT_PATCH_KEYS as readonly string[]
const pk = (field: string, group: string | null) => `${field}\u0000${group ?? ''}`
const bySort = <T extends { sort: number }>(a: T, b: T) => a.sort - b.sort

function patchOf(row: Obj, base: Obj, keys: readonly string[], skip: string[] = []): Obj {
  const out: Obj = {}
  for (const k of keys) {
    if (skip.includes(k) || !(k in row) || row[k] === undefined) continue
    if (!sameValue(row[k], base[k])) out[k] = row[k]
  }
  return out
}

/** Members of a container in order: tabs, or at the top level groups + Ungrouped + slot cards. */
function topMembers(b: { groups: GroupRow[]; placements: PlacementRow[] }, parent: string | null) {
  const rows: Array<{ key: string; sort: number }> = b.groups
    .filter((g) => g.parent_key === parent)
    .map((g) => ({ key: g.key, sort: g.sort }))
  if (parent === null)
    for (const p of b.placements) if (isCanvasSlot(p)) rows.push({ key: p.field, sort: p.sort })
  return rows.sort(bySort).map((r) => r.key)
}

function zoneOrder(b: { placements: PlacementRow[] }, zone: string | null): string[] {
  return b.placements
    .filter((p) => p.group_key === zone && !isCanvasSlot(p))
    .sort(bySort)
    .map((p) => p.field)
}

export function planFileOps(current: LayoutBundle, target: FileTarget): FilePlan {
  let work = applyLayoutOps(current, [])
  const ops: LayoutOp[] = []
  const remaining: string[] = []
  const run = (op: LayoutOp, what: string) => {
    try {
      work = applyLayoutOps(work, [op])
      ops.push(op)
    } catch (e) {
      remaining.push(`${what}: ${(e as Error).message}`)
    }
  }

  // 1. Form settings the file states.
  const layoutPatch: Obj = {}
  for (const k of LAYOUT_PATCH_KEYS as readonly string[])
    if (k in target.layout && !sameValue(work.layout[k], target.layout[k]))
      layoutPatch[k] = target.layout[k]
  if (Object.keys(layoutPatch).length)
    run({ op: 'layout_update', patch: layoutPatch as never }, 'Form settings')

  const tGroups = new Map(
    target.groups.filter((g) => g.key !== UNGROUPED_KEY).map((g) => [g.key, g])
  )
  const tPlaced = new Map(target.placements.map((p) => [pk(p.field, p.group_key), p]))
  const count = (list: PlacementRow[]) => {
    const m = new Map<string, number>()
    for (const p of list) m.set(p.field, (m.get(p.field) ?? 0) + 1)
    return m
  }
  const curCount = count(work.placements)
  const tgtCount = count(target.placements)
  // Placed once on both sides, in another zone: it moves instead.
  const movers = new Set(
    work.placements
      .filter(
        (p) =>
          curCount.get(p.field) === 1 &&
          tgtCount.get(p.field) === 1 &&
          !tPlaced.has(pk(p.field, p.group_key)) &&
          !isCanvasSlot(p) &&
          !target.placements.some((t) => t.field === p.field && isCanvasSlot(t))
      )
      .map((p) => p.field)
  )

  // 2. Placements the file does not have; movers wait in Ungrouped.
  for (const p of [...work.placements]) {
    if (tPlaced.has(pk(p.field, p.group_key))) continue
    const at = { field: p.field, group_key: p.group_key }
    if (movers.has(p.field)) {
      if (p.group_key !== null)
        run({ op: 'move', from: at, to_group_key: null, index: 9999 }, `Move ${p.field}`)
    } else run({ op: 'remove', at }, `Remove ${p.field}`)
  }

  // 3. Sections, steps and tabs the file does not have.
  for (const g of [...work.groups])
    if (g.key !== UNGROUPED_KEY && !tGroups.has(g.key) && work.groups.some((x) => x.key === g.key))
      run({ op: 'group_remove', key: g.key, placements: 'ungroup' }, `Remove ${g.label}`)

  // 4. Tabs changing holder wait at the top level; then settings and types.
  for (const g of work.groups) {
    const t = tGroups.get(g.key)
    if (t && g.parent_key !== null && g.parent_key !== t.parent_key)
      run({ op: 'group_move', key: g.key, parent_key: null, index: 9999 }, `Move ${g.label}`)
  }
  for (const g of [...work.groups]) {
    const t = tGroups.get(g.key)
    if (!t) continue
    const patch = patchOf(t as unknown as Obj, g as unknown as Obj, GROUP_KEYS)
    if (Object.keys(patch).length)
      run({ op: 'group_update', key: g.key, patch: patch as never }, `Change ${t.label}`)
  }

  // 5. New groups, holders before their tabs.
  const existing = () => new Set(work.groups.map((g) => g.key))
  const fresh = target.groups.filter((g) => g.key !== UNGROUPED_KEY && !existing().has(g.key))
  for (const g of [...fresh].sort(
    (a, b) => Number(a.parent_key != null) - Number(b.parent_key != null)
  )) {
    const base = newGroup(g.key, g.label, g.type, g.parent_key) as unknown as Obj
    const patch = patchOf(g as unknown as Obj, base, GROUP_KEYS, ['label', 'type'])
    run(
      {
        op: 'group_create',
        key: g.key,
        label: g.label,
        group_type: g.type,
        parent_key: g.parent_key,
        index: 9999,
        ...(Object.keys(patch).length ? { patch: patch as never } : {})
      },
      `Add ${g.label}`
    )
  }

  // 6. Placements: moved, placed or updated.
  for (const t of target.placements) {
    const here = work.placements.find((p) => p.field === t.field && p.group_key === t.group_key)
    if (!here && movers.has(t.field)) {
      const from = work.placements.find((p) => p.field === t.field)
      if (from)
        run(
          {
            op: 'move',
            from: { field: from.field, group_key: from.group_key },
            to_group_key: t.group_key,
            index: 9999
          },
          `Move ${t.field}`
        )
    }
    const row = work.placements.find((p) => p.field === t.field && p.group_key === t.group_key)
    if (!row) {
      const base = newPlacement(t.field, t.group_key) as unknown as Obj
      const patch = patchOf(t as unknown as Obj, base, PLACEMENT_KEYS)
      run(
        {
          op: 'place',
          field: t.field,
          group_key: t.group_key,
          index: 9999,
          ...(Object.keys(patch).length ? { patch: patch as never } : {})
        },
        `Add ${t.field}`
      )
      continue
    }
    const patch = patchOf(t as unknown as Obj, row as unknown as Obj, PLACEMENT_KEYS)
    if (Object.keys(patch).length)
      run(
        {
          op: 'update_placement',
          at: { field: t.field, group_key: t.group_key },
          patch: patch as never
        },
        `Change ${t.field}`
      )
  }

  // 7. Order inside each zone.
  const zones = new Set(target.placements.filter((p) => !isCanvasSlot(p)).map((p) => p.group_key))
  for (const zone of zones) {
    const want = zoneOrder(target, zone)
    want.forEach((field, i) => {
      if (zoneOrder(work, zone)[i] === field) return
      run(
        { op: 'move', from: { field, group_key: zone }, to_group_key: zone, index: i },
        `Order ${field}`
      )
    })
  }

  // 8. Order of sections, steps and tabs: the top level first, then each holder.
  const parents: Array<string | null> = [
    null,
    ...target.groups.filter((g) => g.type === 'container').map((g) => g.key)
  ]
  for (const parent of parents) {
    const want = topMembers(target, parent)
    want.forEach((key, i) => {
      const now = topMembers(work, parent)
      if (now[i] === key) return
      run({ op: 'group_move', key, parent_key: parent, index: i }, `Order ${key}`)
    })
  }

  return { ops, remaining: [...remaining, ...differences(work, target)], after: work }
}

/** What still differs between a bundle and a file target (empty = the plan reaches it). */
export function differences(b: LayoutBundle, t: FileTarget): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(t.layout))
    if ((LAYOUT_PATCH_KEYS as readonly string[]).includes(k) && !sameValue(b.layout[k], v))
      out.push(`The form setting ${k} differs`)
  const bg = new Map(b.groups.map((g) => [g.key, g]))
  for (const g of t.groups) {
    const have = bg.get(g.key)
    if (!have) {
      out.push(`${g.label} is missing`)
      continue
    }
    if (g.key === UNGROUPED_KEY) continue
    if (have.parent_key !== g.parent_key) out.push(`${g.label} sits somewhere else`)
    for (const k of GROUP_KEYS) {
      const want = (g as unknown as Obj)[k]
      if (want === undefined) continue
      if (!sameValue((have as unknown as Obj)[k], want)) out.push(`${g.label}: ${k} differs`)
    }
  }
  for (const g of b.groups)
    if (!t.groups.some((x) => x.key === g.key)) out.push(`${g.label} is still there`)
  const key = (p: PlacementRow) => pk(p.field, p.group_key)
  const bp = new Map(b.placements.map((p) => [key(p), p]))
  for (const p of t.placements) {
    const have = bp.get(key(p))
    if (!have) {
      out.push(`${p.field} is missing from ${p.group_key ?? 'Ungrouped'}`)
      continue
    }
    for (const k of PLACEMENT_KEYS)
      if (!sameValue((have as unknown as Obj)[k], (p as unknown as Obj)[k]))
        out.push(`${p.field}: ${k} differs`)
  }
  const tp = new Set(t.placements.map(key))
  for (const p of b.placements)
    if (!tp.has(key(p))) out.push(`${p.field} is still in ${p.group_key ?? 'Ungrouped'}`)
  for (const zone of new Set(t.placements.map((p) => p.group_key)))
    if (zoneOrder(b, zone).join('\u0000') !== zoneOrder(t, zone).join('\u0000'))
      out.push(`The order in ${zone ?? 'Ungrouped'} differs`)
  for (const parent of [null, ...t.groups.filter((g) => g.type === 'container').map((g) => g.key)])
    if (topMembers(b, parent).join('\u0000') !== topMembers(t, parent).join('\u0000'))
      out.push(`The order of ${parent ?? 'the form'} differs`)
  return [...new Set(out)]
}
