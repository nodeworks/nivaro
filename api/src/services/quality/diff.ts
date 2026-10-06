import type { QualityCheck, QualityRow, QualityValue } from '@nivaro/extension-kit'

/**
 * A known difference's condition. `key` is a glob where `*` stands for any
 * run of characters; a literal `*` in a key cannot be escaped, so a row that
 * must be named exactly (the "Mark as expected" row action) uses `key_exact`.
 */
export interface KnownMatch {
  key?: string
  key_exact?: string
  cluster?: Record<string, string>
  field?: string
}

export interface KnownDifference {
  id: number
  check_id: string
  match: KnownMatch
  reason: string
}

export type RowStatus = 'mismatch' | 'baseline_only' | 'current_only'

export interface DiffRow {
  key: string
  label?: string
  status: RowStatus
  fields: string[]
  base: Record<string, QualityValue> | null
  cur: Record<string, QualityValue> | null
  cluster?: Record<string, string>
  reason: string | null
  expected: boolean
  known_id: number | null
  /** Link to the same record in legacy production Directus, from the check's legacyLink. */
  legacy?: string
}

export interface DiffResult {
  compared: number
  matched: number
  amber: number
  red: number
  baseline_only: number
  current_only: number
  status: 'green' | 'amber' | 'red'
  rows: DiffRow[]
  clusters: Array<{ cluster: Record<string, string>; red: number; amber: number }>
  knownHits: Map<number, number>
}

type Tol = { abs?: number; pct?: number }

const isBlank = (v: QualityValue | undefined): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

function toNumber(v: QualityValue | undefined): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return null
    if (t.toLowerCase() === 'true') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function sameValue(a: QualityValue, b: QualityValue, tol?: Tol): boolean {
  const blankA = isBlank(a)
  const blankB = isBlank(b)
  if (blankA || blankB) return blankA && blankB
  // boolean counterparts: 'true'/'false' strings against booleans or 1/0
  const boolish = (v: QualityValue): number | null => {
    if (typeof v === 'boolean') return v ? 1 : 0
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase()
      if (t === 'true') return 1
      if (t === 'false') return 0
    }
    return null
  }
  const ba = boolish(a)
  const bb = boolish(b)
  if (ba !== null || bb !== null) {
    const na = ba ?? toNumber(a)
    const nb = bb ?? toNumber(b)
    if (na !== null && nb !== null) return na === nb
  }
  const na = toNumber(a)
  const nb = toNumber(b)
  if (na !== null && nb !== null) {
    const diff = Math.abs(na - nb)
    if (tol?.abs !== undefined && diff <= tol.abs) return true
    if (tol?.pct !== undefined && diff <= (Math.max(Math.abs(na), Math.abs(nb)) * tol.pct) / 100)
      return true
    return Math.round(na * 1e4) === Math.round(nb * 1e4)
  }
  return String(a).trim() === String(b).trim()
}

/**
 * Compiles a `*` glob into a linear matcher: runs of `*` collapse to one, the
 * text must start with the part before the first `*` and end with the part
 * after the last, and the parts between are found in order with indexOf. No
 * regular expression, so no backtracking however the pattern is written.
 */
export function compileGlob(pattern: string): (text: string) => boolean {
  const collapsed = pattern.replace(/\*+/g, '*')
  if (!collapsed.includes('*')) return (text) => text === collapsed
  const parts = collapsed.split('*')
  const head = parts[0]
  const tail = parts[parts.length - 1]
  const middle = parts.slice(1, -1).filter((p) => p !== '')
  return (text) => {
    if (text.length < head.length + tail.length) return false
    if (!text.startsWith(head) || !text.endsWith(tail)) return false
    const end = text.length - tail.length
    let pos = head.length
    for (const part of middle) {
      const at = text.indexOf(part, pos)
      if (at < 0 || at + part.length > end) return false
      pos = at + part.length
    }
    return true
  }
}

export function globMatch(pattern: string, text: string): boolean {
  return compileGlob(pattern)(text)
}

/** A key glob may use `*` this many times at most. */
export const MAX_KEY_WILDCARDS = 4
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * A known difference's match: at least one condition, every part bounded.
 * The one validator — the routes use it on input and loadKnown re-applies it
 * to every stored entry.
 */
export function parseKnownMatch(
  raw: unknown
): { ok: true; match: KnownMatch } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, error: 'match must be an object' }
  const m = raw as Record<string, unknown>
  const match: KnownMatch = {}
  if (m.key != null && m.key_exact != null)
    return { ok: false, error: 'match takes key or key_exact, not both' }
  if (m.key != null) {
    if (typeof m.key !== 'string' || m.key.length < 1 || m.key.length > 300)
      return { ok: false, error: 'match.key must be 1–300 characters' }
    if ((m.key.match(/\*/g)?.length ?? 0) > MAX_KEY_WILDCARDS)
      return {
        ok: false,
        error: `match.key may use * at most ${MAX_KEY_WILDCARDS} times`
      }
    match.key = m.key
  }
  if (m.key_exact != null) {
    if (typeof m.key_exact !== 'string' || m.key_exact.length < 1 || m.key_exact.length > 300)
      return { ok: false, error: 'match.key_exact must be 1–300 characters' }
    match.key_exact = m.key_exact
  }
  if (m.cluster != null) {
    if (typeof m.cluster !== 'object' || Array.isArray(m.cluster))
      return { ok: false, error: 'match.cluster must be an object' }
    const entries = Object.entries(m.cluster as Record<string, unknown>)
    if (entries.length < 1 || entries.length > 6)
      return { ok: false, error: 'match.cluster must have 1–6 entries' }
    const cluster = Object.create(null) as Record<string, string>
    for (const [k, v] of entries) {
      if (RESERVED_NAMES.has(k))
        return {
          ok: false,
          error: 'match.cluster may not use the name __proto__, constructor or prototype'
        }
      if (k.length < 1 || k.length > 200 || typeof v !== 'string' || v.length > 200)
        return {
          ok: false,
          error: 'match.cluster names and values must be text of 200 characters at most'
        }
      cluster[k] = v
    }
    match.cluster = cluster
  }
  if (m.field != null) {
    if (typeof m.field !== 'string' || m.field.length < 1 || m.field.length > 100)
      return { ok: false, error: 'match.field must be 1–100 characters' }
    match.field = m.field
  }
  if (
    match.key === undefined &&
    match.key_exact === undefined &&
    match.cluster === undefined &&
    match.field === undefined
  )
    return { ok: false, error: 'match needs at least one condition: key, cluster or field' }
  return { ok: true, match }
}

const show = (v: QualityValue | undefined): string => (isBlank(v) ? '—' : String(v))

function clusterMatches(
  want: Record<string, string>,
  ...have: Array<Record<string, string> | undefined>
): boolean {
  return have.some(
    (h) => h && Object.entries(want).every(([k, v]) => Object.hasOwn(h, k) && h[k] === v)
  )
}

export function diffRows(
  check: Pick<QualityCheck, 'tolerance' | 'expected' | 'explain'>,
  baseline: QualityRow[],
  current: QualityRow[],
  known: KnownDifference[]
): DiffResult {
  const bMap = new Map(baseline.map((r) => [r.key, r]))
  const cMap = new Map(current.map((r) => [r.key, r]))
  const keys = [...new Set([...bMap.keys(), ...cMap.keys()])].sort()

  // Each entry's key glob is compiled once, not once per row.
  const entries = known.map((k) => ({
    k,
    key: k.match.key !== undefined ? compileGlob(k.match.key) : null
  }))
  const rows: DiffRow[] = []
  const knownHits = new Map<number, number>()
  let matched = 0
  let baselineOnly = 0
  let currentOnly = 0
  let red = 0
  let amber = 0

  for (const key of keys) {
    const b = bMap.get(key) ?? null
    const c = cMap.get(key) ?? null
    let status: RowStatus
    let fields: string[] = []
    if (b && c) {
      const names = [...new Set([...Object.keys(b.values), ...Object.keys(c.values)])]
      fields = names.filter(
        (n) => !sameValue(b.values[n] ?? null, c.values[n] ?? null, check.tolerance)
      )
      if (fields.length === 0) {
        matched++
        continue
      }
      status = 'mismatch'
    } else if (b) {
      status = 'baseline_only'
      baselineOnly++
    } else {
      status = 'current_only'
      currentOnly++
    }

    const cluster = b?.cluster ?? c?.cluster
    let reason: string | null = check.expected?.(b, c, fields) ?? null
    let expected = reason !== null
    let knownId: number | null = null
    if (!expected) {
      const hit = entries.find(({ k, key: keyMatches }) => {
        const m = k.match
        if (keyMatches && !keyMatches(key)) return false
        if (m.key_exact !== undefined && m.key_exact !== key) return false
        if (m.cluster && !clusterMatches(m.cluster, b?.cluster, c?.cluster)) return false
        if (m.field !== undefined && !fields.includes(m.field)) return false
        return true
      })?.k
      if (hit) {
        expected = true
        reason = hit.reason
        knownId = hit.id
        knownHits.set(hit.id, (knownHits.get(hit.id) ?? 0) + 1)
      }
    }
    if (!expected) {
      reason =
        check.explain?.(b, c, fields) ??
        (status === 'baseline_only'
          ? 'Only in production'
          : status === 'current_only'
            ? 'Only in staging'
            : fields
                .slice(0, 3)
                .map(
                  (f) => `${f}: production ${show(b?.values[f])} · staging ${show(c?.values[f])}`
                )
                .join('; '))
    }
    if (expected) amber++
    else red++
    rows.push({
      key,
      ...((b?.label ?? c?.label) ? { label: b?.label ?? c?.label } : {}),
      status,
      fields,
      base: b ? b.values : null,
      cur: c ? c.values : null,
      ...(cluster ? { cluster } : {}),
      reason,
      expected,
      known_id: knownId
    })
  }

  rows.sort((x, y) => Number(x.expected) - Number(y.expected))

  const byCluster = new Map<
    string,
    { cluster: Record<string, string>; red: number; amber: number }
  >()
  for (const r of rows) {
    if (!r.cluster) continue
    const id = JSON.stringify(r.cluster)
    const e = byCluster.get(id) ?? { cluster: r.cluster, red: 0, amber: 0 }
    if (r.expected) e.amber++
    else e.red++
    byCluster.set(id, e)
  }
  const clusters = [...byCluster.values()].sort((x, y) => y.red - x.red).slice(0, 50)

  return {
    compared: keys.length,
    matched,
    amber,
    red,
    baseline_only: baselineOnly,
    current_only: currentOnly,
    status: red > 0 ? 'red' : amber > 0 ? 'amber' : 'green',
    rows,
    clusters,
    knownHits
  }
}
