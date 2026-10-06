import type { QualityCheck, QualityRow, QualityValue } from '@nivaro/extension-kit'

export interface KnownDifference {
  id: number
  check_id: string
  match: { key?: string; cluster?: Record<string, string>; field?: string }
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

export function globMatch(pattern: string, text: string): boolean {
  const re = pattern
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${re}$`).test(text)
}

const show = (v: QualityValue | undefined): string => (isBlank(v) ? '—' : String(v))

function clusterMatches(
  want: Record<string, string>,
  ...have: Array<Record<string, string> | undefined>
): boolean {
  return have.some((h) => h && Object.entries(want).every(([k, v]) => h[k] === v))
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
      const hit = known.find((k) => {
        const m = k.match
        if (m.key !== undefined && !globMatch(m.key, key)) return false
        if (m.cluster && !clusterMatches(m.cluster, b?.cluster, c?.cluster)) return false
        if (m.field !== undefined && !fields.includes(m.field)) return false
        return true
      })
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
