/**
 * Inputs a re-run CHANGES on purpose, beside what the row rules derive.
 *
 * The grid's "Re-run rules → Re-derive everything" also re-points a picker
 * value that is no longer offered under the parent (a line's Category after
 * the record's Project or Project Type changed) to the parent's default — the
 * same cascade swap the form runs when someone changes the parent live. The
 * client resolves that swap and sends it as `forced_patches` ({row id:
 * patch}); the route overlays it on each row BEFORE planning, so every rule
 * derives from the new value, then merges it into the plan's changes so it is
 * previewed, staged and written with them. A row the rules leave alone still
 * gets a change for the forced value alone.
 */
import type { RowRuleChange, RowRulePlan } from './row-rules-apply.js'

export type ForcedPatches = Record<string, Record<string, unknown>>

const FIELD_RE = /^[A-Za-z0-9_]+$/

/** Keep only well-formed entries for rows in this run: plain field names,
 *  scalar values, at most `maxFields` per row. Anything else is dropped. */
export function sanitizeForcedPatches(
  raw: unknown,
  rowIds: Set<string>,
  maxFields = 10
): ForcedPatches {
  const out: ForcedPatches = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, patch] of Object.entries(raw as Record<string, unknown>)) {
    if (!rowIds.has(id) || !patch || typeof patch !== 'object' || Array.isArray(patch)) continue
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (Object.keys(clean).length >= maxFields) break
      if (!FIELD_RE.test(k) || k === 'id') continue
      if (v !== null && typeof v !== 'string' && typeof v !== 'number') continue
      clean[k] = v
    }
    if (Object.keys(clean).length) out[id] = clean
  }
  return out
}

/** Overlay forced values on the rows the planner will judge. */
export function overlayForced(
  rows: Array<Record<string, unknown>>,
  forced: ForcedPatches
): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const f = forced[String(r.id)]
    return f ? { ...r, ...f } : r
  })
}

/** Merge forced values into the plan (in place): each forced field joins its
 *  row's patch (the rules' own answer for the same field wins), `before`
 *  carries the value the row had, and `fields` counts it once per row. */
export function mergeForcedIntoPlan(
  plan: RowRulePlan,
  forced: ForcedPatches,
  original: Map<string, Record<string, unknown>>
): RowRulePlan {
  const byId = new Map(plan.changes.map((c) => [c.id, c]))
  for (const [id, patch] of Object.entries(forced)) {
    const was = original.get(id)
    if (!was) continue
    const real = Object.entries(patch).filter(([k, v]) => String(was[k] ?? '') !== String(v ?? ''))
    if (!real.length) continue
    let change = byId.get(id)
    if (!change) {
      change = { id, patch: {}, before: {}, locked: [] } satisfies RowRuleChange
      plan.changes.push(change)
      byId.set(id, change)
    }
    for (const [k, v] of real) {
      if (!(k in change.patch)) {
        change.patch[k] = v
        plan.fields[k] = (plan.fields[k] ?? 0) + 1
      }
      change.before[k] = was[k] ?? null
    }
  }
  return plan
}
