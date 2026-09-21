import { createHash } from 'node:crypto'

/**
 * Small helpers for the checks scripts and probes run against their own work.
 *
 * Two failure modes keep recurring, and both produce a GREEN result that proves
 * nothing:
 *
 *  1. A before/after comparison that read zero rows. "No differences" is true
 *     of two empty sets, so a wrong response path (`items` where the payload
 *     said `data`) reports SAME for every case it was asked about.
 *  2. A destructive script that reports the rows it deleted and never checks
 *     the effect it existed to produce. Row counts describe the statement, not
 *     the outcome.
 *
 * Everything here refuses to pass on that kind of evidence.
 */

/** A comparison that could not have detected a difference. */
export class VacuousComparisonError extends Error {
  constructor(label: string, detail: string) {
    super(`${label}: the comparison is vacuous — ${detail}`)
    this.name = 'VacuousComparisonError'
  }
}

/** A script finished, and the thing it was for did not happen. */
export class PostConditionError extends Error {
  constructor(label: string, detail: string) {
    super(`${label}: post-condition failed — ${detail}`)
    this.name = 'PostConditionError'
  }
}

/** JSON with object keys sorted at every depth, so equal values hash equal. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === undefined) return null
    if (v === null || typeof v !== 'object') return v
    if (v instanceof Date) return v.toISOString()
    if (v instanceof Set) return [...v].map(walk).sort(compareJson)
    if (v instanceof Map) return walk(Object.fromEntries(v))
    if (Array.isArray(v)) return v.map(walk)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = walk((v as Record<string, unknown>)[key])
    }
    return out
  }
  return JSON.stringify(walk(value))
}

function compareJson(a: unknown, b: unknown): number {
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Short stable hash of any JSON-able value. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16)
}

export interface KeyedDiff<T> {
  same: boolean
  /** Rows compared — the number that makes "same" mean something. */
  compared: number
  added: string[]
  removed: string[]
  changed: Array<{ key: string; fields: string[]; before: T; after: T }>
}

export interface CompareOptions<T> {
  /** Names the comparison in any error. */
  label: string
  key: (row: T) => string | number
  /** Fewest rows EACH side must hold for the result to count. Default 1. */
  minRows?: number
  /** Fields that legitimately differ between runs (timestamps, timings). */
  ignore?: string[]
}

/**
 * Compare two row sets by key, order-insensitively.
 *
 * Throws {@link VacuousComparisonError} when either side is smaller than
 * `minRows`, or when the keys collapse (every row keyed `undefined` is one
 * row, and one row always matches itself).
 */
export function compareKeyed<T extends Record<string, unknown>>(
  before: readonly T[],
  after: readonly T[],
  opts: CompareOptions<T>
): KeyedDiff<T> {
  const minRows = opts.minRows ?? 1
  for (const [side, rows] of [
    ['before', before],
    ['after', after]
  ] as const) {
    if (!Array.isArray(rows)) {
      throw new VacuousComparisonError(opts.label, `"${side}" is not an array`)
    }
    if (rows.length < minRows) {
      throw new VacuousComparisonError(
        opts.label,
        `"${side}" holds ${rows.length} row(s), fewer than the ${minRows} required. ` +
          'Check the response path before trusting an empty result.'
      )
    }
  }

  const index = (rows: readonly T[], side: string): Map<string, T> => {
    const map = new Map<string, T>()
    for (const row of rows) {
      const raw = opts.key(row)
      if (raw === undefined || raw === null || raw === '') {
        throw new VacuousComparisonError(
          opts.label,
          `a "${side}" row has no key — the key function does not match the row shape`
        )
      }
      map.set(String(raw), row)
    }
    if (map.size < rows.length) {
      throw new VacuousComparisonError(
        opts.label,
        `"${side}" has ${rows.length} rows but only ${map.size} distinct keys`
      )
    }
    return map
  }

  const a = index(before, 'before')
  const b = index(after, 'after')
  const ignore = new Set(opts.ignore ?? [])

  const added = [...b.keys()].filter((k) => !a.has(k))
  const removed = [...a.keys()].filter((k) => !b.has(k))
  const changed: KeyedDiff<T>['changed'] = []
  for (const [key, rowA] of a) {
    const rowB = b.get(key)
    if (!rowB) continue
    const fields = [...new Set([...Object.keys(rowA), ...Object.keys(rowB)])].filter(
      (f) => !ignore.has(f) && canonicalJson(rowA[f]) !== canonicalJson(rowB[f])
    )
    if (fields.length > 0) changed.push({ key, fields, before: rowA, after: rowB })
  }

  return {
    same: added.length === 0 && removed.length === 0 && changed.length === 0,
    compared: a.size,
    added,
    removed,
    changed
  }
}

export interface PostCondition {
  /** What should now be true, in words — printed on success and on failure. */
  claim: string
  expected: number | string | boolean
  actual: number | string | boolean
}

/**
 * Assert the effects a destructive script was run for.
 *
 * Pass every condition, not the first — a script that fixed two of three
 * things should say which one it missed. Numbers compare to the cent, so a
 * money total recomputed through floats does not fail on dust.
 */
export function assertPostConditions(label: string, conditions: PostCondition[]): void {
  if (conditions.length === 0) {
    throw new PostConditionError(label, 'no conditions were given, so nothing was verified')
  }
  const failed = conditions.filter((c) => !sameValue(c.expected, c.actual))
  if (failed.length > 0) {
    throw new PostConditionError(
      label,
      failed.map((c) => `${c.claim} (expected ${c.expected}, got ${c.actual})`).join('; ')
    )
  }
}

function sameValue(expected: PostCondition['expected'], actual: PostCondition['actual']): boolean {
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (!Number.isFinite(expected) || !Number.isFinite(actual)) return false
    return Math.abs(expected - actual) < 0.005
  }
  return expected === actual
}
