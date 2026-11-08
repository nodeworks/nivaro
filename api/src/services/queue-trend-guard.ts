import { createHash } from 'node:crypto'
import type { QueueSourceRow } from './queues.js'

/** Leaf module (no service graph): a tolerant JSON read — undefined when not JSON. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

// Army 11 Q1-1 / Q2-7: a worklist's trend arrows (live figure − last daily snapshot),
// sparklines, burn-down and the cheap /queues/badges counts all read the daily stat
// snapshots. Two ways they stopped comparing like with like:
//
//  1. The queue's DEFINITION changed between the snapshot and now (Inventory Requests
//     stopped listing Order Submission: "214 Total ↓694" — 694 = exactly the rows the
//     source no longer admits). A snapshot taken under another definition is not a
//     point on the same line.
//  2. The snapshot is resolved as the queue OWNER; a viewer whose User Scope narrows
//     the queue differently saw the gap as movement ("↓4" = the National slice they may
//     not see) — and could read out-of-scope counts off it.
//
// Pure helpers here; routes/queues.ts applies them to /:id/trends and /badges.

/** Key the snapshot writer stores inside `by_state` (JSON) — never a real state key. */
export const SNAPSHOT_DEF_KEY = '__def'

type DefSource = Pick<
  QueueSourceRow,
  'type' | 'collection' | 'filters' | 'state_values' | 'state_mode' | 'sla_filter'
>

/** Stable fingerprint of what a queue's sources admit (order-independent). */
export function queueDefinitionHash(sources: DefSource[]): string {
  const canon = sources
    .map((s) =>
      JSON.stringify([
        s.type ?? null,
        s.collection ?? null,
        canonJson(s.filters),
        canonStates(s.state_values),
        s.state_mode === 'exclude' ? 'exclude' : 'include',
        canonJson(s.sla_filter)
      ])
    )
    .sort()
  return createHash('sha1').update(canon.join('\n')).digest('hex').slice(0, 16)
}

function canonJson(raw: string | null | undefined): unknown {
  if (raw == null || raw === '') return null
  const v = parseJson(raw)
  return v === undefined ? raw : sortKeys(v)
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort())
      out[k] = sortKeys((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

function stateList(raw: string | null | undefined): string[] {
  if (raw == null || raw === '') return []
  const v = parseJson(raw)
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean)
  return String(raw)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

function canonStates(raw: string | null | undefined): string[] {
  return [...new Set(stateList(raw))].sort()
}

/**
 * Would today's sources admit a row in `state`? A source with no state list admits
 * every state; 'include' admits its listed states; 'exclude' admits all but those.
 * Non-collection sources (owned_by_me …) admit anything.
 */
export function stateAdmitted(sources: DefSource[], state: string): boolean {
  if (sources.length === 0) return true
  return sources.some((s) => {
    const list = stateList(s.state_values)
    if (list.length === 0) return true
    const listed = list.includes(state)
    return s.state_mode === 'exclude' ? !listed : listed
  })
}

/**
 * Was this snapshot taken under the queue's current definition? A snapshot carrying a
 * fingerprint must match it; an older one (no fingerprint) passes only when every state
 * it counted is still admitted — a state the queue no longer lists means the line broke.
 */
export function snapshotMatchesDefinition(
  byState: Record<string, unknown> | null | undefined,
  sources: DefSource[],
  currentHash: string
): boolean {
  const stored = byState?.[SNAPSHOT_DEF_KEY]
  if (typeof stored === 'string' && stored) return stored === currentHash
  for (const [state, n] of Object.entries(byState ?? {})) {
    if (state === SNAPSHOT_DEF_KEY) continue
    if (Number(n) > 0 && state !== 'none' && !stateAdmitted(sources, state)) return false
  }
  return true
}

/** `by_state` as a client should see it — without the fingerprint key. */
export function publicByState(
  byState: Record<string, unknown> | null | undefined
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(byState ?? {})) {
    if (k === SNAPSHOT_DEF_KEY) continue
    out[k] = Number(v) || 0
  }
  return out
}

type Restriction = { dimension: string; values: Array<string | number> }

/** Canonical form of a person's restrict-mode scopes, so two people compare by value. */
export function accessSignature(restrictions: Restriction[]): string {
  const merged = new Map<string, Set<string>>()
  for (const r of restrictions) {
    const set = merged.get(r.dimension) ?? new Set<string>()
    for (const v of r.values) set.add(String(v).toLowerCase())
    merged.set(r.dimension, set)
  }
  return JSON.stringify(
    [...merged.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, vals]) => [d, [...vals].sort()])
  )
}
