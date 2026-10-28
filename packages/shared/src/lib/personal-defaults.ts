import type { CascadeRule } from '../components/item-edit/helpers'

// Personal field defaults: pure decision helpers (no React, no fetch).
// A saved default remembers the value plus the cascade-parent values that were
// set when it was saved (`context`). On a new record the form picks the saved
// default whose context fits the draft.

export type SavedDefault = {
  id: number
  field: string
  value: unknown
  context: Record<string, unknown>
  updated_at: string
}

type RulesFor = (field: string) => CascadeRule[]

export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
}

/** Draft values may hold a loaded `{id}` object instead of the bare id. */
function unwrap(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unwrap)
  if (v && typeof v === 'object' && 'id' in (v as object)) return (v as { id: unknown }).id
  return v
}

function normalize(v: unknown): unknown {
  const u = unwrap(v)
  return Array.isArray(u) ? u.map((x) => String(unwrap(x))).sort() : String(u)
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}

/** Transitive non-upstream cascade parents, nearest first, cycle-safe. */
export function cascadeParents(field: string, rulesFor: RulesFor): string[] {
  const seen = new Set<string>([field])
  const out: string[] = []
  let level = [field]
  while (level.length) {
    const next: string[] = []
    for (const f of level) {
      for (const r of rulesFor(f)) {
        if (r.upstream || seen.has(r.parent_field)) continue
        seen.add(r.parent_field)
        out.push(r.parent_field)
        next.push(r.parent_field)
      }
    }
    level = next
  }
  return out
}

/** The parent values set right now; empty parents are left out (no constraint). */
export function captureContext(
  field: string,
  draft: Record<string, unknown>,
  rulesFor: RulesFor
): Record<string, unknown> {
  const ctx: Record<string, unknown> = {}
  for (const p of cascadeParents(field, rulesFor)) {
    if (!isEmptyValue(draft[p])) ctx[p] = unwrap(draft[p])
  }
  return ctx
}

/** Parents before children; unrelated fields keep input order. */
export function orderTopDown(fields: string[], rulesFor: RulesFor): string[] {
  const inSet = new Set(fields)
  const deps = new Map(
    fields.map((f) => [f, cascadeParents(f, rulesFor).filter((p) => inSet.has(p) && p !== f)])
  )
  const placed = new Set<string>()
  const out: string[] = []
  let left = [...fields]
  while (left.length) {
    const ready = left.find((f) => deps.get(f)?.every((p) => placed.has(p)))
    // A cycle leaves nothing ready: fall back to input order for the rest.
    const f = ready ?? left[0]
    placed.add(f)
    out.push(f)
    left = left.filter((x) => x !== f)
  }
  return out
}

export function pickDefault(
  candidates: SavedDefault[],
  draft: Record<string, unknown>
): { pick: SavedDefault | null; fillParents: Record<string, unknown>; blockedBy: string | null } {
  let best: {
    c: SavedDefault
    score: number
    size: number
    fill: Record<string, unknown>
  } | null = null
  let blockedBy: string | null = null
  const newestFirst = [...candidates].sort((a, b) =>
    a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0
  )
  for (const c of newestFirst) {
    let score = 0
    let bad: string | null = null
    const fill: Record<string, unknown> = {}
    for (const [key, want] of Object.entries(c.context ?? {})) {
      if (isEmptyValue(draft[key])) fill[key] = want
      else if (sameValue(want, draft[key])) score++
      else {
        bad = key
        break
      }
    }
    if (bad) {
      if (!blockedBy) blockedBy = bad
      continue
    }
    // Most matching keys, then more context keys; newest-first iteration with
    // strict > keeps the newest on a full tie.
    const size = Object.keys(c.context ?? {}).length
    if (!best || score > best.score || (score === best.score && size > best.size))
      best = { c, score, size, fill }
  }
  if (!best) return { pick: null, fillParents: {}, blockedBy }
  return { pick: best.c, fillParents: best.fill, blockedBy: null }
}
