// api/src/services/traffic-payload-drift.ts
/**
 * Partner payload shape drift (#2200). The usual shape of what a partner sends and receives —
 * field PATHS and JSON TYPES only, never values — learned from the bodies the outbound recorder
 * still holds, and compared with the newest calls: fields that appeared, fields that stopped
 * arriving, fields whose type changed. Pure; the route feeds it bodies from `nivaro_outbound_log`.
 */

export type PathTypes = Map<string, Set<string>>

const MAX_DEPTH = 6
const MAX_PATHS = 300
const MAX_ARRAY_ELEMENTS = 20
const KEY_CAP = 60
/** Bodies an endpoint needs before a baseline is trusted. */
export const MIN_BODIES = 20
const RECENT_MIN = 5
const RECENT_MAX = 30
/** A path in at least this share of baseline bodies is "expected". */
const EXPECTED_SHARE = 0.8
const LIST_CAP = 15

/** Keys that are really data (ids, long numbers) fold to `*` so a map keyed by id stays one path. */
function safeKey(k: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return '*'
  if (/^\d{4,}$/.test(k)) return '*'
  return k.length > KEY_CAP ? `${k.slice(0, KEY_CAP)}…` : k
}

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v === 'object' ? 'object' : typeof v
}

/** Every path in a JSON value with the types seen there (arrays merge as `path[]`). */
export function shapeOf(value: unknown): PathTypes {
  const out: PathTypes = new Map()
  const add = (path: string, type: string) => {
    if (!path) return
    let s = out.get(path)
    if (!s) {
      if (out.size >= MAX_PATHS) return
      s = new Set()
      out.set(path, s)
    }
    s.add(type)
  }
  const walk = (v: unknown, path: string, depth: number) => {
    add(path, typeOf(v))
    if (depth >= MAX_DEPTH) return
    if (Array.isArray(v)) {
      for (const el of v.slice(0, MAX_ARRAY_ELEMENTS)) walk(el, `${path}[]`, depth + 1)
    } else if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v as Record<string, unknown>))
        walk(child, path ? `${path}.${safeKey(k)}` : safeKey(k), depth + 1)
    }
  }
  walk(value, '', 0)
  return out
}

/** The shape of a stored body text; null when it is not JSON (truncated or not JSON at all). */
export function shapeOfBody(text: string | null | undefined): PathTypes | null {
  if (!text) return null
  try {
    return shapeOf(JSON.parse(text))
  } catch {
    return null
  }
}

export interface DriftFinding {
  path: string
  /** Bodies of the recent window that carry the path. */
  recent: number
  /** Share of baseline bodies that carry it, in percent. */
  baseline_pct: number
  from?: string
  to?: string
}

export interface DriftReport {
  status: 'learning' | 'steady' | 'drifting'
  bodies: number
  needed: number
  recent_bodies: number
  new_fields: DriftFinding[]
  missing_fields: DriftFinding[]
  type_changes: DriftFinding[]
}

function dominant(types: Map<string, number>): string {
  let best = ''
  let n = -1
  for (const [t, c] of types) {
    if (t === 'null') continue
    if (c > n) {
      n = c
      best = t
    }
  }
  return best
}

/**
 * `bodies` are oldest first. The newest ~20% (5–30 bodies) are compared with the rest. A field
 * is NEW when ≥2 recent bodies carry it and no baseline body did; MISSING when ≥80% of the
 * baseline carried it and no recent body does; a type CHANGE when a recent type never appeared in
 * the baseline there (`null` fits any type).
 */
export function driftReport(bodies: readonly PathTypes[]): DriftReport {
  const n = bodies.length
  const empty = { new_fields: [], missing_fields: [], type_changes: [] }
  if (n < MIN_BODIES)
    return { status: 'learning', bodies: n, needed: MIN_BODIES, recent_bodies: 0, ...empty }
  const recentN = Math.min(RECENT_MAX, Math.max(RECENT_MIN, Math.round(n * 0.2)))
  const baseline = bodies.slice(0, n - recentN)
  const recent = bodies.slice(n - recentN)

  const count = (list: readonly PathTypes[]) => {
    const presence = new Map<string, number>()
    const types = new Map<string, Map<string, number>>()
    for (const b of list) {
      for (const [path, ts] of b) {
        presence.set(path, (presence.get(path) ?? 0) + 1)
        let m = types.get(path)
        if (!m) {
          m = new Map()
          types.set(path, m)
        }
        for (const t of ts) m.set(t, (m.get(t) ?? 0) + 1)
      }
    }
    return { presence, types }
  }
  const base = count(baseline)
  const rec = count(recent)
  const pct = (path: string) => Math.round(((base.presence.get(path) ?? 0) / baseline.length) * 100)

  const newFields: DriftFinding[] = []
  const typeChanges: DriftFinding[] = []
  for (const [path, seen] of rec.presence) {
    const inBase = base.presence.get(path) ?? 0
    if (inBase === 0) {
      if (seen >= 2) newFields.push({ path, recent: seen, baseline_pct: 0 })
      continue
    }
    const baseTypes = base.types.get(path) ?? new Map<string, number>()
    for (const [t, c] of rec.types.get(path) ?? []) {
      if (t === 'null' || c < 2 || baseTypes.has(t)) continue
      typeChanges.push({
        path,
        recent: c,
        baseline_pct: pct(path),
        from: dominant(baseTypes) || 'null',
        to: t
      })
      break
    }
  }
  const missing: DriftFinding[] = []
  for (const [path, inBase] of base.presence) {
    if (inBase / baseline.length >= EXPECTED_SHARE && !rec.presence.has(path))
      missing.push({ path, recent: 0, baseline_pct: pct(path) })
  }
  const byPath = (a: DriftFinding, b: DriftFinding) => a.path.localeCompare(b.path)
  const report: DriftReport = {
    status: 'steady',
    bodies: n,
    needed: MIN_BODIES,
    recent_bodies: recentN,
    new_fields: newFields.sort(byPath).slice(0, LIST_CAP),
    missing_fields: missing.sort(byPath).slice(0, LIST_CAP),
    type_changes: typeChanges.sort(byPath).slice(0, LIST_CAP)
  }
  if (newFields.length || missing.length || typeChanges.length) report.status = 'drifting'
  return report
}
