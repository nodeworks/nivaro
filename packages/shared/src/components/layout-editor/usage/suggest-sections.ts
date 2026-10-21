import {
  HEADER_GROUP_KEY,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  TABLE_FORM_GROUP_KEYS
} from '../../../lib/layout-ops'
import type { CoChangePair } from './usage-api'

/**
 * Suggested sections (#2605): fields people change in the same save but that
 * sit in different sections of this form. Pairs (Jaccard over revisions) are
 * joined into small clusters, strongest first; a cluster spread over two or
 * more sections becomes one suggestion: move the strays into the section that
 * already holds most of them, right after the last of them. Applying it is one
 * op batch (one undo step). Computed against the current draft, so undo and
 * unsaved moves are reflected at once.
 */

export interface SectionSuggestion {
  id: string
  fields: string[]
  /** Where each field sits now (null = Ungrouped). */
  from: Record<string, string | null>
  target: string | null
  ops: LayoutOp[]
  /** Average Jaccard of the pairs inside the cluster (0-1). */
  score: number
}

const MAX_CLUSTER = 6
const MAX_SUGGESTIONS = 5

export function suggestSections(
  bundle: LayoutBundle,
  pairs: CoChangePair[],
  opts: { minJaccard?: number } = {}
): SectionSuggestion[] {
  const minJaccard = opts.minJaccard ?? 0.5
  // Body fields placed exactly once: a field shown twice has no single home.
  const homes = new Map<string, string | null>()
  const twice = new Set<string>()
  for (const p of bundle.placements) {
    if (p.field.startsWith('__') || isCanvasSlot(p)) continue
    if (p.group_key === HEADER_GROUP_KEY) continue
    if (p.group_key && TABLE_FORM_GROUP_KEYS.includes(p.group_key)) continue
    if (homes.has(p.field)) twice.add(p.field)
    homes.set(p.field, p.group_key)
  }
  for (const f of twice) homes.delete(f)

  const usable = pairs
    .filter((p) => p.jaccard >= minJaccard && homes.has(p.a) && homes.has(p.b))
    .sort((x, y) => y.jaccard - x.jaccard || y.together - x.together)

  // Greedy clustering: strongest pairs first, clusters capped in size.
  const clusterOf = new Map<string, string[]>()
  for (const p of usable) {
    const ca = clusterOf.get(p.a)
    const cb = clusterOf.get(p.b)
    if (ca && cb) {
      if (ca === cb || ca.length + cb.length > MAX_CLUSTER) continue
      ca.push(...cb)
      for (const f of cb) clusterOf.set(f, ca)
    } else if (ca || cb) {
      const c = (ca ?? cb) as string[]
      const add = ca ? p.b : p.a
      if (c.length >= MAX_CLUSTER) continue
      c.push(add)
      clusterOf.set(add, c)
    } else {
      const c = [p.a, p.b]
      clusterOf.set(p.a, c)
      clusterOf.set(p.b, c)
    }
  }

  const clusters = [...new Set(clusterOf.values())]
  const out: SectionSuggestion[] = []
  for (const fields of clusters) {
    const byGroup = new Map<string | null, string[]>()
    for (const f of fields) {
      const g = homes.get(f) ?? null
      byGroup.set(g, [...(byGroup.get(g) ?? []), f])
    }
    if (byGroup.size < 2) continue
    // The section already holding most of them (first seen wins a tie: the strongest pair's).
    let target: string | null = null
    let most = -1
    for (const [g, fs] of byGroup) {
      if (fs.length > most) {
        most = fs.length
        target = g
      }
    }
    const inTarget = bundle.placements
      .filter((p) => p.group_key === target && !isCanvasSlot(p))
      .sort((a, b) => a.sort - b.sort)
    const anchor = Math.max(...inTarget.map((p, i) => (fields.includes(p.field) ? i : -1)))
    const strays = fields.filter((f) => (homes.get(f) ?? null) !== target)
    const ops: LayoutOp[] = strays.map((field, i) => ({
      op: 'move',
      from: { field, group_key: homes.get(field) ?? null },
      to_group_key: target,
      // Ungrouped mixes fields with section positions: append there.
      index: target == null ? 1_000_000 : anchor + 1 + i
    }))
    const inside = usable.filter((p) => fields.includes(p.a) && fields.includes(p.b))
    const score = inside.length ? inside.reduce((s, p) => s + p.jaccard, 0) / inside.length : 0
    out.push({
      id: [...fields].sort().join('+'),
      fields,
      from: Object.fromEntries(fields.map((f) => [f, homes.get(f) ?? null])),
      target,
      ops,
      score: Math.round(score * 100) / 100
    })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_SUGGESTIONS)
}
