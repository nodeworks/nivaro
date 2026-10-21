import {
  GROUP_PATCH_KEYS,
  type GroupRow,
  HEADER_GROUP_KEY,
  type LayoutBundle,
  PLACEMENT_PATCH_KEYS,
  type PlacementRow,
  sortBundleRows,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import { placementTarget } from './bundle-to-active'
import { type DesignTarget, type DiffMark, targetKey } from './design-context'

/**
 * "Show on canvas" (#2591): what changed between two states of a layout, drawn
 * on the form itself. `bundle` is the later state with every removed field and
 * section put back where it was (ghosts, marked 'removed'), so the canvas can
 * show them in place; `marks` says, per design target, what happened to it.
 * Moves within a section are not marked (a reorder shifts every sibling).
 */

export type DiffKind = DiffMark['kind']
export type { DiffMark }

export interface CanvasDiff {
  bundle: LayoutBundle
  marks: Map<string, DiffMark>
  counts: Record<DiffKind, number>
  /** Form settings (layout row) that differ. */
  settings: string[]
}

const LAYOUT_IGNORE = new Set(['id', 'collection', 'created_at', 'updated_at'])

function norm(v: unknown): unknown {
  if (typeof v === 'string') {
    const t = v.trim()
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return JSON.parse(t)
      } catch {
        return v
      }
    }
    return v === '' ? null : v
  }
  return v === undefined ? null : v
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

const pKey = (field: string, groupKey: string | null) => `${field}\u0000${groupKey ?? ''}`

export function sectionLabel(groups: GroupRow[], key: string | null): string {
  if (key == null || key === UNGROUPED_KEY) return 'Ungrouped'
  if (key === HEADER_GROUP_KEY) return 'Header'
  const g = groups.find((x) => x.key === key)
  return g?.label?.trim() || key
}

const changedKeys = (a: object, b: object, keys: readonly string[]) =>
  keys.filter(
    (k) => !sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  )

/** Rows of one container in order, with `insert` slotted back at its old index. */
function withGhosts<T extends { sort: number }>(
  rows: T[],
  ghosts: Array<{ row: T; index: number }>
): T[] {
  const out = [...rows].sort((a, b) => a.sort - b.sort)
  for (const g of [...ghosts].sort((a, b) => a.index - b.index))
    out.splice(Math.min(g.index, out.length), 0, g.row)
  return out.map((r, i) => ({ ...r, sort: i }))
}

export function canvasDiff(before: LayoutBundle, after: LayoutBundle): CanvasDiff {
  const marks = new Map<string, DiffMark>()
  const counts: Record<DiffKind, number> = { added: 0, moved: 0, removed: 0, changed: 0 }
  const mark = (t: DesignTarget, m: DiffMark) => {
    marks.set(targetKey(t), m)
    counts[m.kind]++
  }

  // ── Sections ──
  const beforeGroups = new Map(before.groups.map((g) => [g.key, g]))
  const afterGroups = new Map(after.groups.map((g) => [g.key, g]))
  for (const g of after.groups) {
    if (g.key === UNGROUPED_KEY) continue
    const was = beforeGroups.get(g.key)
    if (!was) {
      mark({ kind: 'group', key: g.key }, { kind: 'added' })
      continue
    }
    if ((was.parent_key ?? null) !== (g.parent_key ?? null)) {
      mark(
        { kind: 'group', key: g.key },
        {
          kind: 'moved',
          detail: `from ${was.parent_key ? sectionLabel(before.groups, was.parent_key) : 'the top level'}`
        }
      )
      continue
    }
    const keys = changedKeys(was, g, GROUP_PATCH_KEYS)
    if (keys.length)
      mark({ kind: 'group', key: g.key }, { kind: 'changed', detail: keys.join(', ') })
  }
  const ghostGroups: GroupRow[] = []
  for (const g of before.groups) {
    if (g.key === UNGROUPED_KEY || afterGroups.has(g.key)) continue
    ghostGroups.push(g)
    mark({ kind: 'group', key: g.key }, { kind: 'removed' })
  }

  // ── Fields, slots, header tiles ──
  const beforeAt = new Map(before.placements.map((p) => [pKey(p.field, p.group_key), p]))
  const afterAt = new Set(after.placements.map((p) => pKey(p.field, p.group_key)))
  const leftover = new Map<string, PlacementRow[]>() // field → its placements that left their spot
  for (const p of before.placements)
    if (!afterAt.has(pKey(p.field, p.group_key)))
      leftover.set(p.field, [...(leftover.get(p.field) ?? []), p])
  for (const p of after.placements) {
    const was = beforeAt.get(pKey(p.field, p.group_key))
    if (was) {
      const keys = changedKeys(was, p, PLACEMENT_PATCH_KEYS)
      if (keys.length) mark(placementTarget(p), { kind: 'changed', detail: keys.join(', ') })
      continue
    }
    const from = leftover.get(p.field)?.shift()
    if (from)
      mark(placementTarget(p), {
        kind: 'moved',
        detail: `from ${sectionLabel(before.groups, from.group_key)}`
      })
    else mark(placementTarget(p), { kind: 'added' })
  }
  const ghostPlacements = [...leftover.values()].flat()
  for (const p of ghostPlacements) mark(placementTarget(p), { kind: 'removed' })

  // ── The later state with the ghosts back in place ──
  let groups = after.groups
  if (ghostGroups.length) {
    const present = new Set(after.groups.map((g) => g.key))
    const pending = [...ghostGroups]
    const placed: GroupRow[] = []
    // Parents first: a removed tab group comes back before its removed tabs.
    for (let guard = 0; pending.length && guard < 50; guard++) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const g = pending[i]
        if (
          g.parent_key != null &&
          !present.has(g.parent_key) &&
          pending.some((x) => x.key === g.parent_key)
        )
          continue
        const parent = g.parent_key != null && present.has(g.parent_key) ? g.parent_key : null
        placed.push({ ...g, id: undefined, parent_key: parent })
        present.add(g.key)
        pending.splice(i, 1)
      }
    }
    const byParent = new Map<string, GroupRow[]>()
    for (const g of [...after.groups, ...placed]) {
      const k = g.parent_key ?? ''
      byParent.set(k, [...(byParent.get(k) ?? []), g])
    }
    const ghostKeys = new Set(placed.map((g) => g.key))
    groups = []
    for (const rows of byParent.values()) {
      const kept = rows.filter((g) => !ghostKeys.has(g.key))
      const ghosts = rows
        .filter((g) => ghostKeys.has(g.key))
        .map((g) => {
          const siblings = before.groups
            .filter((x) => (x.parent_key ?? null) === (beforeGroups.get(g.key)?.parent_key ?? null))
            .sort((a, b) => a.sort - b.sort)
          return {
            row: g,
            index: Math.max(
              0,
              siblings.findIndex((x) => x.key === g.key)
            )
          }
        })
      groups.push(...withGhosts(kept, ghosts))
    }
  }
  let placements = after.placements
  if (ghostPlacements.length) {
    const byGroup = new Map<string, PlacementRow[]>()
    for (const p of after.placements) {
      const k = p.group_key ?? ''
      byGroup.set(k, [...(byGroup.get(k) ?? []), p])
    }
    const ghostsByGroup = new Map<string, Array<{ row: PlacementRow; index: number }>>()
    for (const p of ghostPlacements) {
      const k = p.group_key ?? ''
      const index = before.placements
        .filter((x) => (x.group_key ?? '') === k)
        .sort((a, b) => a.sort - b.sort)
        .findIndex((x) => x.field === p.field)
      ghostsByGroup.set(k, [
        ...(ghostsByGroup.get(k) ?? []),
        { row: { ...p, id: undefined }, index: Math.max(0, index) }
      ])
    }
    placements = []
    for (const k of new Set([...byGroup.keys(), ...ghostsByGroup.keys()]))
      placements.push(...withGhosts(byGroup.get(k) ?? [], ghostsByGroup.get(k) ?? []))
  }

  const settings = Object.keys({ ...before.layout, ...after.layout }).filter(
    (k) => !LAYOUT_IGNORE.has(k) && !sameValue(before.layout[k], after.layout[k])
  )
  return {
    bundle: sortBundleRows({ ...after, groups, placements }),
    marks,
    counts,
    settings
  }
}

/** "3 added · 1 moved · 2 removed · 4 changed", or null when nothing differs. */
export function diffSummary(d: Pick<CanvasDiff, 'counts' | 'settings'>): string | null {
  const parts = (['added', 'moved', 'removed', 'changed'] as const)
    .filter((k) => d.counts[k] > 0)
    .map((k) => `${d.counts[k]} ${k}`)
  if (d.settings.length)
    parts.push(`${d.settings.length} form setting${d.settings.length === 1 ? '' : 's'}`)
  return parts.length ? parts.join(' · ') : null
}
