// api/src/services/traffic-taps/storage.ts
/**
 * Topology tap `storage` (#2164): the file storage backend as its own node — every read, write,
 * delete and existence check the storage layer makes (services/storage/instrument.ts wraps the
 * provider and the settings-driven drivers), with the bytes moved, how long the backend took
 * (not the whole request around it) and what failed, per driver (local disk, S3, Azure Blob).
 * A slow or failing backend then reads like a slow database: its own node, latency and errors.
 *
 * A missing object is not a failure: it is counted as `missing`, never as an error.
 * Never in cloud mode (the cloud repo owns file storage there).
 */
import { noteDown } from '../traffic-map.js'
import { registerTrafficTap, tapState } from '../traffic-taps.js'
import { currentEntityKey, LatencySample, MinuteTotals } from './util.js'

export const STORAGE_TAP = 'storage'
export type StorageOp = 'read' | 'write' | 'delete' | 'check' | 'list'
export const STORAGE_OPS: StorageOp[] = ['read', 'write', 'delete', 'check', 'list']
export const STORAGE_LABELS: Record<string, string> = {
  local: 'Local disk',
  s3: 'S3',
  azure: 'Azure Blob'
}
/** A call slower than this counts as slow (large objects over a network take a while). */
export const STORAGE_SLOW_MS = 2000
const MAX_DRIVERS = 6

/** `local` | `s3` | `azure` whatever spelling the two driver layers use. */
export function normalizeDriver(name: string): string {
  const n = String(name).trim().toLowerCase()
  if (n === 's3') return 's3'
  if (n === 'azure' || n === 'azure-blob') return 'azure'
  return 'local'
}

export const storageNodeId = (driver: string): string => `storage:${normalizeDriver(driver)}`

interface LastFailure {
  at: number
  op: StorageOp
  reason: string
}
interface StorageState {
  counts: MinuteTotals
  lat: Map<string, LatencySample>
  last: Map<string, LastFailure>
  /** Slowest call per driver in the retained window (ms). */
  max: Map<string, { ms: number; at: number }>
}
const state = (): StorageState =>
  tapState<StorageState>(STORAGE_TAP, () => ({
    counts: new MinuteTotals(MAX_DRIVERS * STORAGE_OPS.length * 6),
    lat: new Map(),
    last: new Map(),
    max: new Map()
  }))

/** Does this error mean "the object is not there" rather than "the backend is broken"? */
export function isMissingObject(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown }
  if (e?.code === 'ENOENT' || e?.code === 'NoSuchKey' || e?.code === 'BlobNotFound') return true
  if (e?.status === 404 || e?.statusCode === 404) return true
  return /\b404\b|no such (file|key)|not ?found|does not exist/i.test(String(e?.message ?? ''))
}

/** The failure reason shown on the node: the message without the object key, capped. */
export function scrubReason(err: unknown, key?: string): string {
  let msg = err instanceof Error ? err.message : String(err ?? 'failed')
  if (key) msg = msg.split(key).join('…')
  return msg.replace(/\s+/g, ' ').trim().slice(0, 120) || 'failed'
}

export interface StorageCall {
  driver: string
  op: StorageOp
  /** Bytes moved (write: object size; read: bytes returned). */
  bytes?: number
  ms: number
  ok: boolean
  missing?: boolean
  reason?: string
}

/** One storage call. Never throws, O(1). */
export function noteStorageCall(c: StorageCall): void {
  if (process.env.CLOUD_META_DB_URL) return
  try {
    const driver = normalizeDriver(c.driver)
    const at = Date.now()
    const sec = Math.floor(at / 1000)
    const s = state()
    const k = `${driver}|${c.op}`
    s.counts.add(`${k}|n`, sec)
    if (c.missing) s.counts.add(`${k}|missing`, sec)
    else if (!c.ok) s.counts.add(`${k}|failed`, sec)
    if (c.ok && c.bytes && c.bytes > 0) s.counts.add(`${k}|bytes`, sec, c.bytes)
    if (c.ms >= STORAGE_SLOW_MS) s.counts.add(`${k}|slow`, sec)
    let lat = s.lat.get(k)
    if (!lat) {
      lat = new LatencySample(200)
      s.lat.set(k, lat)
    }
    lat.push(c.ms)
    const mx = s.max.get(driver)
    if (!mx || c.ms >= mx.ms || at - mx.at > 900_000) s.max.set(driver, { ms: c.ms, at })
    if (!c.ok && !c.missing)
      s.last.set(driver, { at, op: c.op, reason: (c.reason ?? 'failed').slice(0, 120) })
    noteDown({
      id: storageNodeId(driver),
      label: `Storage · ${STORAGE_LABELS[driver] ?? driver}`,
      kind: 'storage',
      ok: c.ok || !!c.missing,
      ms: c.ms,
      at,
      entityKey: currentEntityKey()
    })
  } catch {
    /* never */
  }
}

export interface StorageOpFigures {
  n: number
  failed: number
  missing: number
  slow: number
  bytes: number
  p50_ms: number
  p95_ms: number
}
export interface StorageDriverFigures {
  label: string
  ops: Partial<Record<StorageOp, StorageOpFigures>>
  max_ms: number
  last_failure: LastFailure | null
}
export interface StorageSnapshot {
  slow_ms: number
  drivers: Record<string, StorageDriverFigures>
}

export function storageSnapshot(windowS: number, sec: number): StorageSnapshot | undefined {
  const s = state()
  const drivers: Record<string, StorageDriverFigures> = {}
  for (const driver of Object.keys(STORAGE_LABELS)) {
    const ops: StorageDriverFigures['ops'] = {}
    for (const op of STORAGE_OPS) {
      const k = `${driver}|${op}`
      const n = s.counts.sum(`${k}|n`, windowS, sec)
      if (!n) continue
      const lat = s.lat.get(k)
      ops[op] = {
        n,
        failed: s.counts.sum(`${k}|failed`, windowS, sec),
        missing: s.counts.sum(`${k}|missing`, windowS, sec),
        slow: s.counts.sum(`${k}|slow`, windowS, sec),
        bytes: s.counts.sum(`${k}|bytes`, windowS, sec),
        p50_ms: lat?.p(0.5) ?? 0,
        p95_ms: lat?.p(0.95) ?? 0
      }
    }
    if (!Object.keys(ops).length) continue
    const last = s.last.get(driver) ?? null
    drivers[driver] = {
      label: STORAGE_LABELS[driver],
      ops,
      max_ms: Math.round(s.max.get(driver)?.ms ?? 0),
      last_failure: last && last.at >= (sec - windowS) * 1000 ? last : null
    }
  }
  return Object.keys(drivers).length ? { slow_ms: STORAGE_SLOW_MS, drivers } : undefined
}

/** Overall read of one driver for the node's badge: error when any call failed, else warn when
 *  a tenth of the calls were slow. Pure. */
export function storageLevel(d: Pick<StorageDriverFigures, 'ops'>): 'ok' | 'warn' | 'error' {
  let failed = 0
  let slow = 0
  let n = 0
  for (const o of Object.values(d.ops)) {
    if (!o) continue
    failed += o.failed
    slow += o.slow
    n += o.n
  }
  if (failed > 0) return 'error'
  return n > 0 && slow / n >= 0.1 ? 'warn' : 'ok'
}

registerTrafficTap({
  id: STORAGE_TAP,
  snapshot: (windowS, sec) => storageSnapshot(windowS, sec),
  sweep(sec) {
    state().counts.sweep(sec)
  }
})
