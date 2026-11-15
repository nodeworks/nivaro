import { useEffect, useRef } from 'react'
import { lastLiveSeen } from './live-seen'

/**
 * Missed-update detector (realtime idea 14).
 *
 * A reload is a person saying "I don't trust what this page shows". This finds out whether they
 * were right, without ever sending a value anywhere:
 *
 * 1. Before the page goes (pagehide) each live screen's shown records are stored in
 *    sessionStorage as a small snapshot: per record (cap 200) its collection, id, when the screen
 *    loaded it, when this tab last heard a live event naming it, and ONE HASH PER FIELD (cap 40
 *    fields) — hashes only, never values.
 * 2. After a reload (PerformanceNavigationTiming type `reload`, same path, snapshot under two
 *    minutes old) the same screens register their fresh data; each field's new hash is compared.
 * 3. A field whose hash changed counts as a MISSED UPDATE only when this tab heard no live event
 *    for the record after it loaded it (an event it heard but did not show is a screen problem,
 *    not a delivery one), and the record was loaded more than ~5 s before the reload (a change
 *    that may still have been on its way is ignored).
 * 4. One beacon per reload: collection, record id, field NAMES, the page route and how long the
 *    old value sat on screen (`gap_s`). Reloads that compared records and found nothing different
 *    are counted too ("trust reloads"). The server classifies each miss (routes/realtime-trust).
 *
 * Screens take part with `useShownRecords(records)`; the detector starts with `startRum`.
 */

export interface ShownRecord {
  collection: string
  id: string | number
  /** The values as shown (only hashed, on this device). */
  values: Record<string, unknown>
  /** When the screen's data for this record arrived (react-query `dataUpdatedAt`). */
  loadedAt: number
  /** Limit the hashed fields to these (default: every key but `id`). */
  fields?: string[]
}

export interface SnapRecord {
  c: string
  id: string
  /** Loaded at (ms). */
  l: number
  /** Last live event heard for it (ms), null = none. */
  s: number | null
  /** field → hash. */
  h: Record<string, string>
}

export interface Snapshot {
  v: 1
  path: string
  /** When the page went (ms). */
  at: number
  records: SnapRecord[]
}

export interface MissedRecord {
  collection: string
  id: string
  fields: string[]
  /** How long the stale value sat on screen before the reload (s). */
  gap_s: number
}

export interface CompareResult {
  compared: number
  missed: MissedRecord[]
}

export const SNAPSHOT_KEY = 'nvr-missed-snapshot'
export const MAX_SNAPSHOT_RECORDS = 200
export const MAX_SNAPSHOT_FIELDS = 40
/** A snapshot older than this is not compared (the reload never happened right after it). */
export const SNAPSHOT_MAX_AGE_MS = 2 * 60_000
/** Data loaded closer than this to the reload may have had a change still on its way. */
export const IN_FLIGHT_MS = 5000
/** How long after a reload screens get to show fresh data before the comparison is sent. */
export const COMPARE_FOR_MS = 15_000
/** Beacons per tab per hour (the server caps again per person). */
export const BEACONS_PER_HOUR = 12
export const MAX_MISSED_PER_BEACON = 20

// ─── Pure parts (tested) ────────────────────────────────────────────────────

/** 32-bit FNV-1a, hex. Not a security hash — a short "did this change" fingerprint. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

function normalize(v: unknown, depth = 0): unknown {
  if (v === undefined || v === null) return null
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return depth > 2 ? `[${v.length}]` : v.map((x) => normalize(x, depth + 1))
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    // A linked record shown by its id: the link is what matters, not the label read with it.
    if ('id' in o && (typeof o.id === 'string' || typeof o.id === 'number')) return `#${o.id}`
    if (depth > 2) return '{…}'
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o).sort()) out[k] = normalize(o[k], depth + 1)
    return out
  }
  return String(v)
}

/** The hash of one shown value (null, '' and undefined hash alike: all show as empty). */
export function hashValue(v: unknown): string {
  if (v === '' || v === undefined || v === null) return fnv1a('∅')
  return fnv1a(JSON.stringify(normalize(v)).slice(0, 8000))
}

function fieldsOf(r: ShownRecord): string[] {
  const keys = r.fields ?? Object.keys(r.values ?? {})
  return keys.filter((k) => k !== 'id' && !k.startsWith('$')).slice(0, MAX_SNAPSHOT_FIELDS)
}

/** The snapshot for a set of shown records (newest load wins for a record shown twice). */
export function buildSnapshot(
  path: string,
  records: ShownRecord[],
  now: number,
  heard: (collection: string, id: string) => number | null = (c, id) => lastLiveSeen(c, id)
): Snapshot {
  const byKey = new Map<string, SnapRecord>()
  for (const r of records) {
    if (!r?.collection || r.id == null || !r.values) continue
    const id = String(r.id)
    const key = `${r.collection}\u0000${id}`
    const h: Record<string, string> = byKey.get(key)?.h ?? {}
    for (const f of fieldsOf(r)) h[f] = hashValue(r.values[f])
    const prev = byKey.get(key)
    byKey.set(key, {
      c: r.collection,
      id,
      l: Math.max(prev?.l ?? 0, Number(r.loadedAt) || 0),
      s: heard(r.collection, id),
      h
    })
    if (byKey.size >= MAX_SNAPSHOT_RECORDS) break
  }
  return { v: 1, path, at: now, records: [...byKey.values()] }
}

/** Pure: may a stored snapshot be compared on this page load? */
export function usableSnapshot(raw: string | null, path: string, now: number): Snapshot | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as Snapshot
    if (s?.v !== 1 || s.path !== path || typeof s.at !== 'number') return null
    if (now - s.at > SNAPSHOT_MAX_AGE_MS || now < s.at - 5000) return null
    return Array.isArray(s.records) ? s : null
  } catch {
    return null
  }
}

/**
 * Pure: compare a snapshot with fresh records. `reloadAt` = when the page went (the snapshot
 * time). Records not shown fresh are not compared.
 */
export function compareSnapshot(snap: Snapshot, fresh: ShownRecord[]): CompareResult {
  const old = new Map(snap.records.map((r) => [`${r.c}\u0000${r.id}`, r]))
  const done = new Set<string>()
  const missed: MissedRecord[] = []
  let compared = 0
  for (const r of fresh) {
    if (!r?.values) continue
    const key = `${r.collection}\u0000${String(r.id)}`
    const was = old.get(key)
    if (!was || done.has(key)) continue
    done.add(key)
    compared++
    // Heard about it after loading it: the tab knew (whatever the screen then did with it).
    if (was.s != null && was.s >= was.l) continue
    // Loaded just before the reload: a change may still have been on its way.
    if (!(was.l > 0) || snap.at - was.l < IN_FLIGHT_MS) continue
    const fields: string[] = []
    for (const [f, h] of Object.entries(was.h)) {
      if (!(f in r.values)) continue
      if (hashValue(r.values[f]) !== h) fields.push(f)
    }
    if (fields.length === 0) continue
    missed.push({
      collection: r.collection,
      id: String(r.id),
      fields: fields.slice(0, MAX_SNAPSHOT_FIELDS),
      gap_s: Math.max(0, Math.round((snap.at - was.l) / 1000))
    })
  }
  return { compared, missed }
}

/** Pure: did this page load come from the browser's Reload? */
export function isReloadNavigation(entry: { type?: string } | undefined | null): boolean {
  return entry?.type === 'reload'
}

/** Pure: may this tab send another beacon (times = recent sends, ms)? */
export function beaconAllowed(times: number[], now: number, perHour = BEACONS_PER_HOUR): boolean {
  return times.filter((t) => now - t < 3_600_000).length < perHour
}

// ─── Screens: which records they show ────────────────────────────────────────

type Getter = () => ShownRecord[]
const getters = new Map<number, Getter>()
let nextGetter = 1

export function registerShownRecords(get: Getter): () => void {
  const id = nextGetter++
  getters.set(id, get)
  return () => {
    getters.delete(id)
  }
}

export function shownRecords(): ShownRecord[] {
  const out: ShownRecord[] = []
  for (const g of getters.values()) {
    try {
      for (const r of g()) {
        out.push(r)
        if (out.length >= MAX_SNAPSHOT_RECORDS * 2) return out
      }
    } catch {
      /* a screen that cannot say is left out */
    }
  }
  return out
}

/**
 * A live screen says what it shows (the latest list is read only when the page goes and right
 * after a reload, so this costs nothing per render beyond a ref write).
 */
export function useShownRecords(
  records: ShownRecord[] | null | undefined | (() => ShownRecord[] | null | undefined)
): void {
  const ref = useRef(records)
  ref.current = records
  useEffect(
    () =>
      registerShownRecords(() => {
        const r = ref.current
        return (typeof r === 'function' ? r() : r) ?? []
      }),
    []
  )
}

// ─── The detector (started once, by startRum) ────────────────────────────────

const BEACON_TIMES_KEY = 'nvr-missed-beacons'
let started = false

export interface MissedUpdateBeacon {
  route: string
  /** Seconds between the page going and coming back. */
  reload_s: number
  /** Seconds between the page going and this beacon (the server's clock places the change). */
  went_ago_s: number
  compared: number
  missed: MissedRecord[]
}

export function startMissedUpdateDetector(opts: {
  routePattern: (path: string) => string
  send: (body: MissedUpdateBeacon) => void
}): void {
  if (started || typeof window === 'undefined' || typeof sessionStorage === 'undefined') return
  started = true
  const pathNow = () => `${window.location.pathname}${window.location.search}`
  const pageStart = Date.now()

  window.addEventListener('pagehide', () => {
    try {
      const recs = shownRecords()
      if (recs.length === 0) {
        sessionStorage.removeItem(SNAPSHOT_KEY)
        return
      }
      sessionStorage.setItem(
        SNAPSHOT_KEY,
        JSON.stringify(buildSnapshot(pathNow(), recs, Date.now()))
      )
    } catch {
      /* storage full or off: nothing to compare after the reload */
    }
  })

  let snap: Snapshot | null = null
  try {
    const nav = performance.getEntriesByType?.('navigation')?.[0] as { type?: string } | undefined
    const raw = sessionStorage.getItem(SNAPSHOT_KEY)
    sessionStorage.removeItem(SNAPSHOT_KEY)
    if (isReloadNavigation(nav)) snap = usableSnapshot(raw, pathNow(), pageStart)
  } catch {
    snap = null
  }
  if (!snap || snap.records.length === 0) return
  const s = snap
  const result: CompareResult = { compared: 0, missed: [] }
  const seen = new Set<string>()
  const wanted = new Set(s.records.map((r) => `${r.c}\u0000${r.id}`))
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    if (result.compared === 0) return
    try {
      const now = Date.now()
      const times = JSON.parse(sessionStorage.getItem(BEACON_TIMES_KEY) ?? '[]') as number[]
      const recent = Array.isArray(times) ? times.filter((t) => now - t < 3_600_000) : []
      if (!beaconAllowed(recent, now)) return
      sessionStorage.setItem(BEACON_TIMES_KEY, JSON.stringify([...recent, now]))
    } catch {
      /* storage off: send anyway, the server caps per person */
    }
    opts.send({
      route: opts.routePattern(window.location.pathname).slice(0, 300),
      reload_s: Math.max(0, Math.round((pageStart - s.at) / 1000)),
      went_ago_s: Math.max(0, Math.round((Date.now() - s.at) / 1000)),
      compared: result.compared,
      missed: result.missed.slice(0, MAX_MISSED_PER_BEACON)
    })
  }
  const step = () => {
    // Only data this page load fetched counts as fresh (a restored cache would compare with itself).
    const fresh = shownRecords().filter(
      (r) => r.loadedAt >= pageStart && !seen.has(`${r.collection}\u0000${String(r.id)}`)
    )
    const r = compareSnapshot(s, fresh)
    for (const f of fresh) seen.add(`${f.collection}\u0000${String(f.id)}`)
    result.compared += r.compared
    result.missed.push(...r.missed)
    return [...wanted].every((k) => seen.has(k))
  }
  const delays = [1500, 3000, 6000, 10_000, COMPARE_FOR_MS]
  let i = 0
  const next = () => {
    if (finished) return
    const all = step()
    if (all || i >= delays.length - 1) {
      finish()
      return
    }
    i++
    setTimeout(next, delays[i] - delays[i - 1])
  }
  setTimeout(next, delays[0])
  // A reload abandoned before the comparison ends still reports what it compared.
  window.addEventListener('pagehide', () => {
    if (finished) return
    step()
    finish()
  })
}

export function __resetMissedUpdatesForTests(): void {
  getters.clear()
  started = false
}
